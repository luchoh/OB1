#!/usr/bin/env python3
"""
Backfill claim typing metadata for existing ChatGPT and Claude thought rows.

This script updates metadata only through the local OB1 admin endpoint and does
not rewrite content or embeddings.
"""

import argparse
import json
import os
import subprocess
import sys
from collections import OrderedDict
from pathlib import Path

try:
    import requests
except ImportError:
    print("Missing dependency: requests")
    print("Install with: pip install requests")
    sys.exit(1)


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from recipes.claim_typing import (
    CLAIM_EXTRACTION_VERSION,
    extract_claims,
    load_claim_prompt,
    strip_thought_prefix,
)


CHAT_TYPES = {
    "chatgpt": {
        "type": "chatgpt_conversation",
        "hash_key": "chatgpt_conversation_hash",
        "title_key": "chatgpt_title",
        "date_key": "chatgpt_create_time",
        "label": "chatgpt",
    },
    "claude": {
        "type": "claude_conversation",
        "hash_key": "claude_conversation_hash",
        "title_key": "claude_title",
        "date_key": "claude_create_time",
        "label": "claude",
    },
}


def psql_command(sql, database_url=None):
    if database_url:
      return ["psql", database_url, "-Atqc", sql]
    return ["psql", "-Atqc", sql]


def run_psql_json_lines(sql, database_url=None):
    command = psql_command(sql, database_url=database_url)
    result = subprocess.run(
        command,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
        env=os.environ.copy(),
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "psql query failed")

    rows = []
    for line in result.stdout.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        rows.append(json.loads(stripped))
    return rows


def fetch_candidate_rows(args):
    type_filters = []
    if args.source in ("all", "chatgpt"):
        type_filters.append("'chatgpt_conversation'")
    if args.source in ("all", "claude"):
        type_filters.append("'claude_conversation'")

    if not type_filters:
        return []

    sql = f"""
      select json_build_object(
        'id', id,
        'content', content,
        'created_at', created_at,
        'metadata', metadata
      )::text
      from thoughts
      where metadata->>'type' in ({", ".join(type_filters)})
        and coalesce(metadata->>'retrieval_role', '') = 'distilled'
      order by
        coalesce(
          metadata->'user_metadata'->>'chatgpt_conversation_hash',
          metadata->'user_metadata'->>'claude_conversation_hash',
          ''
        ),
        created_at asc,
        id asc
    """
    return run_psql_json_lines(sql, database_url=args.database_url)


def conversation_key(row):
    user_metadata = ((row.get("metadata") or {}).get("user_metadata") or {})
    if user_metadata.get("chatgpt_conversation_hash"):
        return "chatgpt", user_metadata["chatgpt_conversation_hash"]
    if user_metadata.get("claude_conversation_hash"):
        return "claude", user_metadata["claude_conversation_hash"]
    return None, None


def group_rows(rows, args):
    groups = OrderedDict()
    for row in rows:
        source_name, conversation_hash = conversation_key(row)
        if not source_name or not conversation_hash:
            continue

        config = CHAT_TYPES[source_name]
        user_metadata = ((row.get("metadata") or {}).get("user_metadata") or {})
        group_id = f"{source_name}:{conversation_hash}"
        entry = groups.setdefault(
            group_id,
            {
                "source_name": config["label"],
                "source_type": source_name,
                "conversation_hash": conversation_hash,
                "title": user_metadata.get(config["title_key"]) or "(untitled)",
                "date_str": user_metadata.get(config["date_key"]) or "unknown",
                "full_text": user_metadata.get("full_text") or "",
                "rows": [],
            },
        )
        entry["rows"].append(row)

    filtered = []
    for group in groups.values():
        if not group["full_text"].strip():
            continue

        already_current = all(
            (((row.get("metadata") or {}).get("user_metadata") or {}).get("claim_extraction_version") == CLAIM_EXTRACTION_VERSION)
            for row in group["rows"]
        )
        if already_current and not args.force:
            continue

        if args.title_contains and args.title_contains.lower() not in group["title"].lower():
            continue
        if args.conversation_hash and args.conversation_hash != group["conversation_hash"]:
            continue

        filtered.append(group)

    if args.conversation_limit:
        filtered = filtered[: args.conversation_limit]
    return filtered


def update_metadata(base_url, access_key, thought_id, patch, dry_run=False):
    if dry_run:
        return {"success": True, "thought_id": thought_id, "dry_run": True}

    response = requests.post(
        f"{base_url.rstrip('/')}/admin/thought/metadata",
        headers={
            "Content-Type": "application/json",
            "x-access-key": access_key,
        },
        json={
            "thought_id": thought_id,
            "metadata_patch": {
                "user_metadata": patch,
            },
        },
        timeout=120,
    )
    if response.status_code != 200:
        raise RuntimeError(response.text.strip() or f"metadata update failed ({response.status_code})")
    return response.json()


def parse_args():
    parser = argparse.ArgumentParser(description="Backfill claim typing metadata for existing chat thoughts.")
    parser.add_argument("--source", choices=["all", "chatgpt", "claude"], default="all")
    parser.add_argument("--model", choices=["local", "ollama"], default="local")
    parser.add_argument("--ollama-model", default="qwen3")
    parser.add_argument("--base-url", default=os.environ.get("OPEN_BRAIN_BASE_URL", "http://localhost:8787"))
    parser.add_argument("--access-key", default=os.environ.get("MCP_ACCESS_KEY") or os.environ.get("OPEN_BRAIN_ACCESS_KEY"))
    parser.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
    parser.add_argument("--conversation-limit", type=int)
    parser.add_argument("--title-contains")
    parser.add_argument("--conversation-hash")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--prompt-file", default=str(REPO_ROOT / "recipes" / "claim-typing" / "prompt.md"))
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args()


def main():
    args = parse_args()
    if not args.access_key and not args.dry_run:
        raise SystemExit("Missing access key. Set MCP_ACCESS_KEY or pass --access-key.")

    prompt_template = load_claim_prompt(args.prompt_file)
    rows = fetch_candidate_rows(args)
    groups = group_rows(rows, args)

    print(f"Found {len(groups)} conversation groups to process.")
    updated = 0
    skipped = 0
    errors = 0

    for index, group in enumerate(groups, 1):
        thoughts = [strip_thought_prefix(row.get("content", "")) for row in group["rows"]]
        try:
            claim_patches = extract_claims(
                group["source_name"],
                group["title"],
                group["date_str"],
                group["full_text"],
                thoughts,
                model_backend=args.model,
                ollama_model=args.ollama_model,
                prompt_template=prompt_template,
            )
        except Exception as exc:
            errors += 1
            print(f"[{index}/{len(groups)}] ERROR {group['source_name']} {group['title']}: {exc}")
            continue

        print(f"[{index}/{len(groups)}] {group['source_name']} | {group['title']} | {len(thoughts)} thoughts")
        for row, patch in zip(group["rows"], claim_patches):
            if not patch:
                skipped += 1
                continue
            if args.verbose:
                print(
                    "  ->",
                    row["id"],
                    patch.get("claim_kind", "none"),
                    patch.get("epistemic_status", "none"),
                )
            try:
                update_metadata(
                    args.base_url,
                    args.access_key,
                    row["id"],
                    patch,
                    dry_run=args.dry_run,
                )
                updated += 1
            except Exception as exc:
                errors += 1
                print(f"  -> ERROR {row['id']}: {exc}")

    print("─" * 60)
    print("Summary:")
    print(f"  Conversation groups: {len(groups)}")
    print(f"  Thought metadata updates: {updated}")
    print(f"  Skipped thought patches: {skipped}")
    print(f"  Errors: {errors}")
    print(f"  Dry run: {args.dry_run}")
    print("─" * 60)


if __name__ == "__main__":
    main()
