#!/usr/bin/env python3
import argparse
import importlib.util
import json
import os
import sys
from hashlib import sha256
from pathlib import Path

import requests


REPO_ROOT = Path(__file__).resolve().parents[1]
CHATGPT_IMPORTER_PATH = REPO_ROOT / "recipes" / "chatgpt-conversation-import" / "import-chatgpt.py"
CLAUDE_IMPORTER_PATH = REPO_ROOT / "recipes" / "claude-conversation-import" / "import-claude.py"

DEFAULT_BASE_URL = os.environ.get("OPEN_BRAIN_BASE_URL") or f"http://127.0.0.1:{os.environ.get('OPEN_BRAIN_PORT', '8787')}"
DEFAULT_ACCESS_KEY = os.environ.get("MCP_ACCESS_KEY") or os.environ.get("OPEN_BRAIN_ACCESS_KEY") or ""


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CHATGPT = load_module("ob1_chatgpt_importer", CHATGPT_IMPORTER_PATH)
CLAUDE = load_module("ob1_claude_importer", CLAUDE_IMPORTER_PATH)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Ingest canonical raw ChatGPT/Claude export records plus normalized transcript source rows, without rerunning thought extraction."
    )
    parser.add_argument("--chatgpt-export", help="Path to the ChatGPT export zip or extracted directory")
    parser.add_argument("--claude-export", help="Path to the Claude export zip or extracted directory")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="Open Brain local runtime base URL")
    parser.add_argument("--access-key", default=DEFAULT_ACCESS_KEY, help="Open Brain ingest access key")
    parser.add_argument("--limit", type=int, default=0, help="Optional max conversations per source")
    parser.add_argument("--dry-run", action="store_true", help="Parse and report without ingesting")
    parser.add_argument("--verbose", action="store_true", help="Print per-conversation progress")
    args = parser.parse_args()

    if not args.chatgpt_export and not args.claude_export:
        parser.error("At least one of --chatgpt-export or --claude-export is required.")
    if not args.dry_run and not args.access_key:
        parser.error("Missing access key. Set MCP_ACCESS_KEY or pass --access-key.")
    return args


def normalize_base_url(value):
    return value.rstrip("/")


def occurred_at_string(dt):
    return dt.strftime("%Y-%m-%d") if dt else None


def stable_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def pretty_json(value):
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)


def text_hash(value):
    return sha256(value.encode("utf-8")).hexdigest()


def post_ingest(base_url, access_key, payload):
    response = requests.post(
        f"{base_url}/ingest/thought",
        headers={
            "Content-Type": "application/json",
            "x-access-key": access_key,
            "x-ingest-key": access_key,
        },
        json=payload,
        timeout=300,
    )
    body_text = response.text
    try:
        body = response.json()
    except ValueError:
        body = {"raw_response": body_text}

    if response.status_code not in (200, 201):
        raise RuntimeError(f"{response.status_code} {response.reason}: {body_text}")
    return body


def record_descriptor(platform, title, date_str, conversation_id, conversation_hash):
    identifier = conversation_id or conversation_hash
    safe_title = title or "(untitled)"
    safe_date = date_str or "unknown"
    return (
        f"[{platform} Export Record: {safe_title} | {safe_date}] "
        f"Canonical raw export record for conversation {identifier}."
    )


def join_sections(parts):
    cleaned = [part.strip() for part in parts if isinstance(part, str) and part.strip()]
    return "\n---\n".join(cleaned)


def chatgpt_messages(conv):
    return CHATGPT.walk_messages(conv.get("mapping") or {})


def chatgpt_transcript(messages):
    parts = []
    for message in messages:
        role = (message.get("author") or {}).get("role")
        if role not in {"user", "assistant"}:
            continue
        text = CHATGPT.extract_message_text(message, include_attachment_labels=(role == "user"))
        if text:
            parts.append(f"{role.capitalize()}:\n{text}")
    return join_sections(parts)


def claude_messages(conv):
    return CLAUDE.extract_messages(conv)


def claude_transcript(messages):
    parts = []
    for message in messages:
        role = CLAUDE.message_role(message)
        if role not in {"user", "assistant"}:
            continue
        text = CLAUDE.extract_message_text(message, include_attachment_labels=(role == "user"))
        if text:
            parts.append(f"{role.capitalize()}:\n{text}")
    return join_sections(parts)


def chatgpt_build_items(conv):
    messages = chatgpt_messages(conv)
    transcript = chatgpt_transcript(messages)
    user_text = CHATGPT.extract_user_text(messages)
    title = CHATGPT.conversation_title(conv)
    created_at = CHATGPT.conversation_created_at(conv)
    date_str = occurred_at_string(created_at)
    conversation_hash = CHATGPT.conversation_hash(conv)
    conversation_id = CHATGPT.conversation_id(conv)
    message_count = CHATGPT.count_messages(messages)
    raw_json = pretty_json(conv)
    raw_json_hash = text_hash(stable_json(conv))

    common = {
        "chatgpt_title": title,
        "chatgpt_create_time": date_str,
        "chatgpt_conversation_hash": conversation_hash,
        "chatgpt_conversation_id": conversation_id,
        "chatgpt_conversation_url": f"https://chatgpt.com/c/{conversation_id}" if conversation_id else None,
        "chatgpt_message_count": message_count,
        "chatgpt_user_word_count": len(user_text.split()),
    }

    items = [
        {
            "kind": "raw_record",
            "dedupe_key": f"chatgpt:conversation_record:{conversation_hash}",
            "payload": {
                "content": record_descriptor("ChatGPT", title, date_str, conversation_id, conversation_hash),
                "metadata": {
                    "source": "chatgpt",
                    "type": "chatgpt_conversation_record",
                    "retrieval_role": "source",
                    "summary": title,
                    "topics": ["chatgpt", "conversation", "record"],
                    "source_record_origin": "chatgpt_export_direct",
                    "content_format": "chatgpt_export_json",
                    "raw_json_sha256": raw_json_hash,
                    "raw_export_json": raw_json,
                    "normalized_transcript_available": bool(transcript),
                    **common,
                },
                "source": "chatgpt",
                "type": "chatgpt_conversation_record",
                "tags": ["chatgpt", "conversation", "record"],
                "occurred_at": date_str,
                "dedupe_key": f"chatgpt:conversation_record:{conversation_hash}",
                "extract_metadata": False,
            },
        }
    ]

    if transcript:
        items.append(
            {
                "kind": "transcript_source",
                "dedupe_key": f"chatgpt:conversation_source:{conversation_hash}",
                "payload": {
                    "content": transcript,
                    "metadata": {
                        "source": "chatgpt",
                        "type": "chatgpt_conversation_source",
                        "retrieval_role": "source",
                        "summary": title,
                        "topics": ["chatgpt", "conversation", "source"],
                        "source_record_origin": "chatgpt_export_direct",
                        "content_format": "normalized_visible_transcript",
                        "full_text": transcript,
                        "user_text": user_text,
                        "source_record_dedupe_key": f"chatgpt:conversation_record:{conversation_hash}",
                        **common,
                    },
                    "source": "chatgpt",
                    "type": "chatgpt_conversation_source",
                    "tags": ["chatgpt", "conversation", "source"],
                    "occurred_at": date_str,
                    "dedupe_key": f"chatgpt:conversation_source:{conversation_hash}",
                    "extract_metadata": False,
                },
            }
        )

    return {
        "label": title,
        "conversation_hash": conversation_hash,
        "items": items,
    }


def claude_build_items(conv):
    messages = claude_messages(conv)
    transcript = claude_transcript(messages)
    user_text = CLAUDE.extract_user_text(messages)
    title = CLAUDE.conversation_title(conv)
    created_at = CLAUDE.conversation_created_at(conv)
    date_str = occurred_at_string(created_at)
    conversation_hash = CLAUDE.conversation_hash(conv)
    conversation_id = CLAUDE.conversation_id(conv)
    message_count = CLAUDE.count_messages(messages)
    raw_json = pretty_json(conv)
    raw_json_hash = text_hash(stable_json(conv))

    common = {
        "claude_title": title,
        "claude_create_time": date_str,
        "claude_conversation_hash": conversation_hash,
        "claude_conversation_id": conversation_id,
        "claude_message_count": message_count,
        "claude_user_word_count": len(user_text.split()),
    }

    items = [
        {
            "kind": "raw_record",
            "dedupe_key": f"claude:conversation_record:{conversation_hash}",
            "payload": {
                "content": record_descriptor("Claude", title, date_str, conversation_id, conversation_hash),
                "metadata": {
                    "source": "claude",
                    "type": "claude_conversation_record",
                    "retrieval_role": "source",
                    "summary": title,
                    "topics": ["claude", "conversation", "record"],
                    "source_record_origin": "claude_export_direct",
                    "content_format": "claude_export_json",
                    "raw_json_sha256": raw_json_hash,
                    "raw_export_json": raw_json,
                    "normalized_transcript_available": bool(transcript),
                    **common,
                },
                "source": "claude",
                "type": "claude_conversation_record",
                "tags": ["claude", "conversation", "record"],
                "occurred_at": date_str,
                "dedupe_key": f"claude:conversation_record:{conversation_hash}",
                "extract_metadata": False,
            },
        }
    ]

    if transcript:
        items.append(
            {
                "kind": "transcript_source",
                "dedupe_key": f"claude:conversation_source:{conversation_hash}",
                "payload": {
                    "content": transcript,
                    "metadata": {
                        "source": "claude",
                        "type": "claude_conversation_source",
                        "retrieval_role": "source",
                        "summary": title,
                        "topics": ["claude", "conversation", "source"],
                        "source_record_origin": "claude_export_direct",
                        "content_format": "normalized_visible_transcript",
                        "full_text": transcript,
                        "user_text": user_text,
                        "source_record_dedupe_key": f"claude:conversation_record:{conversation_hash}",
                        **common,
                    },
                    "source": "claude",
                    "type": "claude_conversation_source",
                    "tags": ["claude", "conversation", "source"],
                    "occurred_at": date_str,
                    "dedupe_key": f"claude:conversation_source:{conversation_hash}",
                    "extract_metadata": False,
                },
            }
        )

    return {
        "label": title,
        "conversation_hash": conversation_hash,
        "items": items,
    }


def process_source(name, export_path, build_items, extractor, args):
    print(f"{name}: loading {export_path}")
    conversations = extractor(export_path)
    found = len(conversations)
    raw_records = 0
    transcript_sources = 0
    failed = 0

    for index, conv in enumerate(conversations, 1):
        if args.limit and index > args.limit:
            break

        item_group = build_items(conv)
        if args.verbose:
            print(f"  {index}. {item_group['label']}")

        for item in item_group["items"]:
          if args.dry_run:
              if item["kind"] == "raw_record":
                  raw_records += 1
              else:
                  transcript_sources += 1
              continue

          try:
              post_ingest(normalize_base_url(args.base_url), args.access_key, item["payload"])
              if item["kind"] == "raw_record":
                  raw_records += 1
              else:
                  transcript_sources += 1
          except Exception as exc:
              failed += 1
              print(f"    -> ERROR ({item['kind']}): {exc}")

    return {
        "source": name,
        "found": found,
        "raw_records": raw_records,
        "transcript_sources": transcript_sources,
        "failed": failed,
        "dry_run": args.dry_run,
    }


def main():
    args = parse_args()
    summaries = []

    if args.chatgpt_export:
        summaries.append(process_source(
            "chatgpt",
            args.chatgpt_export,
            chatgpt_build_items,
            CHATGPT.extract_conversations,
            args,
        ))

    if args.claude_export:
        summaries.append(process_source(
            "claude",
            args.claude_export,
            claude_build_items,
            CLAUDE.extract_conversations,
            args,
        ))

    totals = {
        "found": sum(item["found"] for item in summaries),
        "raw_records": sum(item["raw_records"] for item in summaries),
        "transcript_sources": sum(item["transcript_sources"] for item in summaries),
        "failed": sum(item["failed"] for item in summaries),
        "dry_run": args.dry_run,
        "sources": summaries,
    }
    print(json.dumps(totals, indent=2, ensure_ascii=False))
    if totals["failed"] > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
