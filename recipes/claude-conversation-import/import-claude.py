#!/usr/bin/env python3
"""
Open Brain — Claude Export Importer

Extracts conversations from a Claude data export (zip or extracted directory),
filters trivial ones, summarizes each into adaptively sized distilled thoughts
via LLM, and loads them into your Open Brain instance.

This importer targets the current Anthropic export contract centered on
`conversations.json`. The parser is intentionally tolerant about field names so
we can validate quickly against real exports without rewriting the whole tool.

Usage:
    python import-claude.py path/to/export.zip [options]
    python import-claude.py path/to/extracted-dir/ [options]
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from recipes.shared_docling import local_llm_base_url
from recipes.claim_typing import extract_claims, load_claim_prompt
from recipes.secret_hygiene import sanitize_text, sanitize_thoughts

SYNC_LOG_PATH = Path("claude-sync-log.json")
PROMPT_FILE_PATH = Path(__file__).with_name("prompt.md")
CLAIM_PROMPT_FILE_PATH = REPO_ROOT / "recipes" / "claim-typing" / "prompt.md"

OLLAMA_BASE = "http://localhost:11434"
LOCAL_LLM_MODEL = os.environ.get("LLM_MODEL", "mlx-community/Qwen3.5-397B-A17B-nvfp4")
LOCAL_LLM_ENABLE_THINKING = os.environ.get("LLM_ENABLE_THINKING", "false").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
LOCAL_INGEST_URL = os.environ.get("OPEN_BRAIN_INGEST_URL") or "http://localhost:8787/ingest/thought"
LOCAL_INGEST_KEY = os.environ.get("OPEN_BRAIN_INGEST_KEY") or os.environ.get("MCP_ACCESS_KEY", "")

MIN_TOTAL_MESSAGES = 4
MIN_USER_WORDS = 20
DEFAULT_THOUGHT_LIMIT = 3
MAX_THOUGHT_LIMIT = 7
WORD_BASED_THOUGHT_LIMITS = (
    (6500, 7),
    (4000, 6),
    (2000, 5),
    (900, 4),
)
MESSAGE_BASED_THOUGHT_LIMITS = (
    (36, 6),
    (24, 5),
    (14, 4),
)
SKIP_TITLE_PATTERNS = re.compile(
    r"do not remember|forget this|don't remember|ignore this"
    r"|limerick|haiku|poem |joke |riddle"
    r"|image of|generate.*image|draw |create.*art"
    r"|tooth fairy|santa letter|bedtime stor"
    r"|translate this|what is .{1,15} in \w+",
    re.IGNORECASE,
)

def load_prompt_template(prompt_file=None):
    path = Path(prompt_file) if prompt_file else PROMPT_FILE_PATH
    try:
        template = path.read_text().strip()
    except FileNotFoundError as exc:
        raise FileNotFoundError(f"Prompt file not found: {path}") from exc

    if "{limit}" not in template:
        raise ValueError(f"Prompt file must include a {{limit}} placeholder: {path}")

    return template


def load_sync_log():
    try:
        with open(SYNC_LOG_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"ingested_ids": {}, "last_sync": ""}


def save_sync_log(log):
    with open(SYNC_LOG_PATH, "w") as f:
        json.dump(log, f, indent=2)


try:
    import requests
except ImportError:
    print("Missing dependency: requests")
    print("Install with: pip install requests")
    sys.exit(1)


def http_post_with_retry(url, headers, body, retries=2, timeout=30):
    for attempt in range(retries + 1):
        try:
            resp = requests.post(url, headers=headers, json=body, timeout=timeout)
            if resp.status_code >= 500 and attempt < retries:
                time.sleep(1 * (attempt + 1))
                continue
            return resp
        except requests.RequestException:
            if attempt < retries:
                time.sleep(1 * (attempt + 1))
                continue
            raise
    return None


def extract_json_payload(text):
    trimmed = text.strip()
    trimmed = re.sub(r"^```json\s*", "", trimmed, flags=re.IGNORECASE)
    trimmed = re.sub(r"^```\s*", "", trimmed)
    trimmed = re.sub(r"\s*```$", "", trimmed)

    try:
        return json.loads(trimmed)
    except json.JSONDecodeError:
        start = trimmed.find("{")
        end = trimmed.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise
        return json.loads(trimmed[start : end + 1])


def extract_tool_arguments(response_json, expected_name):
    try:
        tool_calls = response_json["choices"][0]["message"]["tool_calls"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError("Model did not return a tool call") from exc

    if not isinstance(tool_calls, list) or not tool_calls:
        raise ValueError("Model did not return a tool call")

    call = None
    for item in tool_calls:
        if isinstance(item, dict) and item.get("function", {}).get("name") == expected_name:
            call = item
            break
    if call is None:
        call = tool_calls[0]

    arguments = call.get("function", {}).get("arguments")
    if not isinstance(arguments, str) or not arguments.strip():
        raise ValueError("Tool call arguments were empty")

    return extract_json_payload(arguments)


def normalize_thoughts(thoughts, limit=3):
    if isinstance(thoughts, str):
        thoughts = [thoughts]
    elif not isinstance(thoughts, list):
        return []

    normalized = []
    seen = set()
    for item in thoughts:
        if isinstance(item, str):
            stripped = item.strip()
            if stripped.startswith("[") or stripped.startswith("{"):
                parsed = None
                candidates = [stripped]
                if stripped.startswith("[") and "]" in stripped:
                    candidates.append(stripped[: stripped.rfind("]") + 1])
                if stripped.startswith("{") and "}" in stripped:
                    candidates.append(stripped[: stripped.rfind("}") + 1])

                for candidate in candidates:
                    try:
                        parsed = json.loads(candidate)
                        break
                    except json.JSONDecodeError:
                        continue

                if isinstance(parsed, list):
                    for nested in normalize_thoughts(parsed, limit=limit - len(normalized)):
                        if nested in seen:
                            continue
                        seen.add(nested)
                        normalized.append(nested)
                        if len(normalized) >= limit:
                            return normalized
                    continue

                if isinstance(parsed, dict):
                    for nested in normalize_thoughts(parsed.get("thoughts", []), limit=limit - len(normalized)):
                        if nested in seen:
                            continue
                        seen.add(nested)
                        normalized.append(nested)
                        if len(normalized) >= limit:
                            return normalized
                    continue
        else:
            continue

        thought = item.strip()
        if not thought or thought in seen:
            continue
        seen.add(thought)
        normalized.append(thought)
        if len(normalized) >= limit:
            break

    return sanitize_thoughts(normalized, limit=limit)["thoughts"]


def determine_thought_limit(word_count, message_count):
    word_limit = DEFAULT_THOUGHT_LIMIT
    for minimum_words, candidate_limit in WORD_BASED_THOUGHT_LIMITS:
        if word_count >= minimum_words:
            word_limit = candidate_limit
            break

    message_limit = DEFAULT_THOUGHT_LIMIT
    for minimum_messages, candidate_limit in MESSAGE_BASED_THOUGHT_LIMITS:
        if message_count >= minimum_messages:
            message_limit = candidate_limit
            break

    return min(MAX_THOUGHT_LIMIT, max(DEFAULT_THOUGHT_LIMIT, word_limit, message_limit))


def build_thoughts_tool(limit):
    return {
        "type": "function",
        "function": {
            "name": "submit_thoughts",
            "description": "Return extracted durable thoughts from the conversation.",
            "parameters": {
                "type": "object",
                "additionalProperties": False,
                "required": ["thoughts"],
                "properties": {
                    "thoughts": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            f"Up to {limit} durable first-person thoughts worth keeping. "
                            "Return fewer when appropriate."
                        ),
                    }
                },
            },
        },
    }


def build_summarization_prompt(limit, prompt_template=None):
    template = prompt_template if prompt_template is not None else load_prompt_template()
    return template.format(limit=limit)


def summarize_input_limit(thought_limit):
    extra_limit = max(0, thought_limit - DEFAULT_THOUGHT_LIMIT)
    return min(16000, 6000 + (extra_limit * 2500))


def summarize_output_limit(thought_limit):
    return max(500, 220 * thought_limit)


def conversation_list_from_payload(payload):
    if isinstance(payload, list):
        return payload

    if isinstance(payload, dict):
        for key in ("conversations", "data", "items"):
            value = payload.get(key)
            if isinstance(value, list):
                return value

        if payload.get("chat_messages") or payload.get("messages"):
            return [payload]

    return []


def extract_conversations(source_path):
    source = Path(source_path)

    if source.is_dir():
        candidates = sorted(
            path for path in source.rglob("*.json") if path.name in {"conversations.json", "conversation.json"}
        )
        if not candidates:
            print(f"Error: No Claude conversations JSON files found in {source}")
            print("  Expected conversations.json from the Claude export.")
            sys.exit(1)

        all_conversations = []
        for candidate in candidates:
            with candidate.open() as f:
                all_conversations.extend(conversation_list_from_payload(json.load(f)))

        if not all_conversations:
            print("Error: Claude conversation files were found but contained no data.")
            sys.exit(1)

        print(f"  Loaded {len(candidates)} conversation file(s) from directory.")
        return all_conversations

    with zipfile.ZipFile(source, "r") as zf:
        candidates = sorted(
            name
            for name in zf.namelist()
            if Path(name).name in {"conversations.json", "conversation.json"}
        )
        if not candidates:
            print("Error: No Claude conversations JSON files found in zip archive.")
            print("  Expected conversations.json from the Claude export.")
            sys.exit(1)

        all_conversations = []
        for name in candidates:
            with zf.open(name) as f:
                all_conversations.extend(conversation_list_from_payload(json.load(f)))

        if not all_conversations:
            print("Error: Claude conversation files were found but contained no data.")
            sys.exit(1)

        print(f"  Loaded {len(candidates)} conversation file(s) from zip.")
        return all_conversations


def conversation_id(conv):
    return str(
        conv.get("uuid")
        or conv.get("id")
        or conv.get("conversation_uuid")
        or conv.get("chat_uuid")
        or ""
    ).strip()


def conversation_title(conv):
    title = conv.get("name") or conv.get("title") or conv.get("summary") or ""
    return str(title).strip() or "(untitled)"


def parse_timestamp(value):
    if value in (None, "", 0):
        return None

    if isinstance(value, (int, float)):
        numeric = float(value)
        if numeric > 10_000_000_000:
            numeric /= 1000.0
        try:
            return datetime.fromtimestamp(numeric, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None

    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None

        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"

        for candidate in (raw, raw.replace(" ", "T")):
            try:
                dt = datetime.fromisoformat(candidate)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt.astimezone(timezone.utc)
            except ValueError:
                continue

        if raw.isdigit():
            return parse_timestamp(int(raw))

    return None


def conversation_created_at(conv):
    for key in ("created_at", "createdAt", "create_time", "created_time", "updated_at"):
        dt = parse_timestamp(conv.get(key))
        if dt is not None:
            return dt
    return None


def message_sort_key(message):
    for key in ("created_at", "createdAt", "updated_at", "updatedAt", "timestamp"):
        dt = parse_timestamp(message.get(key))
        if dt is not None:
            return dt.timestamp()
    return float("inf")


def extract_messages(conv):
    for key in ("chat_messages", "messages"):
        messages = conv.get(key)
        if isinstance(messages, list):
            return sorted([msg for msg in messages if isinstance(msg, dict)], key=message_sort_key)

    nested = conv.get("conversation")
    if isinstance(nested, dict):
        for key in ("chat_messages", "messages"):
            messages = nested.get(key)
            if isinstance(messages, list):
                return sorted([msg for msg in messages if isinstance(msg, dict)], key=message_sort_key)

    return []


def normalize_role(value):
    if not value:
        return None
    lowered = str(value).strip().lower()
    if lowered in {"human", "user", "customer"}:
        return "user"
    if lowered in {"assistant", "claude", "model", "ai"}:
        return "assistant"
    return lowered


def message_role(message):
    for candidate in (
        message.get("sender"),
        message.get("role"),
        (message.get("author") or {}).get("role") if isinstance(message.get("author"), dict) else message.get("author"),
        message.get("from"),
    ):
        normalized = normalize_role(candidate)
        if normalized in {"user", "assistant"}:
            return normalized
    return None


def flatten_text(value):
    fragments = []

    if isinstance(value, str):
        text = value.strip()
        if text:
            fragments.append(text)
        return fragments

    if isinstance(value, list):
        for item in value:
            fragments.extend(flatten_text(item))
        return fragments

    if isinstance(value, dict):
        text_like_keys = (
            "text",
            "content",
            "value",
            "body",
            "message",
            "completion",
            "caption",
        )
        for key in text_like_keys:
            if key in value:
                fragments.extend(flatten_text(value[key]))
        return fragments

    return fragments


def extract_attachment_names(message):
    names = []
    for key in ("attachments", "files", "file_references"):
        value = message.get(key)
        if not isinstance(value, list):
            continue
        for item in value:
            if isinstance(item, str):
                candidate = item.strip()
            elif isinstance(item, dict):
                candidate = (
                    item.get("file_name")
                    or item.get("filename")
                    or item.get("name")
                    or item.get("title")
                    or item.get("id")
                )
            else:
                candidate = None
            if candidate:
                names.append(str(candidate).strip())
    return [name for name in names if name]


def extract_message_text(message, include_attachment_labels=False):
    fragments = []

    if include_attachment_labels:
        attachment_names = extract_attachment_names(message)
        if attachment_names:
            fragments.append(f"Attachments: {', '.join(attachment_names)}")

    for key in ("text", "content", "message", "body", "completion"):
        if key in message:
            fragments.extend(flatten_text(message.get(key)))

    unique = []
    seen = set()
    for fragment in fragments:
        cleaned = fragment.strip()
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        unique.append(cleaned)

    return "\n".join(unique).strip()


def extract_user_text(messages):
    parts = []
    for message in messages:
        if message_role(message) != "user":
            continue
        text = extract_message_text(message, include_attachment_labels=True)
        if text:
            parts.append(text)
    return "\n---\n".join(parts)


def count_messages(messages):
    count = 0
    for message in messages:
        role = message_role(message)
        if role not in {"user", "assistant"}:
            continue
        text = extract_message_text(message, include_attachment_labels=(role == "user"))
        if text:
            count += 1
    return count


def should_skip(conv, user_text, message_count, sync_log, args):
    conv_id = conversation_hash(conv)

    if conv_id in sync_log["ingested_ids"]:
        return "already_imported"

    conv_date = conversation_created_at(conv)
    if conv_date:
        if args.after and conv_date.date() < args.after:
            return "before_date_filter"
        if args.before and conv_date.date() > args.before:
            return "after_date_filter"

    title = conversation_title(conv)
    if message_count < MIN_TOTAL_MESSAGES:
        return "too_few_messages"
    if SKIP_TITLE_PATTERNS.search(title):
        return "skip_title"
    if len(user_text.split()) < MIN_USER_WORDS:
        return "too_little_text"
    return None


def summarize_local(title, date_str, user_text, thought_limit, prompt_template=None):
    truncated = user_text[: summarize_input_limit(thought_limit)]

    resp = http_post_with_retry(
        f"{local_llm_base_url()}/chat/completions",
        headers={"Content-Type": "application/json"},
        body={
            "model": LOCAL_LLM_MODEL,
            "temperature": 0,
            "max_tokens": summarize_output_limit(thought_limit),
            "chat_template_kwargs": {
                "enable_thinking": LOCAL_LLM_ENABLE_THINKING,
            },
            "tools": [build_thoughts_tool(thought_limit)],
            "tool_choice": "required",
            "messages": [
                {"role": "system", "content": build_summarization_prompt(thought_limit, prompt_template)},
                {
                    "role": "user",
                    "content": f"Conversation title: {title}\nDate: {date_str}\n\nUser messages:\n{truncated}",
                },
            ],
        },
        timeout=180,
    )

    if not resp or resp.status_code != 200:
        status = resp.status_code if resp else "no response"
        print(f"   Warning: Local summarization failed ({status}), skipping conversation.")
        return []

    try:
        data = resp.json()
        result = extract_tool_arguments(data, "submit_thoughts")
        return normalize_thoughts(result.get("thoughts", []), limit=thought_limit)
    except (KeyError, json.JSONDecodeError, IndexError, ValueError) as exc:
        print(f"   Warning: Failed to parse local summarization response: {exc}")
        return []


def summarize_ollama(title, date_str, user_text, thought_limit, model_name="qwen3", prompt_template=None):
    truncated = user_text[: summarize_input_limit(thought_limit)]
    prompt = (
        f"{build_summarization_prompt(thought_limit, prompt_template)}\n\n"
        f"Conversation title: {title}\nDate: {date_str}\n\n"
        f"User messages:\n{truncated}"
    )

    try:
        resp = requests.post(
            f"{OLLAMA_BASE}/api/generate",
            json={
                "model": model_name,
                "prompt": prompt,
                "stream": False,
                "format": "json",
            },
            timeout=120,
        )
    except requests.RequestException as exc:
        print(f"   Warning: Ollama request failed: {exc}")
        return []

    if resp.status_code != 200:
        print(f"   Warning: Ollama returned {resp.status_code}")
        return []

    try:
        raw = resp.json().get("response", "")
        result = json.loads(raw)
        return normalize_thoughts(result.get("thoughts", []), limit=thought_limit)
    except (json.JSONDecodeError, KeyError) as exc:
        print(f"   Warning: Failed to parse Ollama response: {exc}")
        return []


def summarize(title, date_str, user_text, thought_limit, args):
    if args.model == "local":
        return summarize_local(title, date_str, user_text, thought_limit, args.prompt_template)
    if args.model == "ollama":
        return summarize_ollama(title, date_str, user_text, thought_limit, args.ollama_model, args.prompt_template)
    raise ValueError(f"Unsupported model backend: {args.model}")


def ingest_thought_local(content, metadata_dict, occurred_at=None):
    resp = http_post_with_retry(
        LOCAL_INGEST_URL,
        headers={
            "Content-Type": "application/json",
            "x-access-key": LOCAL_INGEST_KEY,
            "x-ingest-key": LOCAL_INGEST_KEY,
        },
        body={
            "content": content,
            "metadata": metadata_dict,
            "source": "claude",
            "type": metadata_dict.get("type"),
            "tags": metadata_dict.get("topics", []),
            "occurred_at": occurred_at,
        },
        timeout=180,
    )

    if not resp:
        return {"ok": False, "error": "No response from local Open Brain"}

    try:
        payload = resp.json()
    except ValueError:
        payload = None

    if resp.status_code not in (200, 201):
        return {
            "ok": False,
            "error": payload or f"HTTP {resp.status_code}: {resp.text}",
        }

    return {"ok": True, "result": payload}


def conversation_hash(conv):
    external_id = conversation_id(conv)
    if external_id:
        raw = external_id
    else:
        created = conversation_created_at(conv)
        raw = f"{conversation_title(conv)}|{created.isoformat() if created else ''}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def parse_date(raw):
    try:
        return datetime.strptime(raw, "%Y-%m-%d").date()
    except ValueError:
        print(f"Error: Invalid date format '{raw}'. Use YYYY-MM-DD.")
        sys.exit(1)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Import Claude conversations into Open Brain",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Examples:
  python import-claude.py export.zip --dry-run --limit 10
  python import-claude.py export.zip --after 2025-01-01
  python import-claude.py export.zip --model local
  python import-claude.py export.zip --raw --limit 50""",
    )
    parser.add_argument("export_path", help="Path to Claude data export zip file or extracted directory")
    parser.add_argument("--dry-run", action="store_true", help="Parse and summarize but don't ingest")
    parser.add_argument("--after", type=parse_date, help="Only conversations after YYYY-MM-DD")
    parser.add_argument("--before", type=parse_date, help="Only conversations before YYYY-MM-DD")
    parser.add_argument("--limit", type=int, default=0, help="Max conversations to process (0 = unlimited)")
    parser.add_argument(
        "--model",
        choices=["local", "ollama"],
        default="local",
        help="LLM backend (default: local)",
    )
    parser.add_argument("--ollama-model", default="qwen3", help="Ollama model name (default: qwen3)")
    parser.add_argument("--raw", action="store_true", help="Skip summarization and ingest the user text directly")
    parser.add_argument("--verbose", action="store_true", help="Show full summaries during processing")
    parser.add_argument("--report", type=str, metavar="FILE", help="Write a markdown report of everything imported")
    parser.add_argument("--prompt-file", default=str(PROMPT_FILE_PATH), help="Prompt template file (default: prompt.md)")
    parser.add_argument(
        "--claim-prompt-file",
        default=str(CLAIM_PROMPT_FILE_PATH),
        help="Claim typing prompt file (default: recipes/claim-typing/prompt.md)",
    )
    return parser.parse_args()


def write_report(filepath, entries, stats):
    with open(filepath, "w") as f:
        mode = "DRY RUN" if stats["dry_run"] else "LIVE"
        f.write(f"# Claude Import Report ({mode})\n\n")
        f.write(f"Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n\n")
        f.write("## Stats\n\n")
        f.write("| Metric | Value |\n|--------|-------|\n")
        f.write(f"| Conversations found | {stats['total']} |\n")
        f.write(f"| Already imported | {stats['already_imported']} |\n")
        f.write(f"| Filtered (trivial) | {stats['filtered']} |\n")
        f.write(f"| Processed | {stats['processed']} |\n")
        f.write(f"| Thoughts generated | {stats['thoughts_generated']} |\n")
        if not stats["dry_run"]:
            f.write(f"| Ingested | {stats['ingested']} |\n")
            f.write(f"| Errors | {stats['errors']} |\n")
        f.write(f"| Total user words | {stats['total_user_words']:,} |\n\n")

        f.write("## Conversations\n\n")
        for entry in entries:
            f.write(f"### {entry['title']} ({entry['date']})\n\n")
            f.write(
                f"_{entry['messages']} messages, {entry['user_words']} user words, "
                f"adaptive cap {entry['thought_limit']}_\n\n"
            )
            for index, thought in enumerate(entry["thoughts"], 1):
                f.write(f"{index}. {thought}\n")
            f.write("\n")

    print(f"\nReport written to {filepath}")


def main():
    args = parse_args()
    args.prompt_template = None if args.raw else load_prompt_template(args.prompt_file)
    args.claim_prompt_template = None if args.raw else load_claim_prompt(args.claim_prompt_file)

    if not os.path.isfile(args.export_path) and not os.path.isdir(args.export_path):
        print(f"Error: Path not found: {args.export_path}")
        sys.exit(1)

    if not args.dry_run:
        if not LOCAL_INGEST_URL:
            print("Error: OPEN_BRAIN_INGEST_URL is not set.")
            sys.exit(1)
        if not LOCAL_INGEST_KEY:
            print("Error: OPEN_BRAIN_INGEST_KEY or MCP_ACCESS_KEY is not set.")
            sys.exit(1)

    print(f"\nExtracting conversations from {args.export_path}...")
    conversations = extract_conversations(args.export_path)
    print(f"Found {len(conversations)} conversations.\n")

    conversations.sort(key=lambda conv: (conversation_created_at(conv) or datetime.min.replace(tzinfo=timezone.utc)))
    sync_log = load_sync_log()

    mode = "DRY RUN" if args.dry_run else "LIVE"
    summarize_mode = "raw (no summarization)" if args.raw else args.model
    if args.model == "local" and not args.raw:
        summarize_mode += f" ({LOCAL_LLM_MODEL})"
    if args.model == "ollama" and not args.raw:
        summarize_mode += f" ({args.ollama_model})"

    print(f"  Mode:        {mode}")
    if not args.dry_run:
        print(f"  Ingestion:   local endpoint ({LOCAL_INGEST_URL})")
    print(f"  Summarizer:  {summarize_mode}")
    if args.after:
        print(f"  After:       {args.after}")
    if args.before:
        print(f"  Before:      {args.before}")
    if args.limit:
        print(f"  Limit:       {args.limit}")
    print()

    total = len(conversations)
    already_imported = 0
    filtered = 0
    filter_reasons = {}
    processed = 0
    thoughts_generated = 0
    ingested = 0
    errors = 0
    total_user_words = 0
    report_entries = []

    for conv in conversations:
        if args.limit and processed >= args.limit:
            break

        messages = extract_messages(conv)
        user_text = extract_user_text(messages)
        message_count = count_messages(messages)

        skip_reason = should_skip(conv, user_text, message_count, sync_log, args)
        if skip_reason:
            if skip_reason == "already_imported":
                already_imported += 1
            else:
                filtered += 1
                filter_reasons[skip_reason] = filter_reasons.get(skip_reason, 0) + 1
            continue

        processed += 1
        word_count = len(user_text.split())
        total_user_words += word_count

        title = conversation_title(conv)
        created_at = conversation_created_at(conv)
        date_str = created_at.strftime("%Y-%m-%d") if created_at else "unknown"
        conv_id = conversation_hash(conv)
        external_id = conversation_id(conv)
        thought_limit = determine_thought_limit(word_count, message_count)

        print(f"{processed}. {title}")
        identifier_display = external_id or "no id"
        print(
            f"   {message_count} messages | {word_count} user words | "
            f"up to {thought_limit} thoughts | {date_str} | {identifier_display}"
        )

        raw_title = title
        raw_text = user_text
        title = sanitize_text(raw_title)["text"]
        sanitized_full_text = sanitize_text(raw_text)
        sanitized_raw = sanitize_thoughts([raw_text], limit=1)
        thoughts = sanitized_raw["thoughts"] if args.raw else summarize(title, date_str, raw_text, thought_limit, args)
        thoughts_generated += len(thoughts)

        if not thoughts:
            print("   -> No thoughts extracted (empty summary)")
            if not args.dry_run:
                sync_log["ingested_ids"][conv_id] = datetime.now(timezone.utc).isoformat()
                save_sync_log(sync_log)
            print()
            continue

        if args.verbose or args.dry_run:
            for index, thought in enumerate(thoughts, 1):
                preview = thought if len(thought) <= 200 else thought[:200] + "..."
                print(f"   Thought {index}: {preview}")

        claim_patches = [{} for _ in thoughts]
        if thoughts and not args.raw:
            try:
                claim_patches = extract_claims(
                    "claude",
                    title,
                    date_str,
                    sanitized_full_text["text"],
                    thoughts,
                    model_backend=args.model,
                    ollama_model=args.ollama_model,
                    prompt_template=args.claim_prompt_template,
                )
                if args.verbose or args.dry_run:
                    for index, patch in enumerate(claim_patches, 1):
                        claim_kind = patch.get("claim_kind")
                        epistemic_status = patch.get("epistemic_status")
                        if claim_kind and epistemic_status:
                            print(f"   Claim {index}: {claim_kind} / {epistemic_status}")
            except Exception as exc:
                claim_patches = [{} for _ in thoughts]
                print(f"   Warning: Claim typing failed: {exc}")

        if args.report:
            report_entries.append(
                {
                    "title": title,
                    "date": date_str,
                    "messages": message_count,
                    "user_words": word_count,
                    "thought_limit": thought_limit,
                    "thoughts": thoughts,
                }
            )

        if args.dry_run:
            print()
            continue

        all_ok = True
        for index, thought in enumerate(thoughts, 1):
            content = f"[Claude: {title} | {date_str}] {thought}"
            extra_metadata = {
                "claude_title": title,
                "claude_create_time": date_str,
                "claude_conversation_hash": conv_id,
                "claude_conversation_id": external_id,
                "claude_thought_limit": thought_limit,
                "claude_thought_count": len(thoughts),
                "claude_message_count": message_count,
                "claude_user_word_count": word_count,
                "full_text": sanitized_full_text["text"],
                "type": "claude_conversation",
                "topics": ["claude", "import"],
            }
            thought_hygiene = sanitize_text(thought)
            total_redactions = sanitized_full_text["redaction_count"] + thought_hygiene["redaction_count"]
            total_rules = sorted(set(sanitized_full_text["rules"]) | set(thought_hygiene["rules"]))
            if total_redactions:
                extra_metadata["secret_hygiene_redaction_count"] = total_redactions
                extra_metadata["secret_hygiene_rules"] = total_rules
            extra_metadata.update(claim_patches[index - 1] if index - 1 < len(claim_patches) else {})
            result = ingest_thought_local(content, extra_metadata, occurred_at=date_str)

            if result.get("ok"):
                ingested += 1
                print(f"   -> Thought {index} ingested")
            else:
                errors += 1
                all_ok = False
                print(f"   -> ERROR (thought {index}): {result.get('error', 'unknown')}")

            time.sleep(0.2)

        if all_ok:
            sync_log["ingested_ids"][conv_id] = datetime.now(timezone.utc).isoformat()
            save_sync_log(sync_log)

        print()

    print("─" * 60)
    print("Summary:")
    print(f"  Conversations found:    {total}")
    if already_imported > 0:
        print(f"  Already imported:       {already_imported} (skipped)")
    if filtered > 0:
        reasons = ", ".join(f"{value} {key}" for key, value in sorted(filter_reasons.items(), key=lambda item: -item[1]))
        print(f"  Filtered (trivial):     {filtered} ({reasons})")
    print(f"  Processed:              {processed}")
    print(f"  Total user words:       {total_user_words:,}")
    print(f"  Thoughts generated:     {thoughts_generated}")
    if not args.dry_run:
        print(f"  Ingested:               {ingested}")
        print(f"  Errors:                 {errors}")
    print("  Est. external API cost: $0.0000")
    print("─" * 60)

    if args.report and report_entries:
        write_report(
            args.report,
            report_entries,
            {
                "total": total,
                "already_imported": already_imported,
                "filtered": filtered,
                "processed": processed,
                "thoughts_generated": thoughts_generated,
                "ingested": ingested,
                "errors": errors,
                "total_user_words": total_user_words,
                "dry_run": args.dry_run,
            },
        )


if __name__ == "__main__":
    main()
