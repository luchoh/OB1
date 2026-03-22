#!/usr/bin/env python3
"""
Open Brain — Dictation Artifact Importer

Consumes canonical dictation markdown artifacts and ingests them into the
local OB1 runtime as source rows plus distilled dictation thoughts.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import requests
import yaml
from minio import Minio

from recipes.shared_docling import (
    extract_tool_arguments,
    http_post_with_retry,
    local_llm_base_url,
    sha256_text,
    truncate_text,
)
from recipes.shared_telegram_review_state import (
    default_review_state_path,
    locked_review_state,
    pending_action_token,
    prune_pending_actions,
)


RECIPE_DIR = Path(__file__).resolve().parent
DEFAULT_SYNC_LOG_PATH = Path(os.environ.get("DICTATION_SYNC_LOG_FILE") or (RECIPE_DIR / "dictation-sync-log.json"))
SYNC_SCHEMA_VERSION = 1

DEFAULT_BASE_URL = (os.environ.get("OPEN_BRAIN_BASE_URL") or f"http://127.0.0.1:{os.environ.get('OPEN_BRAIN_PORT', '8787')}").rstrip("/")
DEFAULT_ACCESS_KEY = os.environ.get("MCP_ACCESS_KEY") or os.environ.get("OPEN_BRAIN_ACCESS_KEY") or ""
DEFAULT_LLM_MODEL = os.environ.get("LLM_MODEL", "mlx-community/Qwen3.5-397B-A17B-nvfp4")
DEFAULT_BUCKET = os.environ.get("DICTATION_MINIO_BUCKET") or "dictation-artifacts"
DEFAULT_PREFIX = os.environ.get("DICTATION_MINIO_PREFIX") or "canonical/"
DEFAULT_MINIO_ENDPOINT = os.environ.get("MINIO_ENDPOINT") or os.environ.get("DICTATION_MINIO_ENDPOINT") or ""
DEFAULT_MINIO_ACCESS_KEY = os.environ.get("MINIO_ACCESS_KEY") or os.environ.get("DICTATION_MINIO_ACCESS_KEY") or ""
DEFAULT_MINIO_SECRET_KEY = os.environ.get("MINIO_SECRET_KEY") or os.environ.get("DICTATION_MINIO_SECRET_KEY") or ""
DEFAULT_MINIO_SECURE = (os.environ.get("MINIO_SECURE") or os.environ.get("DICTATION_MINIO_SECURE") or "true").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
DEFAULT_LLM_ENABLE_THINKING = os.environ.get("LLM_ENABLE_THINKING", "false").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
DEFAULT_TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN") or ""
DEFAULT_TELEGRAM_REVIEW_MATCH_THRESHOLD = float(os.environ.get("TELEGRAM_REVIEW_MATCH_THRESHOLD", "0.78"))
DEFAULT_TELEGRAM_REVIEW_MATCH_COUNT = int(os.environ.get("TELEGRAM_REVIEW_MATCH_COUNT", "3"))
DEFAULT_TELEGRAM_PENDING_ACTION_TTL_SECONDS = int(os.environ.get("TELEGRAM_PENDING_ACTION_TTL_SECONDS", "86400"))
DEFAULT_TELEGRAM_REVIEW_STATE_PATH = default_review_state_path(RECIPE_DIR / "telegram-review-state.json")

THOUGHTS_TOOL = {
    "type": "function",
    "function": {
        "name": "submit_thoughts",
        "description": "Return durable thoughts worth storing from this dictation note.",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "required": ["thoughts"],
            "properties": {
                "thoughts": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Up to 3 standalone dictation thoughts.",
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

DICTATION_THOUGHT_PROMPT = """\
You are turning a dictated note into durable memory items for a personal knowledge base.

Capture only information worth finding later:
- decisions, plans, tasks, commitments, constraints
- preferences, observations, or unresolved questions
- concrete names, systems, places, devices, or projects

Skip:
- filler language
- repeated phrasing from speech
- empty journaling with no durable value

Each thought must:
- stand alone without the original transcript open
- stay faithful to the dictated note
- be concrete and scoped
- be 1-3 sentences

Return a JSON object with exactly one key: "thoughts".
You may also include an optional "reason" string.
The value must be an array of 0-3 real thought strings.
If the note has no durable value, return {"thoughts": [], "reason": "<short explanation>"}.
"""

DICTATION_NOVELTY_PROMPT = """\
You are reviewing candidate memory thoughts from a Telegram-origin dictation transcript before they are stored automatically.

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
    parser = argparse.ArgumentParser(description="Import canonical dictation artifacts from MinIO or local files into OB1.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="Open Brain runtime base URL.")
    parser.add_argument("--access-key", default=DEFAULT_ACCESS_KEY, help="Open Brain ingest access key.")
    parser.add_argument("--bucket", default=DEFAULT_BUCKET, help="MinIO bucket containing canonical dictation artifacts.")
    parser.add_argument("--prefix", default=DEFAULT_PREFIX, help="MinIO key prefix to scan.")
    parser.add_argument("--minio-endpoint", default=DEFAULT_MINIO_ENDPOINT, help="MinIO endpoint host:port.")
    parser.add_argument("--minio-access-key", default=DEFAULT_MINIO_ACCESS_KEY, help="MinIO access key.")
    parser.add_argument("--minio-secret-key", default=DEFAULT_MINIO_SECRET_KEY, help="MinIO secret key.")
    parser.add_argument("--minio-secure", action=argparse.BooleanOptionalAction, default=DEFAULT_MINIO_SECURE, help="Use HTTPS for MinIO.")
    parser.add_argument("--llm-model", default=DEFAULT_LLM_MODEL, help="Local summarizer model.")
    parser.add_argument("--object-key", action="append", default=[], help="Specific object key to import. May be repeated.")
    parser.add_argument("--artifact-file", action="append", default=[], help="Local artifact file to import for testing. May be repeated.")
    parser.add_argument("--limit", type=int, default=0, help="Optional max artifact count.")
    parser.add_argument("--poll", action="store_true", help="Continuously poll MinIO for new artifacts.")
    parser.add_argument("--poll-interval", type=int, default=30, help="Polling interval in seconds.")
    parser.add_argument("--sync-log-file", default=str(DEFAULT_SYNC_LOG_PATH), help="Path to importer sync state JSON.")
    parser.add_argument("--telegram-bot-token", default=DEFAULT_TELEGRAM_BOT_TOKEN, help="Telegram bot token for review prompts on Telegram-origin transcripts.")
    parser.add_argument("--telegram-review-match-threshold", type=float, default=DEFAULT_TELEGRAM_REVIEW_MATCH_THRESHOLD, help="Similarity threshold for Telegram transcript novelty review.")
    parser.add_argument("--telegram-review-match-count", type=int, default=DEFAULT_TELEGRAM_REVIEW_MATCH_COUNT, help="Max similar rows per candidate for Telegram transcript novelty review.")
    parser.add_argument("--telegram-pending-action-ttl-seconds", type=int, default=DEFAULT_TELEGRAM_PENDING_ACTION_TTL_SECONDS, help="How long Telegram review prompts remain actionable.")
    parser.add_argument("--telegram-review-state-file", default=str(DEFAULT_TELEGRAM_REVIEW_STATE_PATH), help="Path to shared Telegram review-state JSON.")
    parser.add_argument("--dry-run", action="store_true", help="Parse and report without ingesting.")
    parser.add_argument("--verbose", action="store_true", help="Print per-artifact progress.")
    args = parser.parse_args()
    args.sync_log_file = Path(args.sync_log_file)
    args.telegram_review_state_file = Path(args.telegram_review_state_file)

    if not args.dry_run and not args.access_key:
        parser.error("Missing access key. Set MCP_ACCESS_KEY or pass --access-key.")

    if not args.artifact_file and not args.object_key and not args.minio_endpoint:
        parser.error("Provide --artifact-file, --object-key, or MinIO connection details.")

    if args.object_key and not args.minio_endpoint:
        parser.error("--object-key requires MinIO connection details.")

    return args


def load_sync_log(path: Path):
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"schema_version": SYNC_SCHEMA_VERSION, "processed": {}}

    if not isinstance(payload, dict):
        return {"schema_version": SYNC_SCHEMA_VERSION, "processed": {}}
    payload.setdefault("schema_version", SYNC_SCHEMA_VERSION)
    payload.setdefault("processed", {})
    return payload


def save_sync_log(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)


def minio_client(args):
    return Minio(
        args.minio_endpoint,
        access_key=args.minio_access_key,
        secret_key=args.minio_secret_key,
        secure=args.minio_secure,
    )


def list_candidate_objects(client: Minio, bucket: str, prefix: str) -> Iterable[str]:
    for entry in client.list_objects(bucket, prefix=prefix, recursive=True):
        if entry.object_name.endswith(".md"):
            yield entry.object_name


def read_minio_text(client: Minio, bucket: str, object_key: str) -> str:
    response = client.get_object(bucket, object_key)
    try:
        return response.read().decode("utf-8")
    finally:
        response.close()
        response.release_conn()


FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", re.DOTALL)


def parse_markdown_artifact(text: str):
    match = FRONTMATTER_RE.match(text)
    if not match:
        raise ValueError("Artifact did not contain YAML frontmatter.")

    frontmatter_text, body = match.groups()
    metadata = yaml.safe_load(frontmatter_text) or {}
    if not isinstance(metadata, dict):
        raise ValueError("Frontmatter did not parse to an object.")
    return metadata, body.strip()


def normalize_optional_string(value):
    if value is None:
        return None
    if isinstance(value, str):
        trimmed = value.strip()
        if not trimmed or trimmed.lower() in {"null", "none"}:
            return None
        return trimmed
    return str(value)


def derive_source_dedupe_key(metadata):
    audio_sha256 = normalize_optional_string(metadata.get("audio_sha256"))
    artifact_id = normalize_optional_string(metadata.get("artifact_id"))
    source_host = normalize_optional_string(metadata.get("source_host")) or "unknown"
    created_at = normalize_optional_string(metadata.get("created_at")) or "unknown"
    cleaned_text_hash = normalize_optional_string(metadata.get("cleaned_text_hash")) or "unknown"

    if audio_sha256:
        return f"dictation:{audio_sha256}"
    if artifact_id:
        return f"dictation:{artifact_id}"
    return f"dictation:{source_host}:{created_at}:{cleaned_text_hash}"


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


def summarize_dictation(body_text: str, metadata: dict, llm_model: str):
    context = [
        f"Title: {normalize_optional_string(metadata.get('title')) or '(untitled)'}",
        f"Created: {normalize_optional_string(metadata.get('created_at')) or 'unknown'}",
        f"Cleanup mode: {normalize_optional_string(metadata.get('cleanup_mode')) or 'unknown'}",
        f"Source host: {normalize_optional_string(metadata.get('source_host')) or 'unknown'}",
        f"Language: {normalize_optional_string(metadata.get('language')) or 'unknown'}",
        "",
        "Dictation body:",
        body_text or "(empty)",
    ]
    prompt = "\n".join(context)

    response = http_post_with_retry(
        f"{local_llm_base_url()}/chat/completions",
        headers={"Content-Type": "application/json"},
        json_body={
            "model": llm_model,
            "temperature": 0.2,
            "max_tokens": 900,
            "chat_template_kwargs": {"enable_thinking": DEFAULT_LLM_ENABLE_THINKING},
            "messages": [
                {"role": "system", "content": DICTATION_THOUGHT_PROMPT},
                {"role": "user", "content": prompt},
            ],
            "tools": [THOUGHTS_TOOL],
            "tool_choice": {"type": "function", "function": {"name": "submit_thoughts"}},
        },
        timeout=300,
    )

    if response is None:
        raise RuntimeError("LLM request returned no response")

    body = response.json()
    parsed = extract_tool_arguments(body, "submit_thoughts")
    thoughts = parsed.get("thoughts", [])
    reason = normalize_optional_string(parsed.get("reason")) if isinstance(parsed, dict) else None
    if not isinstance(thoughts, list):
        return {"thoughts": [], "reason": reason or "The model did not return usable thought candidates."}

    normalized = []
    seen = set()
    for item in thoughts:
        if not isinstance(item, str):
            continue
        cleaned = re.sub(r"\s+", " ", item).strip()
        if not cleaned:
            continue
        lowered = cleaned.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        normalized.append(cleaned)
        if len(normalized) >= 3:
            break
    return {"thoughts": normalized, "reason": reason}


def telegram_api_call(token: str, method: str, payload: dict | None = None, timeout: int = 60):
    response = requests.post(
        f"https://api.telegram.org/bot{token}/{method}",
        json=payload or {},
        timeout=timeout,
    )
    response.raise_for_status()
    body = response.json()
    if not body.get("ok"):
        raise RuntimeError(f"Telegram {method} failed: {body}")
    return body["result"]


def send_reply(token: str, chat_id: str, reply_to_message_id: int, text: str):
    telegram_api_call(
        token,
        "sendMessage",
        {
            "chat_id": chat_id,
            "reply_to_message_id": reply_to_message_id,
            "text": text,
            "allow_sending_without_reply": True,
        },
    )


def send_action_prompt(token: str, chat_id: str, reply_to_message_id: int, text: str, action_token: str):
    return telegram_api_call(
        token,
        "sendMessage",
        {
            "chat_id": chat_id,
            "reply_to_message_id": reply_to_message_id,
            "text": text,
            "allow_sending_without_reply": True,
            "reply_markup": {
                "inline_keyboard": [[
                    {"text": "Record", "callback_data": f"ob1:record:{action_token}"},
                    {"text": "Ignore", "callback_data": f"ob1:ignore:{action_token}"},
                ]]
            },
        },
    )


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


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
            "chat_template_kwargs": {"enable_thinking": DEFAULT_LLM_ENABLE_THINKING},
            "messages": [
                {"role": "system", "content": DICTATION_NOVELTY_PROMPT},
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


def object_descriptor(source_name: str, identifier: str):
    return f"{source_name}:{identifier}" if identifier else source_name


def build_source_payload(body_text: str, metadata: dict, *, occurred_at: str | None, dedupe_key: str, artifact_ref: dict):
    title = normalize_optional_string(metadata.get("title")) or "Dictation note"
    source_metadata = {
        "source": "dictation",
        "type": "dictation_note",
        "retrieval_role": "source",
        "summary": title,
        "topics": ["dictation", "capture"],
        "artifact_id": normalize_optional_string(metadata.get("artifact_id")),
        "audio_sha256": normalize_optional_string(metadata.get("audio_sha256")),
        "audio_filename": normalize_optional_string(metadata.get("audio_filename")),
        "cleanup_mode": normalize_optional_string(metadata.get("cleanup_mode")),
        "dictation_storage_backend": artifact_ref.get("storage_backend"),
        "dictation_object_key": artifact_ref.get("object_key"),
        "dictation_bucket": artifact_ref.get("bucket"),
        "full_text": body_text,
        **metadata,
    }
    return {
        "content": body_text,
        "metadata": source_metadata,
        "source": "dictation",
        "type": "dictation_note",
        "tags": ["dictation", "capture"],
        "occurred_at": occurred_at,
        "dedupe_key": dedupe_key,
        "extract_metadata": False,
    }


def build_thought_payload(content: str, metadata: dict, *, occurred_at: str | None, source_dedupe_key: str, thought_index: int, artifact_ref: dict):
    thought_dedupe = f"{source_dedupe_key}:thought:{thought_index}"
    thought_metadata = {
        "source": "dictation",
        "type": "dictation_thought",
        "retrieval_role": "distilled",
        "summary": truncate_text(content, 120),
        "topics": ["dictation"],
        "artifact_id": normalize_optional_string(metadata.get("artifact_id")),
        "audio_sha256": normalize_optional_string(metadata.get("audio_sha256")),
        "source_dedupe_key": source_dedupe_key,
        "source_created_at": normalize_optional_string(metadata.get("created_at")),
        "dictation_storage_backend": artifact_ref.get("storage_backend"),
        "dictation_object_key": artifact_ref.get("object_key"),
        "dictation_bucket": artifact_ref.get("bucket"),
    }
    return {
        "content": content,
        "metadata": thought_metadata,
        "source": "dictation",
        "type": "dictation_thought",
        "tags": ["dictation"],
        "occurred_at": occurred_at,
        "dedupe_key": thought_dedupe,
        "extract_metadata": False,
    }


def artifact_processed(log: dict, dedupe_key: str, ref_key: str):
    processed = log.get("processed", {})
    return dedupe_key in processed or ref_key in processed


def mark_processed(log: dict, dedupe_key: str, ref_key: str, metadata: dict, thought_count: int):
    entry = {
        "schema_version": SYNC_SCHEMA_VERSION,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "artifact_id": normalize_optional_string(metadata.get("artifact_id")),
        "audio_sha256": normalize_optional_string(metadata.get("audio_sha256")),
        "title": normalize_optional_string(metadata.get("title")),
        "thought_count": thought_count,
        "status": "ingested",
    }
    processed = log.setdefault("processed", {})
    processed[dedupe_key] = entry
    processed[ref_key] = entry


def mark_review_pending(log: dict, dedupe_key: str, ref_key: str, metadata: dict, thought_count: int, *, review_kind: str, action_token: str):
    entry = {
        "schema_version": SYNC_SCHEMA_VERSION,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "artifact_id": normalize_optional_string(metadata.get("artifact_id")),
        "audio_sha256": normalize_optional_string(metadata.get("audio_sha256")),
        "title": normalize_optional_string(metadata.get("title")),
        "thought_count": thought_count,
        "status": "review_pending",
        "review_kind": review_kind,
        "action_token": action_token,
    }
    processed = log.setdefault("processed", {})
    processed[dedupe_key] = entry
    processed[ref_key] = entry


def is_telegram_capture(metadata: dict) -> bool:
    capture_channel = normalize_optional_string(metadata.get("capture_channel"))
    source = normalize_optional_string(metadata.get("source"))
    return capture_channel == "telegram" or source == "telegram"


def build_review_prompt(reason: str, *, review_kind: str):
    if review_kind == "no_durable_thought":
        return (
            "I did not auto-record this voice transcript.\n\n"
            f"Reason: {reason}\n\n"
            "Record the transcript anyway, or ignore it?"
        )
    if review_kind == "duplicate":
        return "This voice transcript looks like it may already be recorded. Record it anyway or ignore it?"
    return "I am not confident this voice transcript should be recorded automatically. Record it anyway or ignore it?"


def register_telegram_review(args, metadata: dict, *, review_kind: str, prompt_text: str, source_payload: dict, thought_payloads: list[dict]):
    if not args.telegram_bot_token:
        raise RuntimeError("Telegram bot token is required to review Telegram-origin dictation artifacts.")

    chat_id = normalize_optional_string(metadata.get("telegram_chat_id"))
    message_id_raw = metadata.get("telegram_message_id")
    if not chat_id or message_id_raw is None:
        raise RuntimeError("Telegram-origin dictation artifact is missing chat_id/message_id metadata.")

    message_id = int(message_id_raw)
    action_token = pending_action_token()
    prompt_result = send_action_prompt(args.telegram_bot_token, chat_id, message_id, prompt_text, action_token)

    pending_entry = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "kind": review_kind,
        "chat_id": chat_id,
        "message_id": message_id,
        "review_message_id": prompt_result.get("message_id") if isinstance(prompt_result, dict) else None,
        "source_payload": source_payload,
        "thought_payloads": thought_payloads,
    }

    with locked_review_state(args.telegram_review_state_file) as review_state:
        prune_pending_actions(review_state, args.telegram_pending_action_ttl_seconds)
        review_state.setdefault("pending_actions", {})[action_token] = pending_entry

    return action_token


def process_artifact(args, log: dict, *, artifact_text: str, artifact_ref: dict):
    metadata, body_text = parse_markdown_artifact(artifact_text)
    if not body_text:
        raise ValueError("Artifact body was empty.")

    source_dedupe_key = derive_source_dedupe_key(metadata)
    ref_key = object_descriptor(artifact_ref.get("storage_backend", "file"), artifact_ref.get("object_key") or artifact_ref.get("path") or source_dedupe_key)
    if artifact_processed(log, source_dedupe_key, ref_key):
        return {"skipped": True, "dedupe_key": source_dedupe_key, "ref_key": ref_key}

    occurred_at = normalize_optional_string(metadata.get("created_at"))
    source_payload = build_source_payload(
        body_text,
        metadata,
        occurred_at=occurred_at,
        dedupe_key=source_dedupe_key,
        artifact_ref=artifact_ref,
    )
    summary = summarize_dictation(body_text, metadata, args.llm_model)
    thoughts = summary.get("thoughts", [])
    ignored_reason = summary.get("reason") or "It does not look like a durable memory worth storing automatically."
    thought_payloads = [
        build_thought_payload(
            thought,
            metadata,
            occurred_at=occurred_at,
            source_dedupe_key=source_dedupe_key,
            thought_index=index,
            artifact_ref=artifact_ref,
        )
        for index, thought in enumerate(thoughts)
    ]

    duplicate_count = 0
    uncertain_count = 0

    if is_telegram_capture(metadata):
        if not thoughts:
            prompt_text = build_review_prompt(ignored_reason, review_kind="no_durable_thought")
            if args.dry_run:
                action_token = "dry-run"
            else:
                action_token = register_telegram_review(
                    args,
                    metadata,
                    review_kind="no_durable_thought",
                    prompt_text=prompt_text,
                    source_payload=source_payload,
                    thought_payloads=[],
                )
            mark_review_pending(
                log,
                source_dedupe_key,
                ref_key,
                metadata,
                0,
                review_kind="no_durable_thought",
                action_token=action_token,
            )
            return {
                "skipped": False,
                "dry_run": args.dry_run,
                "source_dedupe_key": source_dedupe_key,
                "title": normalize_optional_string(metadata.get("title")),
                "thoughts": [],
                "review_required": True,
                "review_kind": "no_durable_thought",
                "reason": ignored_reason,
            }

        similar_matches = {}
        novelty_reviews = []
        if not args.dry_run:
            similar_matches = lookup_similar_thoughts(
                args.base_url,
                args.access_key,
                thoughts,
                match_threshold=args.telegram_review_match_threshold,
                match_count=args.telegram_review_match_count,
            )
            novelty_reviews = review_thought_novelty(thoughts, similar_matches, args.llm_model)
        else:
            novelty_reviews = [{"thought": thought, "decision": "record", "reason": "dry-run"} for thought in thoughts]

        review_by_thought = {item["thought"]: item for item in novelty_reviews}
        approved_payloads = []
        for payload in thought_payloads:
            decision = review_by_thought.get(payload["content"], {}).get("decision", "uncertain")
            if decision == "record":
                approved_payloads.append(payload)
            elif decision == "duplicate":
                duplicate_count += 1
            else:
                uncertain_count += 1

        if not approved_payloads:
            review_kind = "duplicate" if duplicate_count else "uncertain"
            prompt_text = build_review_prompt("", review_kind=review_kind)
            if args.dry_run:
                action_token = "dry-run"
            else:
                action_token = register_telegram_review(
                    args,
                    metadata,
                    review_kind=review_kind,
                    prompt_text=prompt_text,
                    source_payload=source_payload,
                    thought_payloads=thought_payloads,
                )
            mark_review_pending(
                log,
                source_dedupe_key,
                ref_key,
                metadata,
                len(thought_payloads),
                review_kind=review_kind,
                action_token=action_token,
            )
            return {
                "skipped": False,
                "dry_run": args.dry_run,
                "source_dedupe_key": source_dedupe_key,
                "title": normalize_optional_string(metadata.get("title")),
                "thoughts": thoughts,
                "review_required": True,
                "review_kind": review_kind,
                "duplicate_count": duplicate_count,
                "uncertain_count": uncertain_count,
            }

        thought_payloads = approved_payloads

    if args.dry_run:
        mark_processed(log, source_dedupe_key, ref_key, metadata, len(thought_payloads))
        return {
            "skipped": False,
            "dry_run": True,
            "source_dedupe_key": source_dedupe_key,
            "title": normalize_optional_string(metadata.get("title")),
            "thoughts": thoughts,
        }

    ingest_row(args.base_url, args.access_key, source_payload)
    for payload in thought_payloads:
        ingest_row(args.base_url, args.access_key, payload)

    if is_telegram_capture(metadata) and args.telegram_bot_token:
        chat_id = normalize_optional_string(metadata.get("telegram_chat_id"))
        message_id_raw = metadata.get("telegram_message_id")
        if chat_id and message_id_raw is not None:
            status = f"Thought recorded. Stored 1 source row and {len(thought_payloads)} thought rows."
            skipped = []
            if duplicate_count:
                skipped.append(f"{duplicate_count} duplicate")
            if uncertain_count:
                skipped.append(f"{uncertain_count} uncertain")
            if skipped:
                status += f" Skipped {', '.join(skipped)}."
            send_reply(args.telegram_bot_token, chat_id, int(message_id_raw), status)

    mark_processed(log, source_dedupe_key, ref_key, metadata, len(thought_payloads))
    return {
        "skipped": False,
        "dry_run": False,
        "source_dedupe_key": source_dedupe_key,
        "title": normalize_optional_string(metadata.get("title")),
        "thoughts": thoughts,
    }


def iter_artifacts(args):
    for file_path in args.artifact_file:
        path = Path(file_path)
        yield {
            "storage_backend": "file",
            "path": str(path),
            "object_key": None,
            "bucket": None,
            "text": path.read_text(encoding="utf-8"),
        }

    if not args.minio_endpoint:
        return

    client = minio_client(args)
    object_keys = args.object_key or list(list_candidate_objects(client, args.bucket, args.prefix))
    count = 0
    for object_key in object_keys:
        yield {
            "storage_backend": "minio",
            "path": None,
            "object_key": object_key,
            "bucket": args.bucket,
            "text": read_minio_text(client, args.bucket, object_key),
        }
        count += 1
        if args.limit and count >= args.limit:
            break


def run_once(args, log: dict):
    processed = 0
    skipped = 0
    for artifact in iter_artifacts(args):
        result = process_artifact(args, log, artifact_text=artifact["text"], artifact_ref=artifact)
        if result.get("skipped"):
            skipped += 1
            if args.verbose:
                print(f"Skipping already processed {artifact.get('object_key') or artifact.get('path')}")
            continue
        processed += 1
        if args.verbose:
            if result.get("review_required"):
                print(
                    f"Review required for {result['title'] or '(untitled)'} "
                    f"({result.get('review_kind')})"
                )
            else:
                print(f"Imported {result['title'] or '(untitled)'} -> {len(result.get('thoughts', []))} thoughts")
    return {"processed": processed, "skipped": skipped}


def poll_loop(args, log: dict):
    while True:
        stats = run_once(args, log)
        save_sync_log(args.sync_log_file, log)
        if args.verbose:
            print(f"Poll cycle complete: processed={stats['processed']} skipped={stats['skipped']}")
        time.sleep(max(args.poll_interval, 1))


def main():
    args = parse_args()
    log = load_sync_log(args.sync_log_file)

    if args.poll:
        try:
            poll_loop(args, log)
        except KeyboardInterrupt:
            save_sync_log(args.sync_log_file, log)
            return 0
        return 0

    stats = run_once(args, log)
    save_sync_log(args.sync_log_file, log)
    print(json.dumps(stats, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
