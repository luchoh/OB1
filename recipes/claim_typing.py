#!/usr/bin/env python3
"""
Shared claim-typing helpers for Open Brain importers and backfill tools.
"""

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from recipes.shared_docling import local_llm_base_url

try:
    import requests
except ImportError as exc:  # pragma: no cover - import guard for CLI use
    raise RuntimeError("Missing dependency: requests") from exc


CLAIM_EXTRACTION_VERSION = "claim-typing-v1"
LOCAL_LLM_MODEL = os.environ.get("LLM_MODEL", "mlx-community/Qwen3.5-397B-A17B-nvfp4")
LOCAL_LLM_ENABLE_THINKING = os.environ.get("LLM_ENABLE_THINKING", "false").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
OLLAMA_BASE = "http://localhost:11434"
DEFAULT_PROMPT_PATH = Path(__file__).resolve().parent / "claim-typing" / "prompt.md"

CLAIM_KINDS = {
    "decision",
    "preference",
    "comparison",
    "option",
    "open_question",
    "constraint",
    "implementation_detail",
    "diagnosis",
    "fact",
    "plan",
}

EPISTEMIC_STATUSES = {
    "decided",
    "preferred",
    "considering",
    "tested",
    "implemented",
    "observed",
    "unresolved",
    "superseded",
    "unknown",
}

CLAIM_STRENGTHS = {
    "strong",
    "medium",
    "weak",
}


def load_claim_prompt(prompt_file=None):
    path = Path(prompt_file) if prompt_file else DEFAULT_PROMPT_PATH
    try:
        template = path.read_text().strip()
    except FileNotFoundError as exc:
        raise FileNotFoundError(f"Claim typing prompt file not found: {path}") from exc

    if "{thought_count}" not in template:
        raise ValueError(f"Claim typing prompt must include a {{thought_count}} placeholder: {path}")

    return template


def build_claim_prompt(thought_count, prompt_template=None):
    template = prompt_template if prompt_template is not None else load_claim_prompt()
    return template.format(thought_count=thought_count)


def build_claims_tool(thought_count):
    return {
        "type": "function",
        "function": {
            "name": "submit_claims",
            "description": "Return claim typing metadata for each thought index.",
            "parameters": {
                "type": "object",
                "additionalProperties": False,
                "required": ["claims"],
                "properties": {
                    "claims": {
                        "type": "array",
                        "description": f"Exactly {thought_count} claim entries, one per thought index.",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": [
                                "thought_index",
                                "emit_claim",
                                "claim_kind",
                                "epistemic_status",
                                "claim_subject",
                                "claim_object",
                                "claim_scope",
                                "claim_strength",
                                "claim_rationale",
                            ],
                            "properties": {
                                "thought_index": {
                                    "type": "integer",
                                    "minimum": 1,
                                    "maximum": thought_count,
                                },
                                "emit_claim": {
                                    "type": "boolean",
                                },
                                "claim_kind": {
                                    "type": ["string", "null"],
                                    "enum": sorted(CLAIM_KINDS) + [None],
                                },
                                "epistemic_status": {
                                    "type": ["string", "null"],
                                    "enum": sorted(EPISTEMIC_STATUSES) + [None],
                                },
                                "claim_subject": {
                                    "type": ["string", "null"],
                                },
                                "claim_object": {
                                    "type": ["string", "null"],
                                },
                                "claim_scope": {
                                    "type": ["object", "null"],
                                },
                                "claim_strength": {
                                    "type": ["string", "null"],
                                    "enum": sorted(CLAIM_STRENGTHS) + [None],
                                },
                                "claim_rationale": {
                                    "type": ["string", "null"],
                                },
                            },
                        },
                    }
                },
            },
        },
    }


def claim_output_limit(thought_count):
    return max(700, 220 * thought_count)


def normalize_json_payload(text):
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

    return normalize_json_payload(arguments)


def http_post_with_retry(url, body, headers=None, retries=2, timeout=120):
    headers = headers or {"Content-Type": "application/json"}
    for attempt in range(retries + 1):
        try:
            resp = requests.post(url, headers=headers, json=body, timeout=timeout)
            if resp.status_code >= 500 and attempt < retries:
                continue
            return resp
        except requests.RequestException:
            if attempt < retries:
                continue
            raise
    return None


def normalize_chat_text(text, limit=240):
    if not isinstance(text, str):
        return None
    cleaned = " ".join(text.strip().split())
    if not cleaned:
        return None
    return cleaned[:limit]


def sanitize_claim_scope(value):
    if not isinstance(value, dict):
        return None

    def convert(item):
        if item is None:
            return None
        if isinstance(item, bool):
            return item
        if isinstance(item, (int, float)) and not isinstance(item, bool):
            return item
        if isinstance(item, str):
            text = normalize_chat_text(item, limit=240)
            return text
        if isinstance(item, list):
            converted = [convert(entry) for entry in item]
            converted = [entry for entry in converted if entry not in (None, "", [], {})]
            return converted[:12]
        if isinstance(item, dict):
            converted = {
                str(key): convert(subvalue)
                for key, subvalue in item.items()
            }
            converted = {
                key: subvalue
                for key, subvalue in converted.items()
                if subvalue not in (None, "", [], {})
            }
            return converted or None
        return None

    cleaned = convert(value)
    return cleaned if isinstance(cleaned, dict) and cleaned else None


def normalize_claim_entry(entry, thought_index, extraction_model):
    if not isinstance(entry, dict):
        entry = {}

    emit_claim = bool(entry.get("emit_claim"))
    patch = {
        "claim_extraction_version": CLAIM_EXTRACTION_VERSION,
        "claim_extracted_at": datetime.now(timezone.utc).isoformat(),
        "claim_extraction_model": extraction_model,
    }

    if not emit_claim:
        return thought_index, patch

    claim_kind = entry.get("claim_kind")
    epistemic_status = entry.get("epistemic_status")
    if claim_kind not in CLAIM_KINDS or epistemic_status not in EPISTEMIC_STATUSES:
        return thought_index, patch

    patch["claim_kind"] = claim_kind
    patch["epistemic_status"] = epistemic_status

    claim_subject = normalize_chat_text(entry.get("claim_subject"), limit=180)
    claim_object = normalize_chat_text(entry.get("claim_object"), limit=180)
    claim_strength = entry.get("claim_strength")
    claim_rationale = normalize_chat_text(entry.get("claim_rationale"), limit=320)
    claim_scope = sanitize_claim_scope(entry.get("claim_scope"))

    if claim_subject:
        patch["claim_subject"] = claim_subject
    if claim_object:
        patch["claim_object"] = claim_object
    if claim_strength in CLAIM_STRENGTHS:
        patch["claim_strength"] = claim_strength
    if claim_rationale:
        patch["claim_rationale"] = claim_rationale
    if claim_scope:
        patch["claim_scope"] = claim_scope

    return thought_index, patch


def normalize_claims(result, thought_count, extraction_model):
    claims = result.get("claims", []) if isinstance(result, dict) else []
    normalized = {}

    if isinstance(claims, list):
        for item in claims:
            if not isinstance(item, dict):
                continue
            thought_index = item.get("thought_index")
            if not isinstance(thought_index, int) or thought_index < 1 or thought_index > thought_count:
                continue
            normalized[thought_index] = normalize_claim_entry(item, thought_index, extraction_model)[1]

    for thought_index in range(1, thought_count + 1):
        normalized.setdefault(
            thought_index,
            {
                "claim_extraction_version": CLAIM_EXTRACTION_VERSION,
                "claim_extracted_at": datetime.now(timezone.utc).isoformat(),
                "claim_extraction_model": extraction_model,
            },
        )

    return [normalized[index] for index in range(1, thought_count + 1)]


def build_claim_user_payload(source_name, title, date_str, full_text, thoughts):
    thought_lines = [f"{index}. {thought}" for index, thought in enumerate(thoughts, 1)]
    return "\n\n".join(
        [
            f"Source: {source_name}",
            f"Conversation title: {title}",
            f"Date: {date_str}",
            f"Visible conversation text:\n{full_text}",
            f"Distilled thoughts:\n" + "\n".join(thought_lines),
        ]
    )


def extract_claims_local(source_name, title, date_str, full_text, thoughts, prompt_template=None):
    thought_count = len(thoughts)
    resp = http_post_with_retry(
        f"{local_llm_base_url()}/chat/completions",
        body={
            "model": LOCAL_LLM_MODEL,
            "temperature": 0,
            "max_tokens": claim_output_limit(thought_count),
            "chat_template_kwargs": {
                "enable_thinking": LOCAL_LLM_ENABLE_THINKING,
            },
            "tools": [build_claims_tool(thought_count)],
            "tool_choice": "required",
            "messages": [
                {"role": "system", "content": build_claim_prompt(thought_count, prompt_template)},
                {
                    "role": "user",
                    "content": build_claim_user_payload(source_name, title, date_str, full_text, thoughts),
                },
            ],
        },
        timeout=180,
    )

    if not resp or resp.status_code != 200:
        status = resp.status_code if resp else "no response"
        raise RuntimeError(f"Local claim extraction failed ({status})")

    data = resp.json()
    result = extract_tool_arguments(data, "submit_claims")
    return normalize_claims(result, thought_count, LOCAL_LLM_MODEL)


def extract_claims_ollama(source_name, title, date_str, full_text, thoughts, model_name="qwen3", prompt_template=None):
    thought_count = len(thoughts)
    prompt = (
        f"{build_claim_prompt(thought_count, prompt_template)}\n\n"
        f"{build_claim_user_payload(source_name, title, date_str, full_text, thoughts)}\n\n"
        "Return only JSON with a top-level 'claims' array."
    )
    resp = requests.post(
        f"{OLLAMA_BASE}/api/generate",
        json={
            "model": model_name,
            "prompt": prompt,
            "stream": False,
            "format": "json",
        },
        timeout=180,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Ollama claim extraction failed ({resp.status_code})")

    raw = resp.json().get("response", "")
    result = normalize_json_payload(raw)
    return normalize_claims(result, thought_count, model_name)


def extract_claims(source_name, title, date_str, full_text, thoughts, *, model_backend="local", ollama_model="qwen3", prompt_template=None):
    if not thoughts:
        return []
    if model_backend == "local":
        return extract_claims_local(source_name, title, date_str, full_text, thoughts, prompt_template=prompt_template)
    if model_backend == "ollama":
        return extract_claims_ollama(
            source_name,
            title,
            date_str,
            full_text,
            thoughts,
            model_name=ollama_model,
            prompt_template=prompt_template,
        )
    raise ValueError(f"Unsupported claim extraction backend: {model_backend}")


def strip_thought_prefix(content):
    if not isinstance(content, str):
        return ""
    return re.sub(r"^\[[^\]]+\]\s*", "", content.strip())
