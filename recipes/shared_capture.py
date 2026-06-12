"""Shared Capture client for OB1 ingest pipelines (PRD docs/34, module 4).

Today four ingest pipelines each re-implement the Capture contract against
``POST /ingest/thought``:

  - integrations/telegram-capture/telegram_bridge.py
  - scripts/ingest-chat-export-sources.py
  - recipes/dictation-import/import-dictation.py
  - recipes/shared_docling.py            (its ``ingest_thought`` wrapper)

Between them they hand-roll five payload builders, stamp ``retrieval_role`` as
a string literal in a dozen places, invent per-source dedupe-key formats, set
two different header conventions' worth of duplication, and disagree on retry
(only shared_docling retries; the other three POST once). This module is the
one place that owns:

  * payload construction (``build_payload``) — the ``/ingest/thought`` body
    shape (content, metadata incl. retrieval_role/source/type/summary/topics,
    source, type, tags, dedupe_key, occurred_at, extract_metadata);
  * the dedupe-key conventions registry (one function per documented format);
  * one HTTP/retry/auth convention (``CaptureClient``).

It is PURE of pipeline specifics: it does not know how a Telegram message or a
docling chunk is parsed. Pipelines keep their own source extraction and feed
structured fields into ``build_payload`` / ``CaptureClient``.

Stage 1 (this change) is INERT: no pipeline imports it yet. Stage 2 turns the
four pipelines into adapters and proves payload equivalence field-for-field
before deleting the old builders.

Shaped-for-future (NOT sent on the wire here, per PRD Out of Scope): an
explicit ``brain`` parameter and ``author_session_id`` stamping. ``build_payload``
accepts arbitrary ``metadata`` extras and a future ``brain`` argument would land
as one new top-level key here, touching one module instead of five scripts.

Import mechanics: ``recipes/`` is an implicit namespace package (no
``__init__.py``); callers that put the repo root on ``sys.path`` import this as
``from recipes.shared_capture import CaptureClient, build_payload`` — exactly how
telegram_bridge.py and import-dictation.py already import shared_docling.
"""

from __future__ import annotations

import time
from typing import Any, Callable, Optional

import requests


# --- Wire constants -------------------------------------------------------

CAPTURE_INGEST_PATH = "/ingest/thought"

# retrieval_role vocabulary (CONTEXT.md "Distilled vs source"). Stamped here so
# the two values cannot drift across pipelines.
RETRIEVAL_ROLE_SOURCE = "source"
RETRIEVAL_ROLE_DISTILLED = "distilled"

# Unified retry/timeout policy (see module + PRD module-4 proposal).
#   - 2 retries (3 attempts total): matches shared_docling, the only capture
#     path that retries today.
#   - retryable: connection errors and HTTP 5xx. 4xx fails fast (a bad payload
#     or auth error must not be hammered).
#   - linear backoff sleep(attempt + 1) -> 1s, 2s (shared_docling's).
#   - timeout 300s: the majority value (telegram/dictation/chat-export use 300;
#     shared_docling capture used 240 -> widened to 300).
# Retrying capture is safe because the endpoint dedupes on ``dedupe_key``: a
# replayed POST whose first attempt actually landed will not double-write.
DEFAULT_TIMEOUT = 300
DEFAULT_RETRIES = 2


# Sentinel: distinguishes "omit occurred_at entirely" (shared_docling builds no
# occurred_at key) from "send occurred_at: null" (telegram/dictation/chat-export
# always include the key, sometimes with a None value).
_OMIT = object()


class CaptureError(RuntimeError):
    """Raised when ``/ingest/thought`` returns a non-2xx status.

    Carries the status code and response body so adapters can inspect them;
    the message is a canonical format (it does not byte-match any one
    pipeline's old RuntimeError wording — listed as a deliberate inequality
    for Stage 2).
    """

    def __init__(self, status_code: int, body_text: str, reason: str = ""):
        self.status_code = status_code
        self.body_text = body_text
        self.reason = reason
        detail = f"{status_code}"
        if reason:
            detail += f" {reason}"
        super().__init__(f"OB1 capture failed ({detail}): {body_text[:500]}")


# --- Payload construction -------------------------------------------------

def build_payload(
    *,
    content: str,
    source: str,
    thought_type: str,
    retrieval_role: str,
    dedupe_key: str,
    summary: Any = None,
    topics: Optional[list] = None,
    tags: Optional[list] = None,
    occurred_at: Any = _OMIT,
    extract_metadata: bool = False,
    metadata: Optional[dict] = None,
) -> dict:
    """Build the ``/ingest/thought`` request body.

    The metadata block is ``{source, type, retrieval_role, summary, topics}``
    merged with ``metadata`` extras. Extras win on key collision — this
    reproduces the dictation builder's ``**metadata`` splat-last semantics
    (raw frontmatter may override the structured core) and is a no-op for the
    other pipelines, whose extras never collide with the core five.

    ``occurred_at`` is included only when passed (including an explicit
    ``None``); left at the ``_OMIT`` sentinel, the key is absent, matching
    shared_docling, which builds no ``occurred_at``.

    Pure: no I/O, no clock, no network.
    """
    meta: dict = {
        "source": source,
        "type": thought_type,
        "retrieval_role": retrieval_role,
        "summary": summary,
        "topics": topics if topics is not None else [],
    }
    if metadata:
        meta.update(metadata)

    payload: dict = {
        "content": content,
        "metadata": meta,
        "source": source,
        "type": thought_type,
        "tags": tags if tags is not None else [],
        "dedupe_key": dedupe_key,
        "extract_metadata": extract_metadata,
    }
    if occurred_at is not _OMIT:
        payload["occurred_at"] = occurred_at
    return payload


# --- Dedupe-key conventions registry --------------------------------------
# One function per documented per-source format. The formats are the contract;
# any per-pipeline value normalization (e.g. dictation's frontmatter cleanup)
# stays in the adapter and feeds already-resolved values in here.

def telegram_message_key(chat_id: Any, message_id: Any) -> str:
    """``telegram:{chat_id}:{message_id}`` — a captured Telegram message."""
    return f"telegram:{chat_id}:{message_id}"


def conversation_record_key(platform: str, conversation_hash: str) -> str:
    """``{platform}:conversation_record:{hash}`` — a raw chat-export record.

    ``platform`` is ``chatgpt`` or ``claude``.
    """
    return f"{platform}:conversation_record:{conversation_hash}"


def conversation_source_key(platform: str, conversation_hash: str) -> str:
    """``{platform}:conversation_source:{hash}`` — a normalized transcript."""
    return f"{platform}:conversation_source:{conversation_hash}"


def dictation_source_key(
    *,
    audio_sha256: Optional[str] = None,
    artifact_id: Optional[str] = None,
    source_host: Optional[str] = None,
    created_at: Optional[str] = None,
    cleaned_text_hash: Optional[str] = None,
) -> str:
    """Dictation source key, mirroring ``derive_source_dedupe_key`` precedence:
    ``dictation:{audio_sha256}`` > ``dictation:{artifact_id}`` >
    ``dictation:{source_host}:{created_at}:{cleaned_text_hash}`` with
    ``unknown`` filling any missing composite part.

    Inputs are expected already normalized (blank/``"null"``/``"none"`` -> None);
    that normalization is the adapter's job.
    """
    if audio_sha256:
        return f"dictation:{audio_sha256}"
    if artifact_id:
        return f"dictation:{artifact_id}"
    return (
        f"dictation:{source_host or 'unknown'}"
        f":{created_at or 'unknown'}"
        f":{cleaned_text_hash or 'unknown'}"
    )


def derived_thought_key(source_dedupe_key: str, index: Any) -> str:
    """``{source_dedupe_key}:thought:{index}`` — a distilled thought derived
    from a source row (telegram + dictation share this format)."""
    return f"{source_dedupe_key}:thought:{index}"


# --- HTTP client ----------------------------------------------------------

class CaptureClient:
    """Posts capture payloads to ``/ingest/thought`` with one retry/auth policy.

    The client owns transport only: base URL + access key resolution stays in
    each pipeline's arg/env parsing (it differs per pipeline) and the resolved
    pair is handed in here. Auth is the unified header convention
    ``x-access-key`` + ``x-ingest-key`` (same value), which every pipeline
    already sends.

    The HTTP POST is injectable (``post=``) so tests run fully offline; default
    is ``requests.post``.
    """

    def __init__(
        self,
        base_url: str,
        access_key: str,
        *,
        timeout: int = DEFAULT_TIMEOUT,
        retries: int = DEFAULT_RETRIES,
        post: Optional[Callable[..., Any]] = None,
        sleep: Callable[[float], None] = time.sleep,
        ingest_url: Optional[str] = None,
    ) -> None:
        self._base_url = (base_url or "").rstrip("/")
        self._access_key = access_key
        self._timeout = timeout
        self._retries = retries
        self._post = post or requests.post
        self._sleep = sleep
        # Most pipelines pass a base URL and the conventional path is appended.
        # shared_docling configures a full endpoint URL (OPEN_BRAIN_INGEST_URL);
        # ``ingest_url`` lets it post to that exact endpoint unchanged.
        self._ingest_url = ingest_url or f"{self._base_url}{CAPTURE_INGEST_PATH}"

    @property
    def ingest_url(self) -> str:
        return self._ingest_url

    def _headers(self) -> dict:
        return {
            "Content-Type": "application/json",
            "x-access-key": self._access_key,
            "x-ingest-key": self._access_key,
        }

    def capture(self, payload: dict) -> dict:
        """POST one payload; retry transient failures; return the parsed body.

        Raises ``CaptureError`` on a non-2xx final status, or re-raises the
        underlying ``requests.RequestException`` after exhausting retries.
        """
        for attempt in range(self._retries + 1):
            try:
                resp = self._post(
                    self.ingest_url,
                    headers=self._headers(),
                    json=payload,
                    timeout=self._timeout,
                )
            except requests.RequestException:
                if attempt < self._retries:
                    self._sleep(attempt + 1)
                    continue
                raise

            if resp.status_code >= 500 and attempt < self._retries:
                self._sleep(attempt + 1)
                continue

            if resp.status_code not in (200, 201):
                body_text = getattr(resp, "text", "")
                reason = getattr(resp, "reason", "") or ""
                raise CaptureError(resp.status_code, body_text, reason)

            return _parse_body(resp)

        # Unreachable: the loop either returns, raises CaptureError, or re-raises.
        raise CaptureError(0, "capture exhausted retries without a response")

    def capture_built(self, **payload_kwargs: Any) -> dict:
        """Convenience: ``capture(build_payload(**payload_kwargs))``."""
        return self.capture(build_payload(**payload_kwargs))


def _parse_body(resp: Any) -> dict:
    """Parse a 2xx response body as JSON, falling back to a wrapped raw string.

    Matches the telegram/dictation/chat-export wrappers (which tolerate a
    non-JSON body); shared_docling called ``resp.json()`` directly and would
    have raised — listed as a deliberate inequality for Stage 2 (success
    bodies from the ingest endpoint are always JSON, so it never triggers).
    """
    try:
        return resp.json()
    except ValueError:
        return {"raw_response": getattr(resp, "text", "")}
