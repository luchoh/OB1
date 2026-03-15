#!/usr/bin/env python3
"""
Shared local Docling + OB1 ingest helpers.

These functions power the standalone document importer and any other importer
that needs to turn files into searchable document chunks and summaries.
"""

import hashlib
import json
import mimetypes
import os
import re
import time
from functools import lru_cache
from pathlib import Path

import requests


LOCAL_LLM_BASE = os.environ.get("LLM_BASE_URL", "").rstrip("/")
LOCAL_LLM_MODEL = os.environ.get("LLM_MODEL", "mlx-community/Qwen3.5-397B-A17B-nvfp4")
LOCAL_LLM_SERVICE_NAME = os.environ.get("OPEN_BRAIN_LLM_SERVICE_NAME", "mlx-server")
LOCAL_LLM_ENABLE_THINKING = os.environ.get("LLM_ENABLE_THINKING", "false").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)

LOCAL_INGEST_URL = os.environ.get("OPEN_BRAIN_INGEST_URL") or "http://localhost:8787/ingest/thought"
LOCAL_INGEST_KEY = os.environ.get("OPEN_BRAIN_INGEST_KEY") or os.environ.get("MCP_ACCESS_KEY", "")

DOCLING_BASE_URL = os.environ.get("DOCLING_BASE_URL", "").rstrip("/")
DOCLING_SERVICE_NAME = os.environ.get("DOCLING_SERVICE_NAME", "docling")
DOCLING_FALLBACK_SERVICE_NAME = os.environ.get("DOCLING_FALLBACK_SERVICE_NAME", "docling-markdown")
CONSUL_HTTP_ADDR = os.environ.get("CONSUL_HTTP_ADDR", "https://consul.lincoln.luchoh.net").rstrip("/")
CONSUL_HTTP_TOKEN = os.environ.get("CONSUL_HTTP_TOKEN", "")
CONSUL_FORCE_DISCOVERY = os.environ.get("CONSUL_FORCE_DISCOVERY", "false").strip().lower() in ("1", "true", "yes", "on")
CONSUL_SKIP_TLS_VERIFY = os.environ.get("CONSUL_SKIP_TLS_VERIFY", "false").strip().lower() in ("1", "true", "yes", "on")
DOCLING_OCR_ENABLED = os.environ.get("DOCLING_OCR_ENABLED", "true").strip().lower() in ("1", "true", "yes", "on")
DOCLING_FORCE_OCR = os.environ.get("DOCLING_FORCE_OCR", "false").strip().lower() in ("1", "true", "yes", "on")
DOCLING_OCR_ENGINE = os.environ.get("DOCLING_OCR_ENGINE", "tesseract").strip() or "tesseract"
DOCLING_OCR_LANG = os.environ.get("DOCLING_OCR_LANG", "bul,eng").strip() or "bul,eng"
DOCLING_VLM_FALLBACK_ENABLED = os.environ.get("DOCLING_VLM_FALLBACK_ENABLED", "true").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
DOCLING_VLM_FALLBACK_MIN_TEXT_CHARS_PDF = int(os.environ.get("DOCLING_VLM_FALLBACK_MIN_TEXT_CHARS_PDF", "500"))
DOCLING_VLM_FALLBACK_MIN_TEXT_CHARS_IMAGE = int(os.environ.get("DOCLING_VLM_FALLBACK_MIN_TEXT_CHARS_IMAGE", "120"))
DOCLING_VLM_FALLBACK_MAX_SHORT_LINE_RATIO = float(
    os.environ.get("DOCLING_VLM_FALLBACK_MAX_SHORT_LINE_RATIO", "0.35")
)
DOCLING_VLM_FALLBACK_MIN_ALNUM_RATIO = float(os.environ.get("DOCLING_VLM_FALLBACK_MIN_ALNUM_RATIO", "0.55"))
DOCLING_VLM_FALLBACK_MAX_DUPLICATE_LINE_RATIO = float(
    os.environ.get("DOCLING_VLM_FALLBACK_MAX_DUPLICATE_LINE_RATIO", "0.30")
)
DOCLING_VLM_FALLBACK_MIN_LEXICAL_VARIETY = float(
    os.environ.get("DOCLING_VLM_FALLBACK_MIN_LEXICAL_VARIETY", "0.18")
)
DOCLING_VLM_FALLBACK_MIN_TOKEN_COUNT_FOR_VARIETY = int(
    os.environ.get("DOCLING_VLM_FALLBACK_MIN_TOKEN_COUNT_FOR_VARIETY", "200")
)
DOCLING_VLM_FALLBACK_REQUIRED_SOFT_FAILS = int(
    os.environ.get("DOCLING_VLM_FALLBACK_REQUIRED_SOFT_FAILS", "2")
)

THOUGHTS_TOOL = {
    "type": "function",
    "function": {
        "name": "submit_thoughts",
        "description": "Return extracted durable thoughts from the document.",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "required": ["thoughts"],
            "properties": {
                "thoughts": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Up to 3 standalone document summary thoughts.",
                }
            },
        },
    },
}

DOCUMENT_SUMMARY_PROMPT = """\
You are distilling a document into durable notes for a local personal knowledge base.

Return only information worth semantic retrieval later:
- decisions, constraints, procedures, or policies
- important contacts, systems, dates, or identifiers
- architecture or implementation details
- action-relevant facts the user would want to recover later

Skip:
- boilerplate, navigation, repeated headers, legal filler
- formatting notes
- trivial fragments that only make sense with the source open

Each thought must:
- stand alone without the original document open
- be written in neutral voice
- include concrete names or context when available
- be 1-3 sentences

Return a JSON object with exactly one key: "thoughts".
The value must be an array of 0-3 real thought strings.
If the document does not contain durable content worth storing, return {"thoughts": []}.
"""


def http_post_with_retry(url, *, headers=None, json_body=None, files=None, data=None, retries=2, timeout=180):
    headers = headers or {}
    for attempt in range(retries + 1):
        try:
            resp = requests.post(
                url,
                headers=headers,
                json=json_body,
                files=files,
                data=data,
                timeout=timeout,
            )
            if resp.status_code >= 500 and attempt < retries:
                time.sleep(attempt + 1)
                continue
            return resp
        except requests.RequestException:
            if attempt < retries:
                time.sleep(attempt + 1)
                continue
            raise
    return None


def extract_json_payload(text):
    trimmed = text.strip()
    if trimmed.startswith("```json"):
        trimmed = trimmed[7:].strip()
    elif trimmed.startswith("```"):
        trimmed = trimmed[3:].strip()
    if trimmed.endswith("```"):
        trimmed = trimmed[:-3].strip()

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


def truncate_text(text, limit=280):
    if len(text) <= limit:
        return text
    return f"{text[: limit - 1]}…"


def sha256_text(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


@lru_cache(maxsize=None)
def discover_consul_service_base_url(service_name):
    if not CONSUL_HTTP_ADDR:
        raise RuntimeError("CONSUL_HTTP_ADDR is not set")

    headers = {}
    if CONSUL_HTTP_TOKEN:
        headers["X-Consul-Token"] = CONSUL_HTTP_TOKEN

    resp = requests.get(
        f"{CONSUL_HTTP_ADDR}/v1/health/service/{service_name}?passing=1",
        headers=headers,
        timeout=20,
        verify=not CONSUL_SKIP_TLS_VERIFY,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Consul discovery failed for {service_name}: {resp.status_code}")

    payload = resp.json()
    if not payload:
        raise RuntimeError(f"Could not discover a passing Consul service: {service_name}")

    service = payload[0].get("Service", {})
    address = service.get("Address") or payload[0].get("Node", {}).get("Address")
    port = service.get("Port")
    if not address or not port:
        raise RuntimeError(f"Consul service {service_name} is missing address/port")

    return f"http://{address}:{port}"


def local_llm_base_url():
    if LOCAL_LLM_BASE and not CONSUL_FORCE_DISCOVERY:
        return LOCAL_LLM_BASE
    return f"{discover_consul_service_base_url(LOCAL_LLM_SERVICE_NAME)}/v1"


def discover_docling_base_url(override_url=None):
    if override_url:
        return override_url.rstrip("/")

    if DOCLING_BASE_URL and not CONSUL_FORCE_DISCOVERY:
        return DOCLING_BASE_URL

    service_names = []
    for name in (DOCLING_SERVICE_NAME, DOCLING_FALLBACK_SERVICE_NAME):
        if name and name not in service_names:
            service_names.append(name)

    for service_name in service_names:
        try:
            return discover_consul_service_base_url(service_name)
        except RuntimeError:
            continue

    tried = ", ".join(service_names)
    raise RuntimeError(f"Could not discover a passing Docling service in Consul. Tried: {tried}")


def file_content_type(path):
    guessed, _ = mimetypes.guess_type(Path(path).name)
    return guessed or "application/octet-stream"


def collect_chunk_text(chunks):
    return "\n\n".join(
        chunk.get("text", "").strip()
        for chunk in chunks
        if isinstance(chunk, dict) and isinstance(chunk.get("text"), str) and chunk.get("text").strip()
    ).strip()


def normalize_extracted_text(text):
    return re.sub(r"\s+", " ", (text or "")).strip()


def classify_file_kind(path):
    suffix = Path(path).suffix.lower()
    if suffix == ".pdf":
        return "pdf"
    if suffix in {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".gif", ".webp"}:
        return "image"
    return "other"


def score_extraction_quality(path, chunks, document_text):
    file_kind = classify_file_kind(path)
    normalized_text = normalize_extracted_text(document_text)
    raw_lines = [
        line.strip()
        for line in (document_text or "").splitlines()
        if isinstance(line, str) and line.strip()
    ]
    non_whitespace_chars = [char for char in normalized_text if not char.isspace()]
    alnum_chars = [char for char in non_whitespace_chars if char.isalnum()]
    tokens = re.findall(r"\w+", normalized_text.lower(), flags=re.UNICODE)

    unique_lines = len(set(raw_lines))
    duplicate_line_ratio = 0.0
    if raw_lines:
        duplicate_line_ratio = max(0.0, 1.0 - (unique_lines / len(raw_lines)))

    short_line_ratio = 0.0
    if raw_lines:
        short_line_ratio = sum(1 for line in raw_lines if len(line) <= 3) / len(raw_lines)

    alnum_ratio = 0.0
    if non_whitespace_chars:
        alnum_ratio = len(alnum_chars) / len(non_whitespace_chars)

    lexical_variety = None
    if len(tokens) >= DOCLING_VLM_FALLBACK_MIN_TOKEN_COUNT_FOR_VARIETY:
        lexical_variety = len(set(tokens)) / len(tokens)

    min_text_chars = DOCLING_VLM_FALLBACK_MIN_TEXT_CHARS_IMAGE if file_kind == "image" else DOCLING_VLM_FALLBACK_MIN_TEXT_CHARS_PDF

    hard_fail_reasons = []
    if not chunks:
        hard_fail_reasons.append("zero_chunks")
    if not normalized_text:
        hard_fail_reasons.append("empty_text")

    soft_fail_reasons = []
    if normalized_text and len(normalized_text) < min_text_chars:
        soft_fail_reasons.append("text_too_short")
    if raw_lines and short_line_ratio > DOCLING_VLM_FALLBACK_MAX_SHORT_LINE_RATIO:
        soft_fail_reasons.append("short_line_ratio_high")
    if non_whitespace_chars and alnum_ratio < DOCLING_VLM_FALLBACK_MIN_ALNUM_RATIO:
        soft_fail_reasons.append("alnum_ratio_low")
    if raw_lines and duplicate_line_ratio > DOCLING_VLM_FALLBACK_MAX_DUPLICATE_LINE_RATIO:
        soft_fail_reasons.append("duplicate_line_ratio_high")
    if lexical_variety is not None and lexical_variety < DOCLING_VLM_FALLBACK_MIN_LEXICAL_VARIETY:
        soft_fail_reasons.append("lexical_variety_low")

    return {
        "file_kind": file_kind,
        "chunk_count": len(chunks),
        "normalized_char_count": len(normalized_text),
        "line_count": len(raw_lines),
        "token_count": len(tokens),
        "min_text_chars": min_text_chars,
        "short_line_ratio": round(short_line_ratio, 4),
        "alnum_ratio": round(alnum_ratio, 4),
        "duplicate_line_ratio": round(duplicate_line_ratio, 4),
        "lexical_variety": round(lexical_variety, 4) if lexical_variety is not None else None,
        "hard_fail_reasons": hard_fail_reasons,
        "soft_fail_reasons": soft_fail_reasons,
    }


def should_run_vlm_fallback(signals):
    if signals["hard_fail_reasons"]:
        return True
    return len(signals["soft_fail_reasons"]) >= DOCLING_VLM_FALLBACK_REQUIRED_SOFT_FAILS


def docling_request(base_url, path, chunker, *, pipeline="standard", force_ocr=None):
    path = Path(path)
    endpoint = {
        "hierarchical": "/v1/chunk/hierarchical/file",
        "hybrid": "/v1/chunk/hybrid/file",
    }[chunker]
    form_data = {
        "convert_do_ocr": str(DOCLING_OCR_ENABLED).lower(),
        "convert_force_ocr": str(DOCLING_FORCE_OCR if force_ocr is None else force_ocr).lower(),
        "convert_ocr_engine": DOCLING_OCR_ENGINE,
        "convert_ocr_lang": DOCLING_OCR_LANG,
        "convert_pipeline": pipeline,
        "include_converted_doc": "true",
        "target_type": "inbody",
    }

    resp = None
    for attempt in range(3):
        with path.open("rb") as fh:
            try:
                resp = requests.post(
                    f"{base_url}{endpoint}",
                    files={"files": (path.name, fh, file_content_type(path))},
                    data=form_data,
                    timeout=600,
                )
            except requests.RequestException:
                if attempt < 2:
                    time.sleep(attempt + 1)
                    continue
                raise

        if resp.status_code >= 500 and attempt < 2:
            time.sleep(attempt + 1)
            continue
        break

    if not resp or resp.status_code != 200:
        body = resp.text[:500] if resp is not None else "no response"
        raise RuntimeError(f"Docling chunking failed for {path.name}: {resp.status_code if resp else 'no response'} {body}")

    return resp.json()


def docling_chunk(base_url, path, chunker, *, force_ocr=None):
    standard_payload = docling_request(base_url, path, chunker, pipeline="standard", force_ocr=force_ocr)
    standard_chunks = standard_payload.get("chunks", [])
    standard_text = collect_chunk_text(standard_chunks)
    standard_signals = score_extraction_quality(path, standard_chunks, standard_text)

    final_payload = standard_payload
    final_chunks = standard_chunks
    final_text = standard_text
    final_pipeline = "standard"
    fallback_triggered = False
    fallback_attempted = False
    fallback_error = None
    fallback_reasons = standard_signals["hard_fail_reasons"] + standard_signals["soft_fail_reasons"]

    if DOCLING_VLM_FALLBACK_ENABLED and should_run_vlm_fallback(standard_signals):
        fallback_attempted = True
        try:
            vlm_payload = docling_request(base_url, path, chunker, pipeline="vlm", force_ocr=force_ocr)
            vlm_chunks = vlm_payload.get("chunks", [])
            vlm_text = collect_chunk_text(vlm_chunks)
            vlm_signals = score_extraction_quality(path, vlm_chunks, vlm_text)

            if vlm_chunks:
                final_payload = vlm_payload
                final_chunks = vlm_chunks
                final_text = vlm_text
                final_pipeline = "vlm"
                fallback_triggered = True
                final_signals = vlm_signals
            else:
                fallback_error = "vlm_returned_zero_chunks"
                final_signals = standard_signals
        except Exception as exc:
            fallback_error = str(exc)
            final_signals = standard_signals
    else:
        final_signals = standard_signals

    if not final_chunks:
        raise RuntimeError(
            f"Docling returned zero chunks for {Path(path).name} with chunker={chunker} pipeline={final_pipeline}"
        )

    return {
        "chunks": final_chunks,
        "document_text": final_text,
        "pipeline_used": final_pipeline,
        "fallback_triggered": fallback_triggered,
        "quality_signals": {
            "standard": standard_signals,
            "final": final_signals,
            "fallback_reasons": fallback_reasons,
            "fallback_attempted": fallback_attempted,
            "fallback_error": fallback_error,
        },
        "raw_payload": final_payload,
    }


def summarize_document(title, document_text):
    truncated = document_text[:12000]
    resp = http_post_with_retry(
        f"{local_llm_base_url()}/chat/completions",
        headers={"Content-Type": "application/json"},
        json_body={
            "model": LOCAL_LLM_MODEL,
            "temperature": 0,
            "max_tokens": 700,
            "chat_template_kwargs": {
                "enable_thinking": LOCAL_LLM_ENABLE_THINKING,
            },
            "tools": [THOUGHTS_TOOL],
            "tool_choice": "required",
            "messages": [
                {"role": "system", "content": DOCUMENT_SUMMARY_PROMPT},
                {
                    "role": "user",
                    "content": f"Document title: {title}\n\nDocument content:\n{truncated}",
                },
            ],
        },
        timeout=240,
    )

    if not resp or resp.status_code != 200:
        status = resp.status_code if resp else "no response"
        raise RuntimeError(f"Local document summarization failed ({status})")

    result = extract_tool_arguments(resp.json(), "submit_thoughts")
    thoughts = result.get("thoughts", [])
    return [t.strip() for t in thoughts if isinstance(t, str) and t.strip()][:3]


def ingest_thought(content, metadata_dict, *, dedupe_key, thought_type, source="document", tags=None, extract_metadata=False):
    resp = http_post_with_retry(
        LOCAL_INGEST_URL,
        headers={
            "Content-Type": "application/json",
            "x-access-key": LOCAL_INGEST_KEY,
            "x-ingest-key": LOCAL_INGEST_KEY,
        },
        json_body={
            "content": content,
            "metadata": metadata_dict,
            "source": source,
            "type": thought_type,
            "tags": tags or [],
            "dedupe_key": dedupe_key,
            "extract_metadata": extract_metadata,
        },
        timeout=240,
    )

    if not resp:
        raise RuntimeError("No response from local OB1 ingest endpoint")
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"Local OB1 ingest failed ({resp.status_code}): {resp.text[:500]}")

    return resp.json()
