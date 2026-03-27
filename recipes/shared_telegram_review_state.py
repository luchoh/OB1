from __future__ import annotations

import copy
import json
import os
import re
import secrets
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import fcntl


REVIEW_MODE_FULL = "full"
REVIEW_MODE_EXCEPTIONS_ONLY = "exceptions_only"
THOUGHT_STATUS_PENDING = "pending"
THOUGHT_STATUS_APPROVED = "approved"
THOUGHT_STATUS_EDITED = "edited"
THOUGHT_STATUS_DENIED = "denied"
DICTATION_RESOLUTION_INGESTED = "ingested"
DICTATION_RESOLUTION_IGNORED = "ignored"
DICTATION_RESOLUTION_EXPIRED = "expired"
CALLBACK_ACTIONS_WITH_INDEX = {"approve", "deny", "edit"}
CALLBACK_ACTIONS_NO_INDEX = {"approve_all", "commit", "deny_all", "view_raw", "record", "ignore"}
CALLBACK_TOKEN_RE = re.compile(r"^[0-9a-f]{16}$")


def default_review_state_path(default_path: Path) -> Path:
    configured = os.environ.get("TELEGRAM_REVIEW_STATE_FILE")
    if configured:
        return Path(configured)

    bridge_state = os.environ.get("TELEGRAM_BRIDGE_STATE_FILE")
    if bridge_state:
        return Path(bridge_state).with_name("telegram-review-state.json")

    return default_path


def review_state_payload_default():
    return {"pending_actions": {}, "resolved_actions": {}, "updated_at": None}


def normalize_review_mode(value: str | None, *, default: str = REVIEW_MODE_FULL) -> str:
    cleaned = (value or "").strip().lower()
    if cleaned in {REVIEW_MODE_FULL, REVIEW_MODE_EXCEPTIONS_ONLY}:
        return cleaned
    return default


def truncate_for_summary(text: str, limit: int = 120) -> str:
    cleaned = " ".join((text or "").split())
    if len(cleaned) <= limit:
        return cleaned
    return f"{cleaned[: max(limit - 1, 1)].rstrip()}..."


def _normalize_match_text(value: object, *, limit: int = 160) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        cleaned = " ".join(value.split()).strip()
    else:
        cleaned = " ".join(str(value).split()).strip()
    if not cleaned:
        return None
    return truncate_for_summary(cleaned, limit)


def _normalize_match_similarity(value: object) -> str | None:
    try:
        return f"{float(value):.2f}"
    except (TypeError, ValueError):
        return None


def _build_similar_match_entries(
    content: str,
    similar_matches: dict[str, list[dict]] | None,
) -> list[dict]:
    if not isinstance(similar_matches, dict):
        return []

    condensed = []
    for match in similar_matches.get(content, [])[:2]:
        if not isinstance(match, dict):
            continue
        summary = _normalize_match_text(match.get("summary")) or _normalize_match_text(match.get("content"))
        if not summary:
            continue
        condensed.append(
            {
                "summary": summary,
                "similarity": _normalize_match_similarity(match.get("similarity")),
                "source": _normalize_match_text(match.get("source"), limit=48),
                "type": _normalize_match_text(match.get("type"), limit=48),
            }
        )
    return condensed


def _ensure_review_payload(payload: dict) -> dict:
    if not isinstance(payload, dict):
        payload = review_state_payload_default()
    if not isinstance(payload.get("pending_actions"), dict):
        payload["pending_actions"] = {}
    if not isinstance(payload.get("resolved_actions"), dict):
        payload["resolved_actions"] = {}
    payload.setdefault("updated_at", None)
    return payload


def build_review_thought_entries(
    thought_payloads: list[dict],
    *,
    suggested_decisions: dict[str, str] | None = None,
    similar_matches: dict[str, list[dict]] | None = None,
) -> list[dict]:
    entries = []
    decisions = suggested_decisions or {}
    for index, payload in enumerate(thought_payloads):
        payload_copy = copy.deepcopy(payload)
        content = payload_copy.get("content") or ""
        decision = (decisions.get(content) or "").strip().lower()
        if decision == "record":
            status = THOUGHT_STATUS_APPROVED
        elif decision == "duplicate":
            status = THOUGHT_STATUS_DENIED
        else:
            status = THOUGHT_STATUS_PENDING
        entries.append(
            {
                "index": index,
                "status": status,
                "content": content,
                "original_content": content,
                "payload": payload_copy,
                "suggested_decision": decision or None,
                "similar_matches": _build_similar_match_entries(content, similar_matches),
            }
        )
    return entries


def build_review_session(
    *,
    origin: str,
    kind: str,
    chat_id: str,
    message_id: int,
    source_payload: dict,
    thought_payloads: list[dict],
    suggested_decisions: dict[str, str] | None = None,
    similar_matches: dict[str, list[dict]] | None = None,
    prompt_text: str | None = None,
    mode: str = REVIEW_MODE_FULL,
    view_raw_enabled: bool = True,
    dictation_sync: dict | None = None,
) -> dict:
    return {
        "schema_version": 2,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "origin": origin,
        "kind": kind,
        "mode": normalize_review_mode(mode),
        "chat_id": str(chat_id),
        "message_id": int(message_id),
        "review_message_id": None,
        "source_payload": copy.deepcopy(source_payload),
        "source_text": source_payload.get("content") or "",
        "prompt_text": prompt_text or "",
        "view_raw_enabled": bool(view_raw_enabled),
        "thoughts": build_review_thought_entries(
            thought_payloads,
            suggested_decisions=suggested_decisions,
            similar_matches=similar_matches,
        ),
        "edit_target_index": None,
        "edit_prompt_message_id": None,
        "dictation_sync": copy.deepcopy(dictation_sync) if dictation_sync else None,
    }


def review_session_has_thoughts(session: dict) -> bool:
    return bool(session.get("thoughts"))


def approved_session_payloads(session: dict) -> list[dict]:
    payloads = []
    for thought in session.get("thoughts", []):
        if thought.get("status") not in {THOUGHT_STATUS_APPROVED, THOUGHT_STATUS_EDITED}:
            continue
        payload = copy.deepcopy(thought.get("payload") or {})
        payload["content"] = thought.get("content") or ""
        metadata = payload.setdefault("metadata", {})
        metadata["summary"] = truncate_for_summary(payload["content"])
        payloads.append(payload)
    return payloads


def pending_session_edit_target(session: dict) -> int | None:
    value = session.get("edit_target_index")
    return value if isinstance(value, int) else None


def clear_active_edit(session: dict) -> None:
    session["edit_target_index"] = None
    session["edit_prompt_message_id"] = None


def start_edit_prompt(review_state: dict, token: str, thought_index: int, prompt_message_id: int) -> None:
    pending = review_state.setdefault("pending_actions", {})
    session = pending.get(token)
    if not isinstance(session, dict):
        return
    chat_id = str(session.get("chat_id") or "")
    for other_token, other_session in pending.items():
        if not isinstance(other_session, dict):
            continue
        if other_token == token:
            continue
        if str(other_session.get("chat_id") or "") != chat_id:
            continue
        clear_active_edit(other_session)
    session["edit_target_index"] = thought_index
    session["edit_prompt_message_id"] = int(prompt_message_id)


def apply_edit_reply(session: dict, replacement_text: str) -> bool:
    thought_index = pending_session_edit_target(session)
    if thought_index is None:
        return False
    normalized = " ".join((replacement_text or "").split()).strip()
    if not normalized:
        return False
    thoughts = session.get("thoughts", [])
    if thought_index < 0 or thought_index >= len(thoughts):
        clear_active_edit(session)
        return False
    thought = thoughts[thought_index]
    thought["content"] = normalized
    thought["status"] = THOUGHT_STATUS_EDITED
    clear_active_edit(session)
    return True


def find_edit_session(review_state: dict, chat_id: str, reply_to_message_id: int | None):
    if reply_to_message_id is None:
        return None, None
    for token, session in review_state.get("pending_actions", {}).items():
        if not isinstance(session, dict):
            continue
        if str(session.get("chat_id") or "") != str(chat_id):
            continue
        if session.get("edit_prompt_message_id") != int(reply_to_message_id):
            continue
        return token, session
    return None, None


def render_review_text(session: dict) -> str:
    prompt_text = (session.get("prompt_text") or "").strip()
    thoughts = session.get("thoughts", [])
    if not thoughts:
        return prompt_text or "Record this anyway or ignore it?"

    origin = session.get("origin") or "telegram_text"
    source_label = "voice transcript" if origin == "telegram_dictation" else "Telegram capture"
    lines = []
    if prompt_text:
        lines.extend([prompt_text, ""])
    lines.extend(
        [
            f"OB1 extracted {len(thoughts)} candidate thoughts from this {source_label}.",
            "",
            "Nothing is stored until you press Commit.",
            "",
        ]
    )
    for thought in thoughts:
        index = int(thought.get("index", 0)) + 1
        content = thought.get("content") or ""
        status = (thought.get("status") or THOUGHT_STATUS_PENDING).replace("_", " ")
        lines.append(f"{index}. {content}")
        lines.append(f"   Status: {status}")
        similar_matches = thought.get("similar_matches") or []
        if similar_matches:
            lines.append("   Closest existing memories:")
            for match_index, match in enumerate(similar_matches, start=1):
                details = []
                if match.get("similarity"):
                    details.append(f"similarity={match['similarity']}")
                if match.get("type"):
                    details.append(f"type={match['type']}")
                if match.get("source"):
                    details.append(f"source={match['source']}")
                prefix = f"   {match_index}."
                if details:
                    lines.append(f"{prefix} {' '.join(details)}")
                    lines.append(f"      {match.get('summary')}")
                else:
                    lines.append(f"{prefix} {match.get('summary')}")
        lines.append("")
    return "\n".join(lines).strip()


def build_review_reply_markup(session: dict, token: str) -> dict:
    keyboard = []
    thoughts = session.get("thoughts", [])
    if not thoughts:
        keyboard.append(
            [
                {"text": "Record", "callback_data": f"ob1:record:{token}"},
                {"text": "Ignore", "callback_data": f"ob1:ignore:{token}"},
            ]
        )
        if session.get("view_raw_enabled", True):
            keyboard.append([{"text": "View Raw", "callback_data": f"ob1:view_raw:{token}"}])
        return {"inline_keyboard": keyboard}

    for thought in thoughts:
        index = int(thought.get("index", 0))
        label_index = index + 1
        keyboard.append(
            [
                {"text": f"Approve {label_index}", "callback_data": f"ob1:approve:{token}:{index}"},
                {"text": f"Edit {label_index}", "callback_data": f"ob1:edit:{token}:{index}"},
                {"text": f"Deny {label_index}", "callback_data": f"ob1:deny:{token}:{index}"},
            ]
        )
    keyboard.append(
        [
            {"text": "Approve All", "callback_data": f"ob1:approve_all:{token}"},
            {"text": "Commit", "callback_data": f"ob1:commit:{token}"},
        ]
    )
    trailing = [{"text": "Deny All", "callback_data": f"ob1:deny_all:{token}"}]
    if session.get("view_raw_enabled", True):
        trailing.append({"text": "View Raw", "callback_data": f"ob1:view_raw:{token}"})
    keyboard.append(trailing)
    return {"inline_keyboard": keyboard}


def parse_callback_data(data: str):
    parts = (data or "").strip().split(":")
    if len(parts) < 3 or parts[0] != "ob1":
        return None
    action = parts[1]
    token = parts[2]
    if not CALLBACK_TOKEN_RE.fullmatch(token):
        return None
    if action in CALLBACK_ACTIONS_WITH_INDEX:
        if len(parts) != 4:
            return None
        try:
            index = int(parts[3])
        except ValueError:
            return None
        if index < 0:
            return None
        return {"action": action, "token": token, "index": index}
    if action in CALLBACK_ACTIONS_NO_INDEX and len(parts) == 3:
        return {"action": action, "token": token, "index": None}
    return None


def record_resolution(review_state: dict, token: str, session: dict, status: str) -> None:
    if not isinstance(session, dict):
        return
    dictation_sync = session.get("dictation_sync")
    if not isinstance(dictation_sync, dict):
        return
    resolved = review_state.setdefault("resolved_actions", {})
    resolved[token] = {
        "resolved_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "origin": session.get("origin"),
        "kind": session.get("kind"),
        "chat_id": str(session.get("chat_id") or ""),
        "message_id": session.get("message_id"),
        "dictation_sync": copy.deepcopy(dictation_sync),
    }


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
        payload = _ensure_review_payload(payload)
        yield payload
        payload["updated_at"] = datetime.now(timezone.utc).isoformat()
        handle.seek(0)
        handle.truncate()
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def prune_pending_actions(payload: dict, ttl_seconds: int):
    payload = _ensure_review_payload(payload)
    pending = payload.setdefault("pending_actions", {})
    if ttl_seconds <= 0:
        return []

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

    expired_entries = []
    for token in expired:
        entry = pending.pop(token, None)
        if entry is None:
            continue
        record_resolution(payload, token, entry, DICTATION_RESOLUTION_EXPIRED)
        expired_entries.append((token, entry))
    return expired_entries


def pending_action_token() -> str:
    return secrets.token_hex(8)
