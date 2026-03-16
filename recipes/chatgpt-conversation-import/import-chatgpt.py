#!/usr/bin/env python3
"""
Open Brain — ChatGPT Export Importer

Extracts conversations from a ChatGPT data export (zip or extracted directory),
filters trivial ones, summarizes each into adaptively sized distilled thoughts via LLM,
and loads them into your Open Brain instance.

Supports both single conversations.json and the multi-file format
(conversations-000.json through conversations-NNN.json) used in large exports.
Also preserves text from newer multimodal user turns and includes attachment
filenames as textual context for summarization.

Usage:
    python import-chatgpt.py path/to/export.zip [options]
    python import-chatgpt.py path/to/extracted-dir/ [options]

Ingestion:
    Default:              Local OB1 ingest endpoint

Options:
    --dry-run              Parse, filter, summarize, but don't ingest
    --after YYYY-MM-DD     Only conversations created after this date
    --before YYYY-MM-DD    Only conversations created before this date
    --limit N              Max conversations to process
    --model local          LLM backend: local (default) or ollama
    --ollama-model NAME    Ollama model name (default: qwen3)
    --raw                  Skip summarization, ingest user messages directly
    --verbose              Show full summaries during processing
    --report FILE          Write a markdown report of everything imported
Environment variables:
    LLM_BASE_URL               OpenAI-compatible local LLM endpoint
    LLM_MODEL                  Local LLM model id
    OPEN_BRAIN_INGEST_URL      Local/custom ingest endpoint URL
    OPEN_BRAIN_INGEST_KEY      Local/custom ingest endpoint auth key
    MCP_ACCESS_KEY             Local OB1 access key alias
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

# ─── Configuration ───────────────────────────────────────────────────────────

from recipes.shared_docling import local_llm_base_url

SYNC_LOG_PATH = Path("chatgpt-sync-log.json")

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

# Filtering thresholds
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

SUMMARIZATION_PROMPT_TEMPLATE = """\
You are distilling a ChatGPT conversation into standalone thoughts for a \
personal knowledge base. Your job is to be HIGHLY SELECTIVE — only extract \
knowledge that would be valuable to retrieve months or years from now.

CAPTURE these (1-{limit} thoughts max):
- Decisions made and the reasoning behind them
- People mentioned with context (who they are, relationship, what was discussed)
- Project plans, strategies, or architectural choices
- Lessons learned, mistakes acknowledged, preferences discovered
- Business context: companies, roles, goals, metrics
- Personal values, beliefs, or frameworks articulated

SKIP these entirely (return empty):
- One-off creative tasks (poems, letters, stories, jokes)
- Generic Q&A or factual lookups
- Coding help with no lasting architectural decisions
- Hypothetical explorations with no conclusion
- Short tasks where the user just needed something written/formatted

Each thought must be:
- A clear, standalone statement (makes sense without the conversation)
- Written in first person
- Anchored with names, dates, or project context when available
- 1-3 sentences

Return a JSON object with exactly one key: "thoughts".
The value of "thoughts" must be an array of 0-{limit} real thought strings.
Treat {limit} as an upper bound, not a target. Return fewer when the conversation
only supports a small number of durable memories, and only go above 3 when the
conversation clearly contains several distinct long-term-useful ideas.
Do not use placeholders such as "thought1", "thought2", or template labels.
If the conversation has nothing worth capturing, return {{"thoughts": []}}
Err on the side of returning empty — less is more."""

# ─── Sync Log ────────────────────────────────────────────────────────────────


def load_sync_log():
    """Load sync log from disk. Returns dict with ingested_ids and last_sync."""
    try:
        with open(SYNC_LOG_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"ingested_ids": {}, "last_sync": ""}


def save_sync_log(log):
    """Save sync log to disk."""
    with open(SYNC_LOG_PATH, "w") as f:
        json.dump(log, f, indent=2)


# ─── HTTP Helpers ────────────────────────────────────────────────────────────

try:
    import requests
except ImportError:
    print("Missing dependency: requests")
    print("Install with: pip install requests")
    sys.exit(1)


def http_post_with_retry(url, headers, body, retries=2, timeout=30):
    """POST with exponential backoff retry on transient failures."""
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
    return None  # unreachable


def extract_json_payload(text):
    """Extract a JSON object from plain text or fenced code output."""
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
    """Extract parsed arguments from a tool call response."""
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
    """Normalize model output to a small unique list of real thoughts."""
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
        if not thought:
            continue
        if thought in seen:
            continue
        seen.add(thought)
        normalized.append(thought)
        if len(normalized) >= limit:
            break

    return normalized


def determine_thought_limit(word_count, message_count):
    """Return a deterministic upper bound for durable thoughts.

    This is an upper bound, not a target. The LLM should still return fewer
    thoughts for narrow conversations.
    """
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
    """Build the tool schema for the current adaptive thought cap."""
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


def build_summarization_prompt(limit):
    """Render the prompt for the current adaptive thought cap."""
    return SUMMARIZATION_PROMPT_TEMPLATE.format(limit=limit)


def summarize_input_limit(thought_limit):
    """Return the input truncation budget for summarization."""
    extra_limit = max(0, thought_limit - DEFAULT_THOUGHT_LIMIT)
    return min(16000, 6000 + (extra_limit * 2500))


def summarize_output_limit(thought_limit):
    """Return the token budget for summarization."""
    return max(500, 220 * thought_limit)


# ─── ChatGPT Export Parsing ──────────────────────────────────────────────────


def extract_conversations(source_path):
    """Extract conversations from a ChatGPT export zip or extracted directory.

    Handles both single conversations.json and the multi-file format
    (conversations-000.json through conversations-NNN.json) that OpenAI
    uses for large exports.
    """
    source = Path(source_path)

    if source.is_dir():
        return _load_conversations_from_dir(source)

    with zipfile.ZipFile(source, "r") as zf:
        conv_re = re.compile(r"(?:^|/)conversations(?:-\d+)?\.json$")
        candidates = [n for n in zf.namelist() if conv_re.search(n)]
        if not candidates:
            print("Error: No conversations JSON files found in zip archive.")
            print("  Expected conversations.json or conversations-000.json, etc.")
            sys.exit(1)

        all_conversations = []
        for name in sorted(candidates):
            with zf.open(name) as f:
                convs = json.load(f)
                if isinstance(convs, list):
                    all_conversations.extend(convs)
                else:
                    print(f"  Warning: {name} is not a JSON array, skipping.")
        if not all_conversations:
            print("Error: Conversation files were found but contained no data.")
            sys.exit(1)
        print(f"  Loaded {len(candidates)} conversation file(s) from zip.")
        return all_conversations


def _load_conversations_from_dir(directory):
    """Load conversations from an already-extracted export directory."""
    conv_re = re.compile(r"^conversations(?:-\d+)?\.json$")
    candidates = sorted(f for f in os.listdir(directory) if conv_re.match(f))
    if not candidates:
        print(f"Error: No conversations JSON files found in {directory}")
        print("  Expected conversations.json or conversations-000.json, etc.")
        sys.exit(1)

    all_conversations = []
    for name in candidates:
        filepath = os.path.join(directory, name)
        with open(filepath) as f:
            convs = json.load(f)
            if isinstance(convs, list):
                all_conversations.extend(convs)
            else:
                print(f"  Warning: {name} is not a JSON array, skipping.")
    if not all_conversations:
        print("Error: Conversation files were found but contained no data.")
        sys.exit(1)
    print(f"  Loaded {len(candidates)} conversation file(s) from directory.")
    return all_conversations


def conversation_hash(conv):
    """Generate a stable hash ID for a conversation."""
    title = conv.get("title", "")
    create_time = str(conv.get("create_time", ""))
    raw = f"{title}|{create_time}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def walk_messages(mapping):
    """Walk the mapping tree to extract messages in conversation order.

    The mapping is a dict of node_id -> node. Each node has an optional
    'message' field and 'parent'/'children' references forming a tree.
    We find the root (no parent or parent not in mapping) and walk depth-first.
    """
    if not mapping:
        return []

    # Find root node(s): nodes whose parent is None or not in the mapping
    roots = []
    for node_id, node in mapping.items():
        parent = node.get("parent")
        if parent is None or parent not in mapping:
            roots.append(node_id)

    if not roots:
        return []

    # Walk from root depth-first, visiting all branches.
    # Most conversations are linear; branched ones yield all paths.
    messages = []
    visited = set()

    def walk(node_id):
        if node_id in visited or node_id not in mapping:
            return
        visited.add(node_id)
        node = mapping[node_id]
        msg = node.get("message")
        if msg and msg.get("content"):
            messages.append(msg)
        children = node.get("children", [])
        for child_id in children:
            walk(child_id)

    for root_id in roots:
        walk(root_id)

    return messages


def extract_message_text(message, include_attachment_labels=False):
    """Extract human-readable text from a ChatGPT message payload."""
    content = message.get("content", {})
    content_type = content.get("content_type")
    metadata = message.get("metadata") or {}

    if content_type == "user_editable_context":
        # This is the persistent profile/instructions blob, not a real turn.
        return ""

    fragments = []

    if content_type in {
        "text",
        "code",
        "execution_output",
        "computer_output",
        "system_error",
        "tether_browsing_display",
        "tether_quote",
    }:
        parts = content.get("parts", [])
        for part in parts:
            if isinstance(part, str):
                text = part.strip()
                if text:
                    fragments.append(text)

    elif content_type == "multimodal_text":
        if include_attachment_labels:
            attachment_names = []
            for attachment in metadata.get("attachments") or []:
                name = attachment.get("name") or attachment.get("id")
                if name:
                    attachment_names.append(name)
            if attachment_names:
                fragments.append(f"Attachments: {', '.join(attachment_names)}")

        for part in content.get("parts", []):
            if isinstance(part, str):
                text = part.strip()
                if text:
                    fragments.append(text)

    return "\n".join(fragments).strip()


def extract_user_text(messages):
    """Extract text from user messages only, concatenated with separators."""
    parts = []
    for msg in messages:
        author = msg.get("author", {})
        if author.get("role") != "user":
            continue
        text = extract_message_text(msg, include_attachment_labels=True)
        if text:
            parts.append(text)
    return "\n---\n".join(parts)


def count_messages(messages):
    """Count visible user/assistant turns that carry meaningful text."""
    count = 0
    for msg in messages:
        author_role = (msg.get("author") or {}).get("role")
        if author_role not in {"user", "assistant"}:
            continue
        text = extract_message_text(msg, include_attachment_labels=(author_role == "user"))
        if text:
            count += 1
    return count


# ─── Conversation Filtering ─────────────────────────────────────────────────


def should_skip(conv, user_text, message_count, sync_log, args):
    """Return a skip reason string, or None if the conversation should be processed."""
    conv_id = conversation_hash(conv)

    # Already imported
    if conv_id in sync_log["ingested_ids"]:
        return "already_imported"

    # Date filtering
    create_time = conv.get("create_time")
    if create_time:
        conv_date = datetime.fromtimestamp(create_time, tz=timezone.utc).date()
        if args.after and conv_date < args.after:
            return "before_date_filter"
        if args.before and conv_date > args.before:
            return "after_date_filter"

    # Explicitly marked "do not remember" by the user in ChatGPT
    if conv.get("is_do_not_remember"):
        return "do_not_remember"

    # Too few messages
    if message_count < MIN_TOTAL_MESSAGES:
        return "too_few_messages"

    # Title-based skip
    title = conv.get("title") or ""
    if SKIP_TITLE_PATTERNS.search(title):
        return "skip_title"

    # Not enough user text
    word_count = len(user_text.split())
    if word_count < MIN_USER_WORDS:
        return "too_little_text"

    return None


# ─── LLM Summarization ──────────────────────────────────────────────────────


def summarize_local(title, date_str, user_text, thought_limit):
    """Summarize a conversation using the local OpenAI-compatible LLM endpoint."""
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
                {"role": "system", "content": build_summarization_prompt(thought_limit)},
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
        thoughts = normalize_thoughts(result.get("thoughts", []), limit=thought_limit)
        return thoughts
    except (KeyError, json.JSONDecodeError, IndexError, ValueError) as e:
        print(f"   Warning: Failed to parse local summarization response: {e}")
        return []


def summarize_ollama(title, date_str, user_text, thought_limit, model_name="qwen3"):
    """Summarize a conversation using a local Ollama model."""
    truncated = user_text[: summarize_input_limit(thought_limit)]

    prompt = (
        f"{build_summarization_prompt(thought_limit)}\n\n"
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
    except requests.RequestException as e:
        print(f"   Warning: Ollama request failed: {e}")
        return []

    if resp.status_code != 200:
        print(f"   Warning: Ollama returned {resp.status_code}")
        return []

    try:
        raw = resp.json().get("response", "")
        result = json.loads(raw)
        return normalize_thoughts(result.get("thoughts", []), limit=thought_limit)
    except (json.JSONDecodeError, KeyError) as e:
        print(f"   Warning: Failed to parse Ollama response: {e}")
        return []


def summarize(title, date_str, user_text, thought_limit, args):
    """Dispatch to the appropriate summarization backend."""
    if args.model == "local":
        return summarize_local(title, date_str, user_text, thought_limit)
    if args.model == "ollama":
        return summarize_ollama(title, date_str, user_text, thought_limit, args.ollama_model)
    raise ValueError(f"Unsupported model backend: {args.model}")


# ─── Ingestion ───────────────────────────────────────────────────────────────


def ingest_thought_local(content, metadata_dict, occurred_at=None):
    """POST a thought to the local Open Brain ingest endpoint."""
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
            "source": "chatgpt",
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


# ─── CLI ─────────────────────────────────────────────────────────────────────


def parse_date(s):
    """Parse a YYYY-MM-DD string to a date object."""
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError:
        print(f"Error: Invalid date format '{s}'. Use YYYY-MM-DD.")
        sys.exit(1)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Import ChatGPT conversations into Open Brain",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Examples:
  python import-chatgpt.py export.zip --dry-run --limit 10
  python import-chatgpt.py export.zip --after 2024-01-01
  python import-chatgpt.py export.zip --model local
  python import-chatgpt.py export.zip --model ollama --ollama-model qwen3
  python import-chatgpt.py export.zip --raw --limit 50""",
    )
    parser.add_argument("zip_path", help="Path to ChatGPT data export zip file or extracted directory")
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
    parser.add_argument("--raw", action="store_true", help="Skip summarization, ingest user messages directly")
    parser.add_argument("--verbose", action="store_true", help="Show full summaries during processing")
    parser.add_argument("--report", type=str, metavar="FILE", help="Write a markdown report of everything imported")
    return parser.parse_args()


# ─── Main ────────────────────────────────────────────────────────────────────


def main():
    args = parse_args()

    if not os.path.isfile(args.zip_path) and not os.path.isdir(args.zip_path):
        print(f"Error: Path not found: {args.zip_path}")
        sys.exit(1)

    # Validate env vars for live mode
    if not args.dry_run:
        if not LOCAL_INGEST_URL:
            print("Error: OPEN_BRAIN_INGEST_URL is not set.")
            sys.exit(1)
        if not LOCAL_INGEST_KEY:
            print("Error: OPEN_BRAIN_INGEST_KEY or MCP_ACCESS_KEY is not set.")
            sys.exit(1)

    print(f"\nExtracting conversations from {args.zip_path}...")
    conversations = extract_conversations(args.zip_path)
    print(f"Found {len(conversations)} conversations.\n")

    # Sort by create_time (oldest first)
    conversations.sort(key=lambda c: c.get("create_time", 0))

    sync_log = load_sync_log()

    # Display run configuration
    mode = "DRY RUN" if args.dry_run else "LIVE"
    ingest_mode = f"local endpoint ({LOCAL_INGEST_URL})"
    summarize_mode = "raw (no summarization)" if args.raw else f"{args.model}"
    if args.model == "local" and not args.raw:
        summarize_mode += f" ({LOCAL_LLM_MODEL})"
    if args.model == "ollama" and not args.raw:
        summarize_mode += f" ({args.ollama_model})"
    print(f"  Mode:        {mode}")
    if not args.dry_run:
        print(f"  Ingestion:   {ingest_mode}")
    print(f"  Summarizer:  {summarize_mode}")
    if args.after:
        print(f"  After:       {args.after}")
    if args.before:
        print(f"  Before:      {args.before}")
    if args.limit:
        print(f"  Limit:       {args.limit}")
    print()

    # Counters
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
        # Respect limit
        if args.limit and processed >= args.limit:
            break

        # Parse conversation
        messages = walk_messages(conv.get("mapping", {}))
        user_text = extract_user_text(messages)
        message_count = count_messages(messages)

        # Filter
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

        title = conv.get("title", "(untitled)")
        create_time = conv.get("create_time")
        date_str = (
            datetime.fromtimestamp(create_time, tz=timezone.utc).strftime("%Y-%m-%d")
            if create_time
            else "unknown"
        )
        conv_id = conversation_hash(conv)
        chatgpt_id = conv.get("id", "")

        print(f"{processed}. {title}")
        url_display = f"https://chatgpt.com/c/{chatgpt_id}" if chatgpt_id else "no id"
        thought_limit = determine_thought_limit(word_count, message_count)
        print(
            f"   {message_count} messages | {word_count} user words | "
            f"up to {thought_limit} thoughts | {date_str} | {url_display}"
        )

        # Summarize or use raw
        if args.raw:
            thoughts = [user_text]
        else:
            thoughts = summarize(title, date_str, user_text, thought_limit, args)

        thoughts_generated += len(thoughts)

        if not thoughts:
            print("   -> No thoughts extracted (empty summary)")
            if not args.dry_run:
                sync_log["ingested_ids"][conv_id] = datetime.now(timezone.utc).isoformat()
                save_sync_log(sync_log)
            print()
            continue

        if args.verbose or args.dry_run:
            for i, thought in enumerate(thoughts, 1):
                preview = thought if len(thought) <= 200 else thought[:200] + "..."
                print(f"   Thought {i}: {preview}")

        if args.report:
            report_entries.append({
                "title": title,
                "date": date_str,
                "messages": message_count,
                "user_words": word_count,
                "thought_limit": thought_limit,
                "thoughts": thoughts,
            })

        if args.dry_run:
            print()
            continue

        # Build metadata
        metadata = {
            "source": "chatgpt",
            "chatgpt_title": title,
            "chatgpt_date": date_str,
            "conversation_id": chatgpt_id,
        }
        if chatgpt_id:
            metadata["conversation_url"] = f"https://chatgpt.com/c/{chatgpt_id}"

        # Ingest thoughts
        all_ok = True
        for i, thought in enumerate(thoughts):
            content = f"[ChatGPT: {title} | {date_str}] {thought}"

            extra_metadata = {
                "chatgpt_title": title,
                "chatgpt_create_time": date_str,
                "chatgpt_conversation_hash": conv_id,
                "chatgpt_conversation_id": chatgpt_id,
                "chatgpt_conversation_url": metadata.get("conversation_url"),
                "chatgpt_thought_limit": thought_limit,
                "chatgpt_thought_count": len(thoughts),
                "chatgpt_message_count": message_count,
                "chatgpt_user_word_count": word_count,
                "full_text": user_text,
                "type": "chatgpt_conversation",
                "topics": ["chatgpt", "import"],
            }
            result = ingest_thought_local(content, extra_metadata, occurred_at=date_str)

            if result.get("ok"):
                ingested += 1
                print(f"   -> Thought {i + 1} ingested")
            else:
                errors += 1
                all_ok = False
                print(f"   -> ERROR (thought {i + 1}): {result.get('error', 'unknown')}")

            time.sleep(0.2)  # Rate limit

        # Update sync log on success
        if all_ok:
            sync_log["ingested_ids"][conv_id] = datetime.now(timezone.utc).isoformat()
            save_sync_log(sync_log)

        print()

    # ─── Summary ─────────────────────────────────────────────────────────────

    print("─" * 60)
    print("Summary:")
    print(f"  Conversations found:    {total}")
    if already_imported > 0:
        print(f"  Already imported:       {already_imported} (skipped)")
    if filtered > 0:
        reasons = ", ".join(f"{v} {k}" for k, v in sorted(filter_reasons.items(), key=lambda x: -x[1]))
        print(f"  Filtered (trivial):     {filtered} ({reasons})")
    print(f"  Processed:              {processed}")
    print(f"  Total user words:       {total_user_words:,}")
    print(f"  Thoughts generated:     {thoughts_generated}")
    if not args.dry_run:
        print(f"  Ingested:               {ingested}")
        print(f"  Errors:                 {errors}")

    # Cost estimation
    print("  Est. external API cost: $0.0000")
    print("─" * 60)

    if args.report and report_entries:
        _write_report(args.report, report_entries, {
            "total": total,
            "already_imported": already_imported,
            "filtered": filtered,
            "filter_reasons": filter_reasons,
            "processed": processed,
            "thoughts_generated": thoughts_generated,
            "ingested": ingested,
            "errors": errors,
            "total_user_words": total_user_words,
            "dry_run": args.dry_run,
        })


def _write_report(filepath, entries, stats):
    """Write a markdown report of imported conversations."""
    with open(filepath, "w") as f:
        mode = "DRY RUN" if stats["dry_run"] else "LIVE"
        f.write(f"# ChatGPT Import Report ({mode})\n\n")
        f.write(f"Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n\n")

        f.write("## Stats\n\n")
        f.write(f"| Metric | Value |\n|--------|-------|\n")
        f.write(f"| Conversations found | {stats['total']} |\n")
        f.write(f"| Already imported | {stats['already_imported']} |\n")
        f.write(f"| Filtered (trivial) | {stats['filtered']} |\n")
        f.write(f"| Processed | {stats['processed']} |\n")
        f.write(f"| Thoughts generated | {stats['thoughts_generated']} |\n")
        if not stats["dry_run"]:
            f.write(f"| Ingested | {stats['ingested']} |\n")
            f.write(f"| Errors | {stats['errors']} |\n")
        f.write(f"| Total user words | {stats['total_user_words']:,} |\n")
        f.write("\n")

        f.write("## Conversations\n\n")
        for entry in entries:
            f.write(f"### {entry['title']} ({entry['date']})\n\n")
            f.write(
                f"_{entry['messages']} messages, {entry['user_words']} user words, "
                f"adaptive cap {entry['thought_limit']}_\n\n"
            )
            for i, thought in enumerate(entry["thoughts"], 1):
                f.write(f"{i}. {thought}\n")
            f.write("\n")

    print(f"\nReport written to {filepath}")


if __name__ == "__main__":
    main()
