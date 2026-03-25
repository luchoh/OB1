#!/usr/bin/env python3
"""
Open Brain — Telegram Capture Bridge

Bot-based direct-message inbox for typed notes and voice/audio handoff to the
separate dictation service.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import mimetypes
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import requests
from minio import Minio

from recipes.shared_docling import (
    extract_tool_arguments,
    http_post_with_retry,
    local_llm_base_url,
    truncate_text,
)
from recipes.shared_object_store import first_env, optional_env_flag, resolve_minio_endpoint
from recipes.shared_telegram_review_state import (
    DICTATION_RESOLUTION_IGNORED,
    DICTATION_RESOLUTION_INGESTED,
    REVIEW_MODE_EXCEPTIONS_ONLY,
    REVIEW_MODE_FULL,
    THOUGHT_STATUS_APPROVED,
    THOUGHT_STATUS_DENIED,
    approved_session_payloads,
    apply_edit_reply,
    build_review_reply_markup,
    build_review_session,
    default_review_state_path,
    find_edit_session,
    locked_review_state,
    normalize_review_mode,
    parse_callback_data,
    pending_action_token,
    prune_pending_actions,
    record_resolution,
    render_review_text,
    review_session_has_thoughts,
    start_edit_prompt,
)


INTEGRATION_DIR = Path(__file__).resolve().parent
DEFAULT_STATE_PATH = Path(os.environ.get("TELEGRAM_BRIDGE_STATE_FILE") or (INTEGRATION_DIR / "telegram-bridge-state.json"))
DEFAULT_REVIEW_STATE_PATH = default_review_state_path(INTEGRATION_DIR / "telegram-review-state.json")

DEFAULT_OPEN_BRAIN_BASE = (os.environ.get("OPEN_BRAIN_BASE_URL") or f"http://127.0.0.1:{os.environ.get('OPEN_BRAIN_PORT', '8787')}").rstrip("/")
DEFAULT_OPEN_BRAIN_ACCESS_KEY = os.environ.get("MCP_ACCESS_KEY") or os.environ.get("OPEN_BRAIN_ACCESS_KEY") or ""
DEFAULT_LLM_MODEL = os.environ.get("LLM_MODEL", "mlx-community/Qwen3.5-397B-A17B-nvfp4")

DEFAULT_TELEGRAM_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN") or ""
DEFAULT_ALLOWED_CHAT_IDS = [
    item.strip()
    for item in (os.environ.get("TELEGRAM_ALLOWED_CHAT_IDS") or "").split(",")
    if item.strip()
]
DEFAULT_POLL_TIMEOUT = int(os.environ.get("TELEGRAM_POLL_TIMEOUT_SECONDS", "25"))

DEFAULT_MINIO_ENDPOINT = first_env("MINIO_ENDPOINT", "TELEGRAM_MINIO_ENDPOINT")
DEFAULT_MINIO_SERVICE_NAME = first_env("MINIO_SERVICE_NAME", "TELEGRAM_MINIO_SERVICE_NAME", default="minio")
DEFAULT_MINIO_ACCESS_KEY = os.environ.get("MINIO_ACCESS_KEY") or os.environ.get("TELEGRAM_MINIO_ACCESS_KEY") or ""
DEFAULT_MINIO_SECRET_KEY = os.environ.get("MINIO_SECRET_KEY") or os.environ.get("TELEGRAM_MINIO_SECRET_KEY") or ""
DEFAULT_MINIO_SECURE = optional_env_flag("MINIO_SECURE", "TELEGRAM_MINIO_SECURE")
DEFAULT_RAW_BUCKET = os.environ.get("TELEGRAM_RAW_AUDIO_BUCKET") or "telegram-raw-audio"

DEFAULT_DICTATION_BASE = (os.environ.get("DICTATION_BASE_URL") or "https://dictation.lincoln.luchoh.net").rstrip("/")
DEFAULT_DICTATION_ACCESS_KEY = os.environ.get("DICTATION_ACCESS_KEY") or ""
DEFAULT_DICTATION_SUBMIT_URL = (os.environ.get("DICTATION_OBJECT_SUBMIT_URL") or f"{DEFAULT_DICTATION_BASE}/v1/dictation/notes/from-object").rstrip("/")
DEFAULT_DICTATION_CLEANUP_MODE = os.environ.get("DICTATION_CLEANUP_MODE") or "llm"
DEFAULT_ENSURE_BUCKET = (os.environ.get("TELEGRAM_ENSURE_RAW_BUCKET") or "false").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
DEFAULT_REVIEW_MATCH_THRESHOLD = float(os.environ.get("TELEGRAM_REVIEW_MATCH_THRESHOLD", "0.78"))
DEFAULT_REVIEW_MATCH_COUNT = int(os.environ.get("TELEGRAM_REVIEW_MATCH_COUNT", "3"))
DEFAULT_PENDING_ACTION_TTL_SECONDS = int(os.environ.get("TELEGRAM_PENDING_ACTION_TTL_SECONDS", "86400"))
DEFAULT_REVIEW_MODE = normalize_review_mode(
    first_env("TELEGRAM_REVIEW_MODE", "TELEGRAM_CAPTURE_REVIEW_MODE", default=REVIEW_MODE_FULL),
    default=REVIEW_MODE_FULL,
)
MAX_RAW_MESSAGE_CHARS = 3500

DEFAULT_ENABLE_THINKING = os.environ.get("LLM_ENABLE_THINKING", "false").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)

THOUGHTS_TOOL = {
    "type": "function",
    "function": {
        "name": "submit_thoughts",
        "description": "Return durable thought strings worth storing from the Telegram text message.",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "required": ["thoughts"],
            "properties": {
                "thoughts": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Up to 3 standalone thought strings.",
                },
                "reason": {
                    "type": "string",
                    "description": "Short explanation when nothing should be stored automatically.",
                },
            },
        },
    },
}

NOVELTY_REVIEW_TOOL = {
    "type": "function",
    "function": {
        "name": "submit_review",
        "description": "Review whether candidate thoughts are novel enough to store automatically.",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "required": ["reviews"],
            "properties": {
                "reviews": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["thought", "decision", "reason"],
                        "properties": {
                            "thought": {"type": "string"},
                            "decision": {
                                "type": "string",
                                "enum": ["record", "duplicate", "uncertain"],
                            },
                            "reason": {"type": "string"},
                        },
                    },
                }
            },
        },
    },
}

TELEGRAM_TEXT_PROMPT = """\
You are turning a short Telegram capture into durable memory items for a personal knowledge base.

Capture only durable value:
- decisions, plans, commitments, constraints
- preferences, observations, open questions
- concrete names, systems, places, devices, or projects

Skip:
- acknowledgements
- pure filler
- one-line chatter with no future retrieval value

Each thought must:
- stand alone without the original message open
- stay faithful to the message
- be concise and concrete
- be 1-3 sentences

Return a JSON object with exactly one key: "thoughts".
You may also include an optional "reason" string.
The value of "thoughts" must be an array of 0-3 real thought strings.
If the message has no durable value, return {"thoughts": [], "reason": "<short explanation>"}.
"""

TELEGRAM_NOVELTY_PROMPT = """\
You are reviewing candidate Telegram memory thoughts before they are stored automatically.

Decide whether each candidate thought should be recorded automatically.

Use these decisions:
- "record": materially new or meaningfully sharper than the existing nearby memories
- "duplicate": already represented closely enough by existing memories
- "uncertain": too ambiguous to auto-record safely

Important:
- Paraphrases can still be duplicates.
- A thought is still "record" if it adds new scope, new constraint, new decision, or new factual detail.
- Be conservative. If unsure, choose "uncertain".

Return one review object per candidate thought.
"""


def parse_args():
    parser = argparse.ArgumentParser(description="Telegram bot bridge for OB1 typed capture and dictation handoff.")
    parser.add_argument("--telegram-token", default=DEFAULT_TELEGRAM_TOKEN, help="Telegram bot token.")
    parser.add_argument("--allowed-chat-id", action="append", default=[], help="Allowed Telegram private chat id. May be repeated.")
    parser.add_argument("--poll-timeout", type=int, default=DEFAULT_POLL_TIMEOUT, help="Telegram long-poll timeout in seconds.")
    parser.add_argument("--base-url", default=DEFAULT_OPEN_BRAIN_BASE, help="Open Brain runtime base URL.")
    parser.add_argument("--access-key", default=DEFAULT_OPEN_BRAIN_ACCESS_KEY, help="Open Brain access key.")
    parser.add_argument("--llm-model", default=DEFAULT_LLM_MODEL, help="Local summarizer model.")
    parser.add_argument(
        "--minio-endpoint",
        default=DEFAULT_MINIO_ENDPOINT,
        help="Explicit MinIO endpoint host:port override. If unset, resolve the service name through Consul.",
    )
    parser.add_argument("--minio-service-name", default=DEFAULT_MINIO_SERVICE_NAME, help="Consul service name for MinIO discovery.")
    parser.add_argument("--minio-access-key", default=DEFAULT_MINIO_ACCESS_KEY, help="MinIO access key.")
    parser.add_argument("--minio-secret-key", default=DEFAULT_MINIO_SECRET_KEY, help="MinIO secret key.")
    parser.add_argument("--minio-secure", action=argparse.BooleanOptionalAction, default=DEFAULT_MINIO_SECURE, help="Use HTTPS for MinIO.")
    parser.add_argument("--raw-bucket", default=DEFAULT_RAW_BUCKET, help="MinIO bucket for raw Telegram audio.")
    parser.add_argument("--dictation-submit-url", default=DEFAULT_DICTATION_SUBMIT_URL, help="Dictation object-submission endpoint.")
    parser.add_argument("--dictation-access-key", default=DEFAULT_DICTATION_ACCESS_KEY, help="Dictation access key.")
    parser.add_argument("--cleanup-mode", default=DEFAULT_DICTATION_CLEANUP_MODE, help="Cleanup mode forwarded to dictation.")
    parser.add_argument("--review-match-threshold", type=float, default=DEFAULT_REVIEW_MATCH_THRESHOLD, help="Similarity threshold for Telegram novelty review.")
    parser.add_argument("--review-match-count", type=int, default=DEFAULT_REVIEW_MATCH_COUNT, help="Max similar rows per candidate for Telegram novelty review.")
    parser.add_argument(
        "--review-mode",
        choices=[REVIEW_MODE_FULL, REVIEW_MODE_EXCEPTIONS_ONLY],
        default=DEFAULT_REVIEW_MODE,
        help="Telegram review mode for text captures.",
    )
    parser.add_argument("--pending-action-ttl-seconds", type=int, default=DEFAULT_PENDING_ACTION_TTL_SECONDS, help="How long review prompts remain actionable.")
    parser.add_argument("--state-file", default=str(DEFAULT_STATE_PATH), help="Path to persistent bridge state JSON.")
    parser.add_argument("--review-state-file", default=str(DEFAULT_REVIEW_STATE_PATH), help="Path to shared Telegram review-state JSON.")
    parser.add_argument(
        "--ensure-bucket",
        action=argparse.BooleanOptionalAction,
        default=DEFAULT_ENSURE_BUCKET,
        help="Create the raw MinIO bucket if it does not already exist.",
    )
    parser.add_argument("--once", action="store_true", help="Fetch one batch of Telegram updates and exit.")
    parser.add_argument("--update-file", help="Process a saved Telegram update payload from disk and exit.")
    parser.add_argument("--max-updates", type=int, default=0, help="Optional max updates to process before exit.")
    parser.add_argument("--dry-run", action="store_true", help="Process messages without OB1, MinIO, or dictation writes.")
    parser.add_argument("--verbose", action="store_true", help="Print per-update progress.")
    args = parser.parse_args()

    combined_chat_ids = list(DEFAULT_ALLOWED_CHAT_IDS)
    combined_chat_ids.extend(args.allowed_chat_id)
    args.allowed_chat_ids = {str(item).strip() for item in combined_chat_ids if str(item).strip()}

    if not args.telegram_token and not args.update_file:
        parser.error("Missing Telegram bot token. Set TELEGRAM_BOT_TOKEN or pass --telegram-token.")
    if not args.dry_run and not args.access_key:
        parser.error("Missing OB1 access key. Set MCP_ACCESS_KEY or pass --access-key.")
    if not args.dry_run and not (args.minio_endpoint or args.minio_service_name):
        parser.error("Missing MinIO discovery config. Set MINIO_SERVICE_NAME or pass --minio-endpoint.")
    if not args.dry_run and args.minio_secure is None:
        parser.error("Missing MinIO secure mode. Set MINIO_SECURE or pass --minio-secure/--no-minio-secure.")
    if not args.dry_run and not args.dictation_access_key:
        parser.error("Missing dictation access key. Set DICTATION_ACCESS_KEY or pass --dictation-access-key.")

    args.state_file = Path(args.state_file)
    args.review_state_file = Path(args.review_state_file)
    return args


def load_state(path: Path):
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"offset": 0, "updated_at": None, "pending_actions": {}}
    if not isinstance(payload, dict):
        return {"offset": 0, "updated_at": None, "pending_actions": {}}
    payload.setdefault("offset", 0)
    payload.setdefault("updated_at", None)
    if not isinstance(payload.get("pending_actions"), dict):
        payload["pending_actions"] = {}
    return payload


def save_state(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)


def minio_client(args):
    resolved_endpoint = resolve_minio_endpoint(args.minio_endpoint, service_name=args.minio_service_name)
    return Minio(
        resolved_endpoint,
        access_key=args.minio_access_key,
        secret_key=args.minio_secret_key,
        secure=args.minio_secure,
    )


def ensure_bucket(client: Minio, bucket: str):
    if not client.bucket_exists(bucket):
        client.make_bucket(bucket)


def telegram_base(token: str) -> str:
    return f"https://api.telegram.org/bot{token}"


def telegram_file_base(token: str) -> str:
    return f"https://api.telegram.org/file/bot{token}"


def telegram_api_call(token: str, method: str, payload: dict | None = None, timeout: int = 60):
    response = requests.post(
        f"{telegram_base(token)}/{method}",
        json=payload or {},
        timeout=timeout,
    )
    response.raise_for_status()
    body = response.json()
    if not body.get("ok"):
        raise RuntimeError(f"Telegram {method} failed: {body}")
    return body["result"]


def get_updates(token: str, offset: int, timeout_seconds: int):
    return telegram_api_call(
        token,
        "getUpdates",
        {"offset": offset, "timeout": timeout_seconds, "allowed_updates": ["message", "callback_query"]},
        timeout=timeout_seconds + 20,
    )


def get_file_info(token: str, file_id: str):
    return telegram_api_call(token, "getFile", {"file_id": file_id})


def download_file_bytes(token: str, file_path: str):
    response = requests.get(f"{telegram_file_base(token)}/{file_path}", timeout=300)
    response.raise_for_status()
    return response.content


def send_reply(token: str, chat_id: str, reply_to_message_id: int, text: str, *, reply_markup: dict | None = None):
    payload = {
        "chat_id": chat_id,
        "reply_to_message_id": reply_to_message_id,
        "text": text,
        "allow_sending_without_reply": True,
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    return telegram_api_call(token, "sendMessage", payload)


def send_action_prompt(token: str, chat_id: str, reply_to_message_id: int, text: str, *, reply_markup: dict):
    return send_reply(
        token,
        chat_id,
        reply_to_message_id,
        text,
        reply_markup=reply_markup,
    )


def edit_message(token: str, chat_id: str, message_id: int, text: str, *, reply_markup: dict | None = None):
    payload = {
        "chat_id": chat_id,
        "message_id": message_id,
        "text": text,
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    telegram_api_call(token, "editMessageText", payload)


def answer_callback_query(token: str, callback_query_id: str, text: str | None = None):
    payload = {"callback_query_id": callback_query_id}
    if text:
        payload["text"] = text
    telegram_api_call(token, "answerCallbackQuery", payload)


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def summarize_text_message(text: str, title_hint: str | None, llm_model: str):
    prompt = "\n".join(
        [
            f"Title hint: {title_hint or '(none)'}",
            "",
            "Telegram message:",
            text,
        ]
    )
    response = http_post_with_retry(
        f"{local_llm_base_url()}/chat/completions",
        headers={"Content-Type": "application/json"},
        json_body={
            "model": llm_model,
            "temperature": 0.2,
            "max_tokens": 800,
            "chat_template_kwargs": {"enable_thinking": DEFAULT_ENABLE_THINKING},
            "messages": [
                {"role": "system", "content": TELEGRAM_TEXT_PROMPT},
                {"role": "user", "content": prompt},
            ],
            "tools": [THOUGHTS_TOOL],
            "tool_choice": {"type": "function", "function": {"name": "submit_thoughts"}},
        },
        timeout=300,
    )
    if response is None:
        raise RuntimeError("LLM request returned no response")
    payload = response.json()
    parsed = extract_tool_arguments(payload, "submit_thoughts")
    thoughts = parsed.get("thoughts", [])
    reason = normalize_text(parsed.get("reason", "")) if isinstance(parsed, dict) else ""
    if not isinstance(thoughts, list):
        return {"thoughts": [], "reason": reason or "The model did not return usable thought candidates."}

    normalized = []
    seen = set()
    for item in thoughts:
        if not isinstance(item, str):
            continue
        cleaned = normalize_text(item)
        if not cleaned:
            continue
        lowered = cleaned.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        normalized.append(cleaned)
        if len(normalized) >= 3:
            break
    return {
        "thoughts": normalized,
        "reason": reason,
    }


def lookup_similar_thoughts(base_url: str, access_key: str, queries: list[str], *, match_threshold: float, match_count: int):
    response = requests.post(
        f"{base_url.rstrip('/')}/admin/thought/similar",
        headers={
            "Content-Type": "application/json",
            "x-access-key": access_key,
            "x-ingest-key": access_key,
        },
        json={
            "queries": queries,
            "match_threshold": match_threshold,
            "match_count": match_count,
        },
        timeout=300,
    )
    body_text = response.text
    if response.status_code not in (200, 201):
        raise RuntimeError(f"{response.status_code} {response.reason}: {body_text}")
    payload = response.json()
    results = payload.get("results", [])
    return {item.get("query"): item.get("matches", []) for item in results if isinstance(item, dict)}


def review_thought_novelty(candidate_thoughts: list[str], similar_matches: dict[str, list[dict]], llm_model: str):
    if not candidate_thoughts:
        return []

    lines = []
    for index, thought in enumerate(candidate_thoughts, start=1):
        lines.append(f"Candidate {index}: {thought}")
        matches = similar_matches.get(thought, [])[:3]
        if not matches:
            lines.append("Nearby existing memories: (none)")
        else:
            lines.append("Nearby existing memories:")
            for match_index, match in enumerate(matches, start=1):
                lines.append(
                    f"- {match_index}. similarity={match.get('similarity')} type={match.get('type')} "
                    f"source={match.get('source')} summary={match.get('summary')}"
                )
        lines.append("")

    response = http_post_with_retry(
        f"{local_llm_base_url()}/chat/completions",
        headers={"Content-Type": "application/json"},
        json_body={
            "model": llm_model,
            "temperature": 0.1,
            "max_tokens": 1200,
            "chat_template_kwargs": {"enable_thinking": DEFAULT_ENABLE_THINKING},
            "messages": [
                {"role": "system", "content": TELEGRAM_NOVELTY_PROMPT},
                {"role": "user", "content": "\n".join(lines).strip()},
            ],
            "tools": [NOVELTY_REVIEW_TOOL],
            "tool_choice": {"type": "function", "function": {"name": "submit_review"}},
        },
        timeout=300,
    )
    if response is None:
        raise RuntimeError("LLM novelty review returned no response")

    payload = response.json()
    parsed = extract_tool_arguments(payload, "submit_review")
    reviews = parsed.get("reviews", [])
    if not isinstance(reviews, list):
        return []

    by_thought = {}
    for item in reviews:
        if not isinstance(item, dict):
            continue
        thought = normalize_text(item.get("thought", ""))
        decision = normalize_text(item.get("decision", "")).lower()
        reason = normalize_text(item.get("reason", ""))
        if thought not in candidate_thoughts:
            continue
        if decision not in {"record", "duplicate", "uncertain"}:
            continue
        by_thought[thought] = {
            "thought": thought,
            "decision": decision,
            "reason": reason,
        }

    ordered = []
    for thought in candidate_thoughts:
        ordered.append(by_thought.get(thought, {
            "thought": thought,
            "decision": "uncertain",
            "reason": "Novelty review did not return a usable decision.",
        }))
    return ordered


def ingest_row(base_url: str, access_key: str, payload: dict):
    response = requests.post(
        f"{base_url.rstrip('/')}/ingest/thought",
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


def build_text_source_payload(message: dict, text: str):
    chat = message["chat"]
    from_user = message.get("from") or {}
    chat_id = str(chat["id"])
    message_id = message["message_id"]
    occurred_at = datetime.fromtimestamp(message["date"], tz=timezone.utc).isoformat()
    dedupe_key = f"telegram:{chat_id}:{message_id}"
    username = from_user.get("username")

    metadata = {
        "source": "telegram",
        "type": "telegram_message",
        "retrieval_role": "source",
        "summary": truncate_text(text, 120),
        "topics": ["telegram", "capture"],
        "telegram_update_id": message.get("_ob1_update_id"),
        "telegram_chat_id": chat_id,
        "telegram_chat_type": chat.get("type"),
        "telegram_message_id": message_id,
        "telegram_user_id": from_user.get("id"),
        "telegram_username": username,
        "telegram_message_date": occurred_at,
        "telegram_media_type": "text",
        "full_text": text,
    }

    return {
        "content": text,
        "metadata": metadata,
        "source": "telegram",
        "type": "telegram_message",
        "tags": ["telegram", "capture"],
        "occurred_at": occurred_at,
        "dedupe_key": dedupe_key,
        "extract_metadata": False,
    }


def build_text_thought_payload(message: dict, thought: str, source_dedupe_key: str, index: int):
    chat = message["chat"]
    from_user = message.get("from") or {}
    occurred_at = datetime.fromtimestamp(message["date"], tz=timezone.utc).isoformat()

    metadata = {
        "source": "telegram",
        "type": "telegram_thought",
        "retrieval_role": "distilled",
        "summary": truncate_text(thought, 120),
        "topics": ["telegram"],
        "telegram_chat_id": str(chat["id"]),
        "telegram_message_id": message["message_id"],
        "telegram_user_id": from_user.get("id"),
        "telegram_username": from_user.get("username"),
        "source_dedupe_key": source_dedupe_key,
    }

    return {
        "content": thought,
        "metadata": metadata,
        "source": "telegram",
        "type": "telegram_thought",
        "tags": ["telegram"],
        "occurred_at": occurred_at,
        "dedupe_key": f"{source_dedupe_key}:thought:{index}",
        "extract_metadata": False,
    }


def message_text(message: dict) -> str | None:
    text = message.get("text")
    if not isinstance(text, str):
        return None
    cleaned = text.strip()
    if not cleaned or cleaned.startswith("/"):
        return None
    return cleaned


def ingest_text_capture(args, source_payload: dict, thought_payloads: list[dict]):
    ingest_row(args.base_url, args.access_key, source_payload)
    for payload in thought_payloads:
        ingest_row(args.base_url, args.access_key, payload)


def register_review_session(args, message: dict, session: dict):
    if args.dry_run:
        return "dry-run"
    token = pending_action_token()
    prompt_result = None

    if args.telegram_token:
        prompt_result = send_action_prompt(
            args.telegram_token,
            str(message["chat"]["id"]),
            message["message_id"],
            render_review_text(session),
            reply_markup=build_review_reply_markup(session, token),
        )
    if isinstance(prompt_result, dict):
        session["review_message_id"] = prompt_result.get("message_id")

    with locked_review_state(args.review_state_file) as review_state:
        review_state.setdefault("pending_actions", {})[token] = session
    return token


def refresh_review_message(args, token: str, session: dict):
    review_message_id = session.get("review_message_id")
    if not args.telegram_token or not review_message_id or args.dry_run:
        return
    edit_message(
        args.telegram_token,
        str(session.get("chat_id")),
        int(review_message_id),
        render_review_text(session),
        reply_markup=build_review_reply_markup(session, token),
    )


def send_review_raw_source(args, session: dict):
    if not args.telegram_token or args.dry_run:
        return
    raw_text = (session.get("source_text") or "").strip()
    if not raw_text:
        raw_text = "(Raw source text was empty.)"
    suffix = ""
    if len(raw_text) > MAX_RAW_MESSAGE_CHARS:
        raw_text = raw_text[:MAX_RAW_MESSAGE_CHARS].rstrip()
        suffix = "\n\n[truncated]"
    label = "Raw voice transcript" if session.get("origin") == "telegram_dictation" else "Raw Telegram message"
    reply_target = session.get("review_message_id") or session.get("message_id")
    send_reply(
        args.telegram_token,
        str(session.get("chat_id")),
        int(reply_target),
        f"{label}:\n\n{raw_text}{suffix}",
    )


def prompt_for_thought_edit(args, review_state: dict, token: str, session: dict, thought_index: int):
    if thought_index < 0 or thought_index >= len(session.get("thoughts", [])):
        return False
    if not args.telegram_token or args.dry_run:
        return False
    reply_target = session.get("review_message_id") or session.get("message_id")
    prompt_result = send_reply(
        args.telegram_token,
        str(session.get("chat_id")),
        int(reply_target),
        f"Send the replacement text for thought {thought_index + 1} as a reply to this message.",
    )
    if not isinstance(prompt_result, dict) or prompt_result.get("message_id") is None:
        return False
    start_edit_prompt(review_state, token, thought_index, int(prompt_result["message_id"]))
    return True


def message_audio_descriptor(message: dict):
    if isinstance(message.get("voice"), dict):
        voice = message["voice"]
        return {
            "media_type": "voice",
            "file_id": voice.get("file_id"),
            "file_unique_id": voice.get("file_unique_id"),
            "duration": voice.get("duration"),
            "mime_type": voice.get("mime_type") or "audio/ogg",
            "file_name": None,
        }
    if isinstance(message.get("audio"), dict):
        audio = message["audio"]
        return {
            "media_type": "audio",
            "file_id": audio.get("file_id"),
            "file_unique_id": audio.get("file_unique_id"),
            "duration": audio.get("duration"),
            "mime_type": audio.get("mime_type") or "audio/mpeg",
            "file_name": audio.get("file_name"),
        }
    return None


def file_extension(file_name: str | None, mime_type: str | None, file_path: str | None):
    if file_name:
        suffix = Path(file_name).suffix
        if suffix:
            return suffix
    if file_path:
        suffix = Path(file_path).suffix
        if suffix:
            return suffix
    guessed = mimetypes.guess_extension(mime_type or "")
    return guessed or ".bin"


def upload_audio_object(args, message: dict, descriptor: dict, file_bytes: bytes, file_path: str | None):
    chat = message["chat"]
    chat_id = str(chat["id"])
    message_id = message["message_id"]
    message_date = datetime.fromtimestamp(message["date"], tz=timezone.utc)
    extension = file_extension(descriptor.get("file_name"), descriptor.get("mime_type"), file_path)
    object_key = (
        f"telegram/{message_date:%Y/%m/%d}/"
        f"{chat_id}/{message_id}-{descriptor.get('file_unique_id') or descriptor.get('file_id')}{extension}"
    )

    client = minio_client(args)
    if args.ensure_bucket:
        ensure_bucket(client, args.raw_bucket)
    client.put_object(
        args.raw_bucket,
        object_key,
        io.BytesIO(file_bytes),
        length=len(file_bytes),
        content_type=descriptor.get("mime_type") or "application/octet-stream",
    )
    return object_key


def submit_dictation_object(args, message: dict, descriptor: dict, object_key: str, file_sha256: str, file_name: str | None):
    chat = message["chat"]
    from_user = message.get("from") or {}
    occurred_at = datetime.fromtimestamp(message["date"], tz=timezone.utc).isoformat()
    payload = {
        "storage_backend": "minio",
        "bucket": args.raw_bucket,
        "object_key": object_key,
        "audio_sha256": file_sha256,
        "content_type": descriptor.get("mime_type"),
        "audio_filename": file_name,
        "cleanup_mode": args.cleanup_mode,
        "capture_channel": "telegram",
        "caption": message.get("caption"),
        "telegram": {
            "chat_id": str(chat["id"]),
            "chat_type": chat.get("type"),
            "message_id": message["message_id"],
            "user_id": from_user.get("id"),
            "username": from_user.get("username"),
            "message_date": occurred_at,
            "media_type": descriptor.get("media_type"),
            "file_id": descriptor.get("file_id"),
            "file_unique_id": descriptor.get("file_unique_id"),
        },
    }
    response = requests.post(
        args.dictation_submit_url,
        headers={
            "Content-Type": "application/json",
            "x-access-key": args.dictation_access_key,
            "Authorization": f"Bearer {args.dictation_access_key}",
        },
        json=payload,
        timeout=300,
    )
    body_text = response.text
    if response.status_code not in (200, 201, 202):
        raise RuntimeError(f"{response.status_code} {response.reason}: {body_text}")
    try:
        return response.json()
    except ValueError:
        return {"raw_response": body_text}


def process_text_message(args, state: dict, message: dict):
    text = message_text(message)
    if not text:
        return {"handled": False, "reason": "no_text"}

    source_payload = build_text_source_payload(message, text)
    summary = summarize_text_message(text, truncate_text(text, 80), args.llm_model)
    thoughts = summary.get("thoughts", [])
    ignored_reason = summary.get("reason") or "It does not look like a durable memory worth storing automatically."
    thought_payloads = [
        build_text_thought_payload(message, thought, source_payload["dedupe_key"], index)
        for index, thought in enumerate(thoughts)
    ]

    if not thoughts:
        session = build_review_session(
            origin="telegram_text",
            kind="no_durable_thought",
            chat_id=str(message["chat"]["id"]),
            message_id=message["message_id"],
            source_payload=source_payload,
            thought_payloads=[],
            prompt_text=(
                "I did not auto-record this.\n\n"
                f"Reason: {ignored_reason}\n\n"
                "Record the raw message anyway, ignore it, or view the raw source?"
            ),
            mode=args.review_mode,
        )
        token = register_review_session(
            args,
            message,
            session,
        )
        return {
            "handled": True,
            "path": "text",
            "decision": "review_required",
            "review_kind": "no_durable_thought",
            "action_token": token,
            "reason": ignored_reason,
            "thought_count": 0,
            "source_dedupe_key": source_payload["dedupe_key"],
        }

    similar_matches = {}
    novelty_reviews = []
    if not args.dry_run:
        similar_matches = lookup_similar_thoughts(
            args.base_url,
            args.access_key,
            thoughts,
            match_threshold=args.review_match_threshold,
            match_count=args.review_match_count,
        )
        novelty_reviews = review_thought_novelty(thoughts, similar_matches, args.llm_model)
    else:
        novelty_reviews = [{"thought": thought, "decision": "record", "reason": "dry-run"} for thought in thoughts]

    review_by_thought = {item["thought"]: item for item in novelty_reviews}
    suggested_decisions = {item["thought"]: item.get("decision", "") for item in novelty_reviews}
    approved_payloads = []
    duplicate_count = 0
    uncertain_count = 0
    for payload in thought_payloads:
        decision = review_by_thought.get(payload["content"], {}).get("decision", "uncertain")
        if decision == "record":
            approved_payloads.append(payload)
        elif decision == "duplicate":
            duplicate_count += 1
        else:
            uncertain_count += 1

    if args.review_mode == REVIEW_MODE_FULL:
        session = build_review_session(
            origin="telegram_text",
            kind="review",
            chat_id=str(message["chat"]["id"]),
            message_id=message["message_id"],
            source_payload=source_payload,
            thought_payloads=thought_payloads,
            suggested_decisions=suggested_decisions,
            mode=args.review_mode,
        )
        token = register_review_session(args, message, session)
        return {
            "handled": True,
            "path": "text",
            "decision": "review_required",
            "review_kind": "review",
            "action_token": token,
            "thought_count": len(thought_payloads),
            "source_dedupe_key": source_payload["dedupe_key"],
            "duplicate_count": duplicate_count,
            "uncertain_count": uncertain_count,
        }

    if not approved_payloads:
        session = build_review_session(
            origin="telegram_text",
            kind="review",
            chat_id=str(message["chat"]["id"]),
            message_id=message["message_id"],
            source_payload=source_payload,
            thought_payloads=thought_payloads,
            suggested_decisions=suggested_decisions,
            mode=args.review_mode,
        )
        token = register_review_session(args, message, session)
        return {
            "handled": True,
            "path": "text",
            "decision": "review_required",
            "review_kind": "review",
            "action_token": token,
            "thought_count": len(thought_payloads),
            "source_dedupe_key": source_payload["dedupe_key"],
            "duplicate_count": duplicate_count,
            "uncertain_count": uncertain_count,
        }

    if not args.dry_run:
        ingest_text_capture(args, source_payload, approved_payloads)

    if args.telegram_token and not args.dry_run:
        status = f"Thought recorded. Stored 1 source row and {len(approved_payloads)} thought rows."
        skipped = []
        if duplicate_count:
            skipped.append(f"{duplicate_count} duplicate")
        if uncertain_count:
            skipped.append(f"{uncertain_count} uncertain")
        if skipped:
            status += f" Skipped {', '.join(skipped)}."
        send_reply(
            args.telegram_token,
            str(message["chat"]["id"]),
            message["message_id"],
            status,
        )

    return {
        "handled": True,
        "path": "text",
        "decision": "recorded",
        "thought_count": len(approved_payloads),
        "source_dedupe_key": source_payload["dedupe_key"],
        "duplicate_count": duplicate_count,
        "uncertain_count": uncertain_count,
    }


def process_audio_message(args, message: dict):
    descriptor = message_audio_descriptor(message)
    if not descriptor or not descriptor.get("file_id"):
        return {"handled": False, "reason": "no_audio"}

    file_info = {"file_path": None}
    file_bytes = b""
    file_name = descriptor.get("file_name")
    file_sha = "dry-run"
    object_key = None
    submission = None

    if not args.dry_run:
        file_info = get_file_info(args.telegram_token, descriptor["file_id"])
        file_path = file_info.get("file_path")
        if not file_path:
            raise RuntimeError("Telegram getFile did not return file_path")
        file_bytes = download_file_bytes(args.telegram_token, file_path)
        file_sha = hashlib.sha256(file_bytes).hexdigest()
        file_name = file_name or Path(file_path).name
        object_key = upload_audio_object(args, message, descriptor, file_bytes, file_path)
        submission = submit_dictation_object(args, message, descriptor, object_key, file_sha, file_name)

        send_reply(
            args.telegram_token,
            str(message["chat"]["id"]),
            message["message_id"],
            "Accepted audio capture. Uploaded to object storage and queued for transcription.",
        )
    else:
        message_date = datetime.fromtimestamp(message["date"], tz=timezone.utc)
        object_key = (
            f"telegram/{message_date:%Y/%m/%d}/"
            f"{message['chat']['id']}/{message['message_id']}-{descriptor.get('file_unique_id') or descriptor.get('file_id')}.dry"
        )

    return {
        "handled": True,
        "path": "audio",
        "media_type": descriptor.get("media_type"),
        "object_key": object_key,
        "submission": submission,
    }


def process_edit_reply_message(args, message: dict):
    text = message_text(message)
    if not text:
        return None
    chat = message.get("chat") or {}
    reply_to = message.get("reply_to_message") or {}
    reply_to_message_id = reply_to.get("message_id")
    chat_id = str(chat.get("id"))
    with locked_review_state(args.review_state_file) as review_state:
        prune_pending_actions(review_state, args.pending_action_ttl_seconds)
        token, session = find_edit_session(review_state, chat_id, reply_to_message_id)
        if not token or not isinstance(session, dict):
            return None
        if not apply_edit_reply(session, text):
            return {"handled": True, "path": "edit_reply", "reason": "invalid_edit_reply"}
        refresh_review_message(args, token, session)

    if args.telegram_token and not args.dry_run:
        send_reply(
            args.telegram_token,
            chat_id,
            message["message_id"],
            "Updated the thought. Press Commit when ready.",
        )
    return {
        "handled": True,
        "path": "edit_reply",
        "decision": "edited",
        "telegram_message_id": message.get("message_id"),
    }


def process_callback_query(args, state: dict, callback_query: dict):
    callback_id = callback_query.get("id")
    data = callback_query.get("data") or ""
    from_user = callback_query.get("from") or {}
    message = callback_query.get("message") or {}
    chat = message.get("chat") or {}
    chat_id = str(chat.get("id"))

    if args.allowed_chat_ids and chat_id not in args.allowed_chat_ids:
        if args.telegram_token and callback_id:
            answer_callback_query(args.telegram_token, callback_id, "This chat is not allowed.")
        return {"handled": False, "reason": "chat_not_allowed"}

    parsed = parse_callback_data(data)
    if not parsed:
        if args.telegram_token and callback_id:
            answer_callback_query(args.telegram_token, callback_id, "Unknown action.")
        return {"handled": False, "reason": "unknown_callback"}

    action = parsed["action"]
    token = parsed["token"]
    thought_index = parsed["index"]
    with locked_review_state(args.review_state_file) as review_state:
        prune_pending_actions(review_state, args.pending_action_ttl_seconds)
        pending = review_state.setdefault("pending_actions", {}).get(token)
        if not pending:
            if args.telegram_token and callback_id:
                answer_callback_query(args.telegram_token, callback_id, "This review prompt expired.")
            return {"handled": False, "reason": "missing_pending_action"}

        if str(pending.get("chat_id")) != chat_id:
            if args.telegram_token and callback_id:
                answer_callback_query(args.telegram_token, callback_id, "This review prompt belongs to a different chat.")
            return {"handled": False, "reason": "chat_mismatch"}

        source_payload = pending.get("source_payload") or {}
        review_message_id = pending.get("review_message_id")
        kind = pending.get("kind") or "review"
        thoughts = pending.get("thoughts") or []

        if action == "view_raw":
            send_review_raw_source(args, pending)
            if args.telegram_token and callback_id:
                answer_callback_query(args.telegram_token, callback_id, "Sent raw source.")
            return {
                "handled": True,
                "path": "callback",
                "decision": "view_raw",
                "review_kind": kind,
                "telegram_user_id": from_user.get("id"),
            }

        if not review_session_has_thoughts(pending):
            if action not in {"record", "ignore"}:
                if args.telegram_token and callback_id:
                    answer_callback_query(args.telegram_token, callback_id, "Use Record or Ignore for this prompt.")
                return {"handled": False, "reason": "invalid_simple_review_action"}
            if action == "record" and not args.dry_run:
                ingest_text_capture(args, source_payload, [])
                record_resolution(review_state, token, pending, DICTATION_RESOLUTION_INGESTED)
            elif action == "ignore":
                record_resolution(review_state, token, pending, DICTATION_RESOLUTION_IGNORED)
            if args.telegram_token and callback_id:
                answer_callback_query(
                    args.telegram_token,
                    callback_id,
                    "Recorded." if action == "record" else "Ignored.",
                )
            if args.telegram_token and review_message_id and not args.dry_run:
                final_text = (
                    "Recorded by request. Stored 1 source row and 0 thought rows."
                    if action == "record"
                    else f"Ignored. Nothing was stored from this {kind.replace('_', ' ')} capture."
                )
                edit_message(args.telegram_token, chat_id, int(review_message_id), final_text)
            review_state.setdefault("pending_actions", {}).pop(token, None)
            return {
                "handled": True,
                "path": "callback",
                "decision": action,
                "review_kind": kind,
                "source_dedupe_key": source_payload.get("dedupe_key"),
                "thought_count": 0,
                "telegram_user_id": from_user.get("id"),
            }

        if action == "approve":
            if thought_index is None or thought_index >= len(thoughts):
                return {"handled": False, "reason": "invalid_thought_index"}
            thoughts[thought_index]["status"] = THOUGHT_STATUS_APPROVED
            refresh_review_message(args, token, pending)
            if args.telegram_token and callback_id:
                answer_callback_query(args.telegram_token, callback_id, f"Approved thought {thought_index + 1}.")
            return {
                "handled": True,
                "path": "callback",
                "decision": "approved",
                "review_kind": kind,
                "source_dedupe_key": source_payload.get("dedupe_key"),
                "thought_count": len(thoughts),
                "telegram_user_id": from_user.get("id"),
            }

        if action == "deny":
            if thought_index is None or thought_index >= len(thoughts):
                return {"handled": False, "reason": "invalid_thought_index"}
            thoughts[thought_index]["status"] = THOUGHT_STATUS_DENIED
            refresh_review_message(args, token, pending)
            if args.telegram_token and callback_id:
                answer_callback_query(args.telegram_token, callback_id, f"Denied thought {thought_index + 1}.")
            return {
                "handled": True,
                "path": "callback",
                "decision": "denied",
                "review_kind": kind,
                "source_dedupe_key": source_payload.get("dedupe_key"),
                "thought_count": len(thoughts),
                "telegram_user_id": from_user.get("id"),
            }

        if action == "approve_all":
            for thought in thoughts:
                if thought.get("status") != "edited":
                    thought["status"] = THOUGHT_STATUS_APPROVED
            refresh_review_message(args, token, pending)
            if args.telegram_token and callback_id:
                answer_callback_query(args.telegram_token, callback_id, "Approved all thoughts.")
            return {
                "handled": True,
                "path": "callback",
                "decision": "approved_all",
                "review_kind": kind,
                "source_dedupe_key": source_payload.get("dedupe_key"),
                "thought_count": len(thoughts),
                "telegram_user_id": from_user.get("id"),
            }

        if action == "edit":
            if thought_index is None or thought_index >= len(thoughts):
                return {"handled": False, "reason": "invalid_thought_index"}
            if not prompt_for_thought_edit(args, review_state, token, pending, thought_index):
                return {"handled": False, "reason": "edit_prompt_failed"}
            if args.telegram_token and callback_id:
                answer_callback_query(args.telegram_token, callback_id, "Reply to the edit prompt with the replacement text.")
            return {
                "handled": True,
                "path": "callback",
                "decision": "edit_requested",
                "review_kind": kind,
                "source_dedupe_key": source_payload.get("dedupe_key"),
                "thought_count": len(thoughts),
                "telegram_user_id": from_user.get("id"),
            }

        if action == "commit":
            final_thoughts = approved_session_payloads(pending)
            if not final_thoughts:
                if args.telegram_token and callback_id:
                    answer_callback_query(args.telegram_token, callback_id, "No approved thoughts to commit.")
                return {"handled": True, "path": "callback", "decision": "commit_blocked", "reason": "no_approved_thoughts"}
            if not args.dry_run:
                ingest_text_capture(args, source_payload, final_thoughts)
                record_resolution(review_state, token, pending, DICTATION_RESOLUTION_INGESTED)
            if args.telegram_token and callback_id:
                answer_callback_query(args.telegram_token, callback_id, "Recorded.")
            if args.telegram_token and review_message_id and not args.dry_run:
                edit_message(
                    args.telegram_token,
                    chat_id,
                    int(review_message_id),
                    f"Recorded by request. Stored 1 source row and {len(final_thoughts)} thought rows.",
                    reply_markup={"inline_keyboard": []},
                )
            review_state.setdefault("pending_actions", {}).pop(token, None)
            return {
                "handled": True,
                "path": "callback",
                "decision": "commit",
                "review_kind": kind,
                "source_dedupe_key": source_payload.get("dedupe_key"),
                "thought_count": len(final_thoughts),
                "telegram_user_id": from_user.get("id"),
            }

        if action == "deny_all":
            record_resolution(review_state, token, pending, DICTATION_RESOLUTION_IGNORED)
            if args.telegram_token and callback_id:
                answer_callback_query(args.telegram_token, callback_id, "Ignored.")
            if args.telegram_token and review_message_id and not args.dry_run:
                edit_message(
                    args.telegram_token,
                    chat_id,
                    int(review_message_id),
                    f"Ignored. Nothing was stored from this {kind.replace('_', ' ')} capture.",
                    reply_markup={"inline_keyboard": []},
                )
            review_state.setdefault("pending_actions", {}).pop(token, None)
            return {
                "handled": True,
                "path": "callback",
                "decision": "deny_all",
                "review_kind": kind,
                "source_dedupe_key": source_payload.get("dedupe_key"),
                "thought_count": len(thoughts),
                "telegram_user_id": from_user.get("id"),
            }

        if args.telegram_token and callback_id:
            answer_callback_query(args.telegram_token, callback_id, "Unknown action.")
        return {"handled": False, "reason": "unknown_review_action"}

    return {"handled": False, "reason": "callback_fell_through"}


def process_message(args, state: dict, message: dict):
    chat = message.get("chat") or {}
    chat_id = str(chat.get("id"))
    if chat.get("type") != "private":
        return {"handled": False, "reason": "non_private_chat"}
    if args.allowed_chat_ids and chat_id not in args.allowed_chat_ids:
        return {"handled": False, "reason": "chat_not_allowed"}

    if message_text(message):
        edit_result = process_edit_reply_message(args, message)
        if edit_result:
            return edit_result
        return process_text_message(args, state, message)
    if message_audio_descriptor(message):
        return process_audio_message(args, message)
    if args.telegram_token and not args.dry_run:
        send_reply(args.telegram_token, chat_id, message["message_id"], "Unsupported message type for capture.")
    return {"handled": False, "reason": "unsupported_message"}


def iter_updates(args, state):
    if args.update_file:
        payload = json.loads(Path(args.update_file).read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            payload = [payload]
        return payload

    updates = get_updates(args.telegram_token, state.get("offset", 0), args.poll_timeout)
    if args.max_updates:
        return updates[: args.max_updates]
    return updates


def run_once(args, state):
    with locked_review_state(args.review_state_file) as review_state:
        prune_pending_actions(review_state, args.pending_action_ttl_seconds)
    handled = 0
    skipped = 0
    for update in iter_updates(args, state):
        if not isinstance(update, dict):
            continue
        update_id = update.get("update_id")
        message = update.get("message")
        callback_query = update.get("callback_query")

        if isinstance(message, dict):
            message["_ob1_update_id"] = update_id
            result = process_message(args, state, message)
        elif isinstance(callback_query, dict):
            result = process_callback_query(args, state, callback_query)
        else:
            skipped += 1
            if update_id is not None:
                state["offset"] = max(int(state.get("offset", 0)), int(update_id) + 1)
            continue
        if result.get("handled"):
            handled += 1
        else:
            skipped += 1
        if args.verbose:
            print(json.dumps({"update_id": update_id, **result}, ensure_ascii=False))
        if update_id is not None:
            state["offset"] = max(int(state.get("offset", 0)), int(update_id) + 1)

    state["updated_at"] = datetime.now(timezone.utc).isoformat()
    save_state(args.state_file, state)
    return {"handled": handled, "skipped": skipped, "offset": state.get("offset", 0)}


def main():
    args = parse_args()
    state = load_state(args.state_file)

    if args.update_file or args.once:
        result = run_once(args, state)
        print(json.dumps(result, indent=2))
        return 0

    while True:
        try:
            result = run_once(args, state)
            if args.verbose and result["handled"] == 0 and result["skipped"] == 0:
                print("No new Telegram updates.")
        except KeyboardInterrupt:
            return 0
        except Exception as exc:
            if args.verbose:
                print(f"Telegram bridge error: {exc}", file=sys.stderr)
            time.sleep(5)


if __name__ == "__main__":
    raise SystemExit(main())
