"""Database access helpers for thought enrichment.

Reads use asyncpg directly against the OB1 Postgres (Consul-discovered or
PG* env-configured) — read-only, brain-scoped. Writes go through the
MCP /admin/thought/metadata endpoint so they share the same audit/
governance path as production writes.

Connection settings come from environment variables (loaded by the
caller — typically by sourcing .env.open-brain-local before running).
Required: PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD.
Optional: OPEN_BRAIN_DATABASE_URL overrides individual PG* vars.
"""

from __future__ import annotations

import json
import os
from typing import Any

import asyncpg
import httpx


def _resolve_pg_host_port() -> tuple[str, int]:
    """Resolve PGHOST/PGPORT via env, falling back to Consul discovery.

    Mirrors scripts/apply-open-brain-local-migrations.sh: if PGHOST is unset
    or CONSUL_FORCE_DISCOVERY=true, query Consul for the postgresql service.
    """
    host = os.environ.get("PGHOST") or ""
    port_str = os.environ.get("PGPORT") or ""
    force = (os.environ.get("CONSUL_FORCE_DISCOVERY") or "").strip().lower() in {
        "1",
        "true",
        "yes",
    }
    if host and port_str and not force:
        return host, int(port_str)

    consul_addr = os.environ.get("CONSUL_HTTP_ADDR")
    if not consul_addr:
        raise RuntimeError("PGHOST/PGPORT unset and CONSUL_HTTP_ADDR missing")
    service = os.environ.get("CONSUL_POSTGRES_SERVICE", "postgresql")
    headers = {}
    token = os.environ.get("CONSUL_HTTP_TOKEN")
    if token:
        headers["X-Consul-Token"] = token
    response = httpx.get(
        f"{consul_addr.rstrip('/')}/v1/health/service/{service}",
        params={"passing": "true"},
        headers=headers,
        timeout=5.0,
    )
    response.raise_for_status()
    services = response.json()
    if not services:
        raise RuntimeError(f"No passing Consul instances for service '{service}'")
    svc = services[0]["Service"]
    discovered_host = svc.get("Address") or services[0]["Node"]["Address"]
    discovered_port = int(svc["Port"])
    if not host:
        host = discovered_host
    if not port_str:
        port_str = str(discovered_port)
    return host, int(port_str)


def _connect_kwargs() -> dict[str, Any]:
    url = os.environ.get("OPEN_BRAIN_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if url:
        return {"dsn": url}
    host, port = _resolve_pg_host_port()
    return {
        "host": host,
        "port": port,
        "database": os.environ.get("PGDATABASE", "ob1"),
        "user": os.environ.get("PGUSER", "ob1"),
        "password": os.environ["PGPASSWORD"],
    }


async def connect() -> asyncpg.Connection:
    return await asyncpg.connect(**_connect_kwargs())


async def fetch_unenriched(
    conn: asyncpg.Connection,
    *,
    brain_id: str,
    after_id: str | None = None,
    limit: int = 50,
) -> list[asyncpg.Record]:
    """Page through rows where enriched=false, ordered by id ASC.

    Pass `after_id` from the last row of the previous page to continue.
    """
    if after_id is None:
        return await conn.fetch(
            """
            select id, content, source_type, metadata, type, sensitivity_tier
            from thoughts
            where brain_id = $1::uuid
              and (enriched is null or enriched = false)
            order by id asc
            limit $2
            """,
            brain_id,
            limit,
        )
    return await conn.fetch(
        """
        select id, content, source_type, metadata, type, sensitivity_tier
        from thoughts
        where brain_id = $1::uuid
          and (enriched is null or enriched = false)
          and id > $2::uuid
        order by id asc
        limit $3
        """,
        brain_id,
        after_id,
        limit,
    )


async def fetch_by_ids(
    conn: asyncpg.Connection,
    *,
    brain_id: str,
    ids: list[str],
) -> list[asyncpg.Record]:
    if not ids:
        return []
    return await conn.fetch(
        """
        select id, content, source_type, metadata, type, sensitivity_tier
        from thoughts
        where brain_id = $1::uuid
          and id = any($2::uuid[])
        order by id asc
        """,
        brain_id,
        ids,
    )


async def fetch_for_sensitivity(
    conn: asyncpg.Connection,
    *,
    brain_id: str,
    after_id: str | None = None,
    limit: int = 500,
) -> list[asyncpg.Record]:
    """Page through rows whose sensitivity_tier is null/empty/standard.

    Used by backfill_sensitivity.py to scan for upgrade candidates.
    """
    if after_id is None:
        return await conn.fetch(
            """
            select id, content, sensitivity_tier
            from thoughts
            where brain_id = $1::uuid
              and (sensitivity_tier is null or sensitivity_tier = '' or sensitivity_tier = 'standard')
            order by id asc
            limit $2
            """,
            brain_id,
            limit,
        )
    return await conn.fetch(
        """
        select id, content, sensitivity_tier
        from thoughts
        where brain_id = $1::uuid
          and (sensitivity_tier is null or sensitivity_tier = '' or sensitivity_tier = 'standard')
          and id > $2::uuid
        order by id asc
        limit $3
        """,
        brain_id,
        after_id,
        limit,
    )


async def count_enriched(conn: asyncpg.Connection, *, brain_id: str) -> dict[str, int]:
    row = await conn.fetchrow(
        """
        select
          count(*) filter (where enriched = true) as enriched,
          count(*) filter (where enriched is null or enriched = false) as unenriched,
          count(*) as total
        from thoughts
        where brain_id = $1::uuid
        """,
        brain_id,
    )
    if row is None:
        return {"enriched": 0, "unenriched": 0, "total": 0}
    return {"enriched": row["enriched"], "unenriched": row["unenriched"], "total": row["total"]}


class AdminClient:
    """Thin wrapper over POST /admin/thought/metadata.

    The admin endpoint accepts a structured-column patch (added by the
    same commit that introduced this script). One HTTP call patches one
    thought; for bulk runs the caller should run several in parallel via
    asyncio.gather.
    """

    def __init__(self, base_url: str, access_key: str, *, timeout_s: float = 30.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._headers = {
            "Content-Type": "application/json",
            "x-access-key": access_key,
            "x-ingest-key": access_key,
        }
        self._client = httpx.AsyncClient(timeout=timeout_s, headers=self._headers)

    async def __aenter__(self) -> "AdminClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self._client.aclose()

    async def patch(
        self,
        thought_id: str,
        *,
        metadata_patch: dict | None = None,
        type_: str | None = None,
        source_type: str | None = None,
        sensitivity_tier: str | None = None,
        importance: int | None = None,
        quality_score: float | None = None,
        enriched: bool | None = None,
        status: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"thought_id": thought_id}
        if metadata_patch is not None:
            body["metadata_patch"] = metadata_patch
        if type_ is not None:
            body["type"] = type_
        if source_type is not None:
            body["source_type"] = source_type
        if sensitivity_tier is not None:
            body["sensitivity_tier"] = sensitivity_tier
        if importance is not None:
            body["importance"] = importance
        if quality_score is not None:
            body["quality_score"] = quality_score
        if enriched is not None:
            body["enriched"] = enriched
        if status is not None:
            body["status"] = status

        response = await self._client.post(f"{self._base_url}/admin/thought/metadata", json=body)
        if response.status_code >= 400:
            raise RuntimeError(
                f"PATCH {thought_id} failed ({response.status_code}): {response.text[:300]}"
            )
        return response.json()


def record_to_dict(record: asyncpg.Record) -> dict[str, Any]:
    """Coerce an asyncpg Record to a JSON-serializable dict."""
    out = dict(record)
    for key, value in list(out.items()):
        if hasattr(value, "hex"):
            out[key] = str(value)
        elif isinstance(value, str) and key == "metadata":
            try:
                out[key] = json.loads(value)
            except json.JSONDecodeError:
                pass
    return out
