#!/usr/bin/env python3
"""LLM-driven thought enricher.

Reads rows where enriched=false (or null), classifies via DeepSeek-V4-Flash
through mlx-server, and writes back type/importance/source_type/enriched=true
plus an enriched metadata bundle (summary, topics, tags, people, action_items,
confidence, enriched_version, enriched_at, enriched_model).

Reads via asyncpg, writes through the MCP /admin/thought/metadata endpoint.

Ported from upstream recipes/thought-enrichment/enrich-thoughts.mjs.
Differences:
  - Provider is fixed to mlx-server (OpenAI-compatible). No OpenRouter/Anthropic.
  - Brain-scoped via --brain-id.
  - Cursor pagination is by id (UUID > id), no offset mode.
  - State file lives at scripts/thought_enrichment/data/enrichment-state-<brain>.json.

Usage:
  # Dry-run a small sample to eyeball before committing
  python scripts/thought_enrichment/enrich.py --brain-id <uuid> --dry-run --limit 10

  # Apply for real, with concurrency
  python scripts/thought_enrichment/enrich.py --brain-id <uuid> --apply --concurrency 5

  # Show progress (no writes)
  python scripts/thought_enrichment/enrich.py --brain-id <uuid> --status

  # Retry previously failed rows
  python scripts/thought_enrichment/enrich.py --brain-id <uuid> --apply --retry-failed

Env required:
  PG* (or OPEN_BRAIN_DATABASE_URL)
  OPEN_BRAIN_BASE_URL  (e.g. http://[::1]:8787)
  MCP_ACCESS_KEY       (when --apply)
  LLM_BASE_URL         (e.g. https://mlx.lincoln.luchoh.net/v1)
  LLM_MODEL            (default: DeepSeek-V4-Flash-nvfp4)
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.thought_enrichment.lib.db import (
    AdminClient,
    connect,
    count_enriched,
    fetch_by_ids,
    fetch_unenriched,
)
from scripts.thought_enrichment.lib.llm import LLMClient
from scripts.thought_enrichment.lib.state import EnrichmentState


ENRICHED_VERSION = 1
BATCH_SIZE = 50
STATE_DIR = Path(__file__).resolve().parent / "data"


def _utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


async def _classify_one(
    row: dict,
    *,
    llm: LLMClient,
    admin: AdminClient | None,
    dry_run: bool,
) -> dict | None:
    content = row.get("content") or ""
    if not content.strip():
        # Empty-content rows: just mark enriched=true so we stop reconsidering them.
        if not dry_run and admin is not None:
            await admin.patch(str(row["id"]), enriched=True)
        return {"type": "reference", "importance": 1, "detected_source_type": "generic_import"}

    metadata = row.get("metadata") or {}
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except json.JSONDecodeError:
            metadata = {}
    existing_source = (
        row.get("source_type")
        or (metadata.get("source") if isinstance(metadata, dict) else None)
        or ""
    )

    classified = await llm.classify(content, existing_source=existing_source)

    if dry_run:
        print(f"  [DRY] {row['id']}: {json.dumps(classified, ensure_ascii=False)}")
        return classified

    if admin is None:
        raise RuntimeError("admin client required when --apply is set")

    metadata_patch = {
        **(metadata if isinstance(metadata, dict) else {}),
        "type": classified["type"],
        "summary": classified["summary"],
        "topics": classified["topics"],
        "tags": classified["tags"],
        "people": classified["people"],
        "action_items": classified["action_items"],
        "confidence": classified["confidence"],
        "enriched_version": ENRICHED_VERSION,
        "enriched_at": _utc_now_iso(),
        "enriched_model": llm.model,
    }

    await admin.patch(
        str(row["id"]),
        metadata_patch=metadata_patch,
        type_=classified["type"],
        importance=classified["importance"],
        source_type=classified["detected_source_type"],
        enriched=True,
    )
    return classified


async def _process_chunk(
    chunk: list[dict],
    *,
    llm: LLMClient,
    admin: AdminClient | None,
    dry_run: bool,
    state: EnrichmentState,
    on_processed,
) -> tuple[int, int]:
    enriched = 0
    failed = 0

    async def one(row: dict) -> tuple[str, dict | None, BaseException | None]:
        try:
            result = await _classify_one(row, llm=llm, admin=admin, dry_run=dry_run)
            return str(row["id"]), result, None
        except BaseException as exc:
            return str(row["id"]), None, exc

    results = await asyncio.gather(*(one(r) for r in chunk), return_exceptions=False)

    for row, (thought_id, result, exc) in zip(chunk, results):
        on_processed()
        if exc is None:
            enriched += 1
            if not dry_run:
                state.record_success(thought_id)
            label = (result or {}).get("type", "?")
            src = (result or {}).get("detected_source_type", "?")
            imp = (result or {}).get("importance", "?")
            preview = (row.get("content") or "")[:60].replace("\n", " ")
            print(f"  OK   {thought_id}  type={label:13} src={src:22} imp={imp}  '{preview}...'")
        else:
            failed += 1
            if not dry_run:
                state.record_failure(thought_id)
            print(f"  FAIL {thought_id}: {exc}", file=sys.stderr)

    if not dry_run:
        state.save()

    return enriched, failed


async def run_enrich(
    brain_id: str,
    *,
    dry_run: bool,
    limit: int | None,
    concurrency: int,
    retry_failed: bool,
) -> int:
    base_url = os.environ.get("OPEN_BRAIN_BASE_URL", "http://[::1]:8787")
    # OPEN_BRAIN_ENRICHMENT_KEY first: a scoped, non-admin key is sufficient here.
    # /admin/thought/metadata is gated by authorizeWrite (the ADR-0002 role ladder),
    # not by isAdmin — so `editor` on the target brain is all this needs, and it
    # should not be holding the global-admin key once that is withdrawn
    # (docs/adr/0004). MCP_ACCESS_KEY stays as a fallback so today's runs keep working.
    access_key = os.environ.get("OPEN_BRAIN_ENRICHMENT_KEY") or os.environ.get("MCP_ACCESS_KEY")
    if not dry_run and not access_key:
        print("ERROR: OPEN_BRAIN_ENRICHMENT_KEY or MCP_ACCESS_KEY is required when --apply is set", file=sys.stderr)
        return 2

    print(f"Mode: {'DRY RUN' if dry_run else 'APPLY'}{' (retry-failed)' if retry_failed else ''}")
    print(f"Brain: {brain_id}")
    print(f"Concurrency: {concurrency}  Limit: {limit or 'none'}")
    print()

    conn = await connect()
    state = EnrichmentState.for_brain(base_dir=STATE_DIR, brain_id=brain_id)

    async with LLMClient() as llm:
        admin = AdminClient(base_url, access_key or "") if not dry_run else None

        try:
            print(f"LLM model: {llm.model}")
            print()

            total_processed = 0
            total_enriched = 0
            total_failed = 0

            def on_processed() -> None:
                nonlocal total_processed
                total_processed += 1

            if retry_failed:
                failed_ids = state.failed_ids
                if not failed_ids:
                    print("No failed IDs to retry.")
                    return 0
                print(f"Retrying {len(failed_ids)} previously failed thoughts.")
                print()
                for batch_start in range(0, len(failed_ids), BATCH_SIZE):
                    if limit and total_processed >= limit:
                        break
                    slice_end = batch_start + BATCH_SIZE
                    if limit:
                        slice_end = min(slice_end, batch_start + (limit - total_processed))
                    batch_ids = failed_ids[batch_start:slice_end]
                    rows = await fetch_by_ids(conn, brain_id=brain_id, ids=batch_ids)
                    rows = [dict(r) for r in rows]
                    for chunk_start in range(0, len(rows), concurrency):
                        if limit and total_processed >= limit:
                            break
                        chunk = rows[chunk_start : chunk_start + concurrency]
                        enriched, failed = await _process_chunk(
                            chunk,
                            llm=llm,
                            admin=admin,
                            dry_run=dry_run,
                            state=state,
                            on_processed=on_processed,
                        )
                        total_enriched += enriched
                        total_failed += failed
            else:
                after_id: str | None = None
                while True:
                    if limit and total_processed >= limit:
                        break
                    fetch_size = (
                        min(BATCH_SIZE, limit - total_processed) if limit else BATCH_SIZE
                    )
                    rows = await fetch_unenriched(
                        conn, brain_id=brain_id, after_id=after_id, limit=fetch_size
                    )
                    if not rows:
                        print("No more un-enriched thoughts.")
                        break
                    rows = [dict(r) for r in rows]
                    for chunk_start in range(0, len(rows), concurrency):
                        if limit and total_processed >= limit:
                            break
                        chunk = rows[chunk_start : chunk_start + concurrency]
                        enriched, failed = await _process_chunk(
                            chunk,
                            llm=llm,
                            admin=admin,
                            dry_run=dry_run,
                            state=state,
                            on_processed=on_processed,
                        )
                        total_enriched += enriched
                        total_failed += failed
                    after_id = str(rows[-1]["id"])
                    print(
                        f"Progress: processed={total_processed} "
                        f"enriched={total_enriched} failed={total_failed}"
                    )
                    print()
        finally:
            if admin is not None:
                await admin.__aexit__(None, None, None)
            await conn.close()

    print()
    print("=== ENRICHMENT COMPLETE ===")
    print(f"Processed: {total_processed}")
    print(f"Enriched:  {total_enriched}")
    print(f"Failed:    {total_failed}")
    return 0 if total_failed == 0 else 1


async def show_status(brain_id: str) -> int:
    conn = await connect()
    try:
        counts = await count_enriched(conn, brain_id=brain_id)
    finally:
        await conn.close()

    state = EnrichmentState.for_brain(base_dir=STATE_DIR, brain_id=brain_id)
    pct = (counts["enriched"] / counts["total"] * 100.0) if counts["total"] else 0.0

    print("=== Enrichment Status ===")
    print(f"Brain:              {brain_id}")
    print(f"Total thoughts:     {counts['total']:,}")
    print(f"Enriched:           {counts['enriched']:,} ({pct:.1f}%)")
    print(f"Remaining:          {counts['unenriched']:,}")
    print(f"Failed (lifetime):  {state.total_failed}")
    print()
    if state.failed_ids:
        print(f"Failed IDs (last 10): {', '.join(state.failed_ids[-10:])}")
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--brain-id", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--status", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--concurrency", type=int, default=5)
    parser.add_argument("--retry-failed", action="store_true")
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args(sys.argv[1:])
    if args.status:
        rc = asyncio.run(show_status(args.brain_id))
    else:
        rc = asyncio.run(
            run_enrich(
                args.brain_id,
                dry_run=args.dry_run,
                limit=args.limit or None,
                concurrency=max(1, args.concurrency),
                retry_failed=args.retry_failed,
            )
        )
    sys.exit(rc)


if __name__ == "__main__":
    main()
