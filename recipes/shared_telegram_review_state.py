from __future__ import annotations

import json
import os
import secrets
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import fcntl


def default_review_state_path(default_path: Path) -> Path:
    configured = os.environ.get("TELEGRAM_REVIEW_STATE_FILE")
    if configured:
        return Path(configured)

    bridge_state = os.environ.get("TELEGRAM_BRIDGE_STATE_FILE")
    if bridge_state:
        return Path(bridge_state).with_name("telegram-review-state.json")

    return default_path


def review_state_payload_default():
    return {"pending_actions": {}, "updated_at": None}


@contextmanager
def locked_review_state(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        handle.seek(0)
        raw = handle.read()
        try:
            payload = json.loads(raw) if raw.strip() else review_state_payload_default()
        except json.JSONDecodeError:
            payload = review_state_payload_default()
        if not isinstance(payload, dict):
            payload = review_state_payload_default()
        if not isinstance(payload.get("pending_actions"), dict):
            payload["pending_actions"] = {}
        payload.setdefault("updated_at", None)
        yield payload
        payload["updated_at"] = datetime.now(timezone.utc).isoformat()
        handle.seek(0)
        handle.truncate()
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def prune_pending_actions(payload: dict, ttl_seconds: int):
    pending = payload.setdefault("pending_actions", {})
    if ttl_seconds <= 0:
        return

    now = datetime.now(timezone.utc).timestamp()
    expired = []
    for token, entry in pending.items():
        created_at = entry.get("created_at")
        try:
            created_ts = datetime.fromisoformat(created_at).timestamp() if created_at else 0
        except ValueError:
            created_ts = 0
        if not created_ts or (now - created_ts) > ttl_seconds:
            expired.append(token)

    for token in expired:
        pending.pop(token, None)


def pending_action_token() -> str:
    return secrets.token_hex(8)
