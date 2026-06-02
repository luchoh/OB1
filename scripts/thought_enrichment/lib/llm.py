"""DeepSeek-V4-Flash classifier call (OpenAI-compatible chat/completions).

Replaces upstream's callOpenRouter / callAnthropic. The classification
prompt is preserved verbatim from upstream
recipes/thought-enrichment/enrich-thoughts.mjs.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any

import httpx


CLASSIFICATION_PROMPT = "\n".join(
    [
        "You classify personal notes for a second-brain system.",
        "Return STRICT JSON with keys: type, summary, topics, tags, people, action_items, confidence, importance, detected_source_type.",
        "",
        "type must be one of: idea, task, person_note, reference, decision, lesson, meeting, journal.",
        "summary: max 160 chars, capturing what this thought IS about personally.",
        "topics: 1-3 short lowercase tags. tags: additional freeform labels.",
        "people: names mentioned (empty array if none).",
        "action_items: implied to-dos (empty array if none).",
        "confidence: 0-1 (how confident you are this is genuinely personal content).",
        "importance: 1-5 integer.",
        "",
        "IMPORTANCE CALIBRATION (be strict — most should be 3):",
        "5: Life decisions, core beliefs, personal health data, financial commitments",
        "4: Specific preferences, project decisions, tools/products chosen",
        "3: Contextual project facts, minor preferences, techniques learned (DEFAULT)",
        "2: Low-signal but personal — filler, small talk, trivial observations",
        "1: Borderline — barely qualifies as personal memory",
        "",
        "CONFIDENCE CALIBRATION:",
        "0.9+: Clearly personal — user's own decision, preference, lesson, health data",
        "0.7-0.89: Probably personal but could be generic advice",
        "0.5-0.69: Borderline — reads more like general knowledge than personal context",
        "Below 0.5: Generic advice, encyclopedia-grade facts, or vague filler",
        "",
        "detected_source_type: Detect the likely origin based on content patterns. Must be one of:",
        "  limitless_import — speaker IDs like [1], [5], startMs/endMs timestamps, lifelog format",
        "  chatgpt_import — user/assistant conversation turns from ChatGPT",
        "  gemini_import — Gemini conversation format",
        "  claude_import — Claude export format",
        "  grok_import — Grok/xAI conversation format",
        "  x_twitter_import — tweets, @mentions, Twitter-style content",
        "  instagram_import — captions, comments, Instagram-style content",
        "  google_activity_import — search queries, URLs, browser history",
        "  blogger_import — blog post format, HTML/Atom content",
        "  telegram_import — short message captures",
        "  obsidian_import — markdown notes, wiki-links [[...]], frontmatter",
        "  generic_import — cannot determine source",
        "",
        "Examples:",
        "",
        'Input: "Met with Sarah about the API redesign. She wants GraphQL instead of REST."',
        'Output: {"type":"meeting","summary":"API redesign meeting with Sarah — GraphQL vs REST","topics":["api-design","graphql"],"tags":["architecture"],"people":["Sarah"],"action_items":["Prototype GraphQL API"],"confidence":0.95,"importance":4,"detected_source_type":"generic_import"}',
        "",
        'Input: "I\'m going to use Supabase instead of Firebase. Better SQL support and pgvector."',
        'Output: {"type":"decision","summary":"Chose Supabase over Firebase for SQL and pgvector support","topics":["database","infrastructure"],"tags":["architecture"],"people":[],"action_items":[],"confidence":0.92,"importance":4,"detected_source_type":"generic_import"}',
        "",
        'Input: "[1] So I was talking to Ahmed about the wedding plans [5] Yeah the venue in downtown..."',
        'Output: {"type":"meeting","summary":"Discussion with Ahmed about wedding venue plans","topics":["wedding","planning"],"tags":["personal"],"people":["Ahmed"],"action_items":[],"confidence":0.90,"importance":4,"detected_source_type":"limitless_import"}',
        "",
        "IMPORTANT: Return ONLY the JSON object, no markdown fences, no explanation.",
    ]
)


ALLOWED_TYPES = {
    "idea",
    "task",
    "person_note",
    "reference",
    "decision",
    "lesson",
    "meeting",
    "journal",
}

ALLOWED_SOURCE_TYPES = {
    "limitless_import",
    "chatgpt_import",
    "gemini_import",
    "claude_import",
    "grok_import",
    "x_twitter_import",
    "instagram_import",
    "google_activity_import",
    "blogger_import",
    "telegram_import",
    "obsidian_import",
    "generic_import",
    "claude_code_import",
}


_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE | re.MULTILINE)


def _clamp_int(value: Any, lo: int, hi: int, default: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def _clamp_float(value: Any, lo: float, hi: float, default: float) -> float:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, f))


def _coerce_str_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if isinstance(item, (str, int, float))]
    return []


class LLMClient:
    """OpenAI-compatible chat/completions client pointed at mlx-server.

    Defaults pulled from environment variables:
      LLM_BASE_URL        — e.g. https://mlx.lincoln.luchoh.net/v1
      LLM_MODEL           — e.g. DeepSeek-V4-Flash-nvfp4
      LLM_API_KEY         — optional bearer (mlx-server doesn't require one
                            but accepts it; safe to leave unset)
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        model: str | None = None,
        api_key: str | None = None,
        timeout_s: float = 60.0,
    ) -> None:
        self._base_url = (base_url or os.environ.get("LLM_BASE_URL", "")).rstrip("/")
        if not self._base_url:
            raise RuntimeError("LLM_BASE_URL is required (set in env or pass base_url=)")
        self._model = model or os.environ.get("LLM_MODEL", "DeepSeek-V4-Flash-nvfp4")
        api_key = api_key or os.environ.get("LLM_API_KEY")
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        self._client = httpx.AsyncClient(timeout=timeout_s, headers=headers)

    async def __aenter__(self) -> "LLMClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self._client.aclose()

    async def _post(self, body: dict[str, Any]) -> dict[str, Any]:
        for attempt in range(4):
            try:
                response = await self._client.post(
                    f"{self._base_url}/chat/completions", json=body
                )
                if response.status_code == 200:
                    return response.json()
                transient = response.status_code in (429, 500, 502, 503, 504)
                if not transient or attempt == 3:
                    raise RuntimeError(
                        f"LLM call failed ({response.status_code}): {response.text[:300]}"
                    )
            except httpx.RequestError as exc:
                if attempt == 3:
                    raise RuntimeError(f"LLM call network error: {exc}") from exc
            await asyncio.sleep(min(16.0, 1.0 * (2**attempt)))
        raise RuntimeError("LLM call exhausted retries")

    async def classify(self, content: str, *, existing_source: str = "") -> dict[str, Any]:
        """Classify a thought; returns a sanitized dict with all expected keys."""
        user_lines = []
        if existing_source:
            user_lines.append(f"Existing source_type: {existing_source}")
        user_lines.append(f"Content:\n{content[:4000]}")
        user_input = "\n\n".join(user_lines)

        body = {
            "model": self._model,
            "max_tokens": 1024,
            "temperature": 0.1,
            "messages": [
                {"role": "system", "content": CLASSIFICATION_PROMPT},
                {"role": "user", "content": user_input},
            ],
        }
        result = await self._post(body)
        choice = result.get("choices") or []
        raw = ""
        if choice:
            message = choice[0].get("message") or {}
            raw = (message.get("content") or "").strip()
        raw = _FENCE_RE.sub("", raw).strip()

        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"JSON parse failed. Raw output: {raw[:300]}") from exc

        type_ = parsed.get("type") if isinstance(parsed, dict) else None
        if type_ not in ALLOWED_TYPES:
            type_ = "reference"

        detected = parsed.get("detected_source_type") if isinstance(parsed, dict) else None
        if detected not in ALLOWED_SOURCE_TYPES:
            detected = existing_source if existing_source in ALLOWED_SOURCE_TYPES else "generic_import"

        summary = parsed.get("summary") if isinstance(parsed, dict) else ""
        if not isinstance(summary, str):
            summary = ""

        return {
            "type": type_,
            "summary": summary,
            "topics": _coerce_str_list(parsed.get("topics")) if isinstance(parsed, dict) else [],
            "tags": _coerce_str_list(parsed.get("tags")) if isinstance(parsed, dict) else [],
            "people": _coerce_str_list(parsed.get("people")) if isinstance(parsed, dict) else [],
            "action_items": _coerce_str_list(parsed.get("action_items")) if isinstance(parsed, dict) else [],
            "confidence": _clamp_float(parsed.get("confidence") if isinstance(parsed, dict) else None, 0.0, 1.0, 0.5),
            "importance": _clamp_int(parsed.get("importance") if isinstance(parsed, dict) else None, 1, 5, 3),
            "detected_source_type": detected,
        }

    @property
    def model(self) -> str:
        return self._model
