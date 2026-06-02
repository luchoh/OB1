#!/usr/bin/env python3
"""Backfill sensitivity_tier for existing thoughts.

Pure regex over content — no LLM call. Scans rows whose sensitivity_tier
is null/empty/standard and upgrades to 'personal' or 'restricted' on
pattern hits.

Reads via asyncpg, writes through the MCP /admin/thought/metadata
endpoint so changes flow through the same audited write path as
production traffic.

Usage:
  python -m scripts.thought_enrichment.backfill_sensitivity --brain-id <uuid> --dry-run
  python -m scripts.thought_enrichment.backfill_sensitivity --brain-id <uuid> --apply

Env required: PG* (or OPEN_BRAIN_DATABASE_URL),
              OPEN_BRAIN_BASE_URL (e.g. http://[::1]:8787),
              MCP_ACCESS_KEY.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.thought_enrichment.lib.db import (
    AdminClient,
    connect,
    fetch_for_sensitivity,
)
from scripts.thought_enrichment.lib.sensitivity import detect_sensitivity


BATCH_SIZE = 500


async def run(brain_id: str, *, apply: bool) -> int:
    base_url = os.environ.get("OPEN_BRAIN_BASE_URL", "http://[::1]:8787")
    access_key = os.environ.get("MCP_ACCESS_KEY")
    if apply and not access_key:
        print("ERROR: MCP_ACCESS_KEY is required when --apply is set", file=sys.stderr)
        return 2

    print(f"Mode: {'APPLY (writing changes)' if apply else 'DRY RUN (no changes)'}")
    print(f"Brain: {brain_id}")
    print()

    conn = await connect()
    admin = AdminClient(base_url, access_key or "") if apply else None

    scanned = 0
    upgraded_personal = 0
    upgraded_restricted = 0
    errors = 0
    after_id: str | None = None

    try:
        while True:
            rows = await fetch_for_sensitivity(
                conn, brain_id=brain_id, after_id=after_id, limit=BATCH_SIZE
            )
            if not rows:
                break

            for row in rows:
                scanned += 1
                content = row["content"] or ""
                result = detect_sensitivity(content)

                if result.tier == "standard":
                    continue

                if result.tier == "personal":
                    upgraded_personal += 1
                elif result.tier == "restricted":
                    upgraded_restricted += 1

                preview = content[:80].replace("\n", " ")
                if scanned <= 30 or result.tier == "restricted":
                    print(
                        f"  {result.tier.upper():10} {row['id']}  "
                        f"reasons={','.join(result.reasons)}  '{preview}...'"
                    )

                if apply and admin is not None:
                    try:
                        await admin.patch(str(row["id"]), sensitivity_tier=result.tier)
                    except Exception as exc:
                        errors += 1
                        print(f"  Failed to update {row['id']}: {exc}", file=sys.stderr)

            after_id = str(rows[-1]["id"])
            if scanned % 5000 == 0 or len(rows) < BATCH_SIZE:
                print(
                    f"  ... scanned={scanned} personal={upgraded_personal} "
                    f"restricted={upgraded_restricted}"
                )
            if len(rows) < BATCH_SIZE:
                break
    finally:
        await conn.close()
        if admin is not None:
            await admin.__aexit__(None, None, None)

    print()
    print("=== Results ===")
    print(f"  Scanned:                {scanned}")
    print(f"  Upgraded to personal:   {upgraded_personal}")
    print(f"  Upgraded to restricted: {upgraded_restricted}")
    print(f"  Unchanged:              {scanned - upgraded_personal - upgraded_restricted}")
    print(f"  Errors:                 {errors}")
    print(f"  Mode:                   {'APPLIED' if apply else 'DRY RUN (no changes made)'}")
    return 0 if errors == 0 else 1


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--brain-id", required=True, help="UUID of the brain to scan.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="Scan only; no writes.")
    mode.add_argument("--apply", action="store_true", help="Apply upgrades via MCP admin endpoint.")
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args(sys.argv[1:])
    rc = asyncio.run(run(args.brain_id, apply=args.apply))
    sys.exit(rc)


if __name__ == "__main__":
    main()
