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


INTEGRATION_DIR = Path(__file__).resolve().parent
DEFAULT_STATE_PATH = Path(os.environ.get("TELEGRAM_BRIDGE_STATE_FILE") or (INTEGRATION_DIR / "telegram-bridge-state.json"))

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

DEFAULT_MINIO_ENDPOINT = os.environ.get("MINIO_ENDPOINT") or os.environ.get("TELEGRAM_MINIO_ENDPOINT") or ""
DEFAULT_MINIO_ACCESS_KEY = os.environ.get("MINIO_ACCESS_KEY") or os.environ.get("TELEGRAM_MINIO_ACCESS_KEY") or ""
DEFAULT_MINIO_SECRET_KEY = os.environ.get("MINIO_SECRET_KEY") or os.environ.get("TELEGRAM_MINIO_SECRET_KEY") or ""
DEFAULT_MINIO_SECURE = (os.environ.get("MINIO_SECURE") or os.environ.get("TELEGRAM_MINIO_SECURE") or "true").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
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
The value must be an array of 0-3 real thought strings.
If the message has no durable value, return {"thoughts": []}.
"""


def parse_args():
    parser = argparse.ArgumentParser(description="Telegram bot bridge for OB1 typed capture and dictation handoff.")
    parser.add_argument("--telegram-token", default=DEFAULT_TELEGRAM_TOKEN, help="Telegram bot token.")
    parser.add_argument("--allowed-chat-id", action="append", default=[], help="Allowed Telegram private chat id. May be repeated.")
    parser.add_argument("--poll-timeout", type=int, default=DEFAULT_POLL_TIMEOUT, help="Telegram long-poll timeout in seconds.")
    parser.add_argument("--base-url", default=DEFAULT_OPEN_BRAIN_BASE, help="Open Brain runtime base URL.")
    parser.add_argument("--access-key", default=DEFAULT_OPEN_BRAIN_ACCESS_KEY, help="Open Brain access key.")
    parser.add_argument("--llm-model", default=DEFAULT_LLM_MODEL, help="Local summarizer model.")
    parser.add_argument("--minio-endpoint", default=DEFAULT_MINIO_ENDPOINT, help="MinIO endpoint host:port.")
    parser.add_argument("--minio-access-key", default=DEFAULT_MINIO_ACCESS_KEY, help="MinIO access key.")
    parser.add_argument("--minio-secret-key", default=DEFAULT_MINIO_SECRET_KEY, help="MinIO secret key.")
    parser.add_argument("--minio-secure", action=argparse.BooleanOptionalAction, default=DEFAULT_MINIO_SECURE, help="Use HTTPS for MinIO.")
    parser.add_argument("--raw-bucket", default=DEFAULT_RAW_BUCKET, help="MinIO bucket for raw Telegram audio.")
    parser.add_argument("--dictation-submit-url", default=DEFAULT_DICTATION_SUBMIT_URL, help="Dictation object-submission endpoint.")
    parser.add_argument("--dictation-access-key", default=DEFAULT_DICTATION_ACCESS_KEY, help="Dictation access key.")
    parser.add_argument("--cleanup-mode", default=DEFAULT_DICTATION_CLEANUP_MODE, help="Cleanup mode forwarded to dictation.")
    parser.add_argument("--state-file", default=str(DEFAULT_STATE_PATH), help="Path to persistent bridge state JSON.")
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
    if not args.dry_run and not args.minio_endpoint:
        parser.error("Missing MinIO endpoint. Set MINIO_ENDPOINT or pass --minio-endpoint.")
    if not args.dry_run and not args.dictation_access_key:
        parser.error("Missing dictation access key. Set DICTATION_ACCESS_KEY or pass --dictation-access-key.")

    args.state_file = Path(args.state_file)
    return args


def load_state(path: Path):
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"offset": 0, "updated_at": None}
    if not isinstance(payload, dict):
        return {"offset": 0, "updated_at": None}
    payload.setdefault("offset", 0)
    payload.setdefault("updated_at", None)
    return payload


def save_state(path: Path, payload):
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
        {"offset": offset, "timeout": timeout_seconds, "allowed_updates": ["message"]},
        timeout=timeout_seconds + 20,
    )


def get_file_info(token: str, file_id: str):
    return telegram_api_call(token, "getFile", {"file_id": file_id})


def download_file_bytes(token: str, file_path: str):
    response = requests.get(f"{telegram_file_base(token)}/{file_path}", timeout=300)
    response.raise_for_status()
    return response.content


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
    if not isinstance(thoughts, list):
        return []

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
    return normalized


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


def process_text_message(args, message: dict):
    text = message_text(message)
    if not text:
        return {"handled": False, "reason": "no_text"}

    source_payload = build_text_source_payload(message, text)
    thoughts = summarize_text_message(text, truncate_text(text, 80), args.llm_model)
    thought_payloads = [
        build_text_thought_payload(message, thought, source_payload["dedupe_key"], index)
        for index, thought in enumerate(thoughts)
    ]

    if not args.dry_run:
        ingest_row(args.base_url, args.access_key, source_payload)
        for payload in thought_payloads:
            ingest_row(args.base_url, args.access_key, payload)

    if args.telegram_token and not args.dry_run:
        send_reply(
            args.telegram_token,
            str(message["chat"]["id"]),
            message["message_id"],
            f"Captured text note. Stored 1 source row and {len(thought_payloads)} thought rows.",
        )

    return {
        "handled": True,
        "path": "text",
        "thought_count": len(thought_payloads),
        "source_dedupe_key": source_payload["dedupe_key"],
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


def process_message(args, message: dict):
    chat = message.get("chat") or {}
    chat_id = str(chat.get("id"))
    if chat.get("type") != "private":
        return {"handled": False, "reason": "non_private_chat"}
    if args.allowed_chat_ids and chat_id not in args.allowed_chat_ids:
        return {"handled": False, "reason": "chat_not_allowed"}

    if message_text(message):
        return process_text_message(args, message)
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
    handled = 0
    skipped = 0
    for update in iter_updates(args, state):
        if not isinstance(update, dict):
            continue
        update_id = update.get("update_id")
        message = update.get("message")
        if not isinstance(message, dict):
            skipped += 1
            if update_id is not None:
                state["offset"] = max(int(state.get("offset", 0)), int(update_id) + 1)
            continue

        message["_ob1_update_id"] = update_id
        result = process_message(args, message)
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
