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

from recipes.shared_capture import CaptureClient


LOCAL_LLM_BASE = os.environ.get("LLM_BASE_URL", "").rstrip("/")
LOCAL_LLM_MODEL = os.environ.get("LLM_MODEL", "DeepSeek-V4-Flash-nvfp4")
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
DOCLING_FALLBACK_SERVICE_NAME = os.environ.get("DOCLING_FALLBACK_SERVICE_NAME", "").strip()
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

Return your answer by calling the submit_thoughts tool exactly once.
The "thoughts" argument must be an array of 0-3 real thought strings.
If the document does not contain durable content worth storing, call
submit_thoughts with an empty array.
Do not answer in prose.
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


def extract_json_payload(text, *, allow_embedded=True):
    """Parse a JSON object out of model output.

    allow_embedded controls only the last-resort scrape from the first "{" to
    the last "}", which discards everything outside those braces.
    """
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
        if not allow_embedded:
            raise
        start = trimmed.find("{")
        end = trimmed.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise
        return json.loads(trimmed[start : end + 1])


def normalize_chat_content(content):
    if isinstance(content, str):
        return content.strip()

    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        return "".join(parts).strip()

    return ""


def extract_inline_tool_arguments(content, expected_name):
    text = normalize_chat_content(content)
    if "<function=" not in text:
        return None

    function_match = re.search(r"<function=([^>\n]+)>\s*([\s\S]*)", text)
    if not function_match:
        return None

    function_name = function_match.group(1).strip()
    if not function_name or (expected_name and function_name != expected_name):
        return None

    body = function_match.group(2) or ""
    params = {}
    for match in re.finditer(r"<parameter=([^>\n]+)>\s*([\s\S]*?)\s*</parameter>", body):
        key = match.group(1).strip()
        if not key:
            continue
        raw_value = (match.group(2) or "").strip()
        try:
            params[key] = json.loads(raw_value)
        except json.JSONDecodeError:
            params[key] = raw_value

    return params or None


def chat_message(response_json):
    """The assistant message, or {} for any envelope shape we cannot read.

    Unguarded, response_json["choices"][0]["message"] reaches an operator as a
    raw IndexError or AttributeError. Returning {} funnels every unreadable
    envelope into the caller's own ValueError instead.
    """
    try:
        message = response_json["choices"][0]["message"]
    except (KeyError, IndexError, TypeError, AttributeError):
        return {}
    return message if isinstance(message, dict) else {}


def chat_finish_reason(response_json):
    """finish_reason for the first choice, or None if the envelope lacks it."""
    try:
        return response_json["choices"][0].get("finish_reason")
    except (KeyError, IndexError, TypeError, AttributeError):
        return None


def _tool_arguments_from_content(message, expected_name, *, scrape_content):
    if scrape_content:
        # extract_inline_tool_arguments regex-searches the whole string, so it
        # finds <function=...> markup with arbitrary prose around it. That is
        # the same "payload lifted out of text" shape the JSON scrape below
        # performs, through a different syntax, and it is skipped for the same
        # reason when the caller's verdict is irreversible.
        inline_tool_args = extract_inline_tool_arguments(
            message.get("content"), expected_name
        )
        if inline_tool_args:
            return inline_tool_args

    content = normalize_chat_content(message.get("content"))
    if content:
        try:
            return extract_json_payload(content, allow_embedded=scrape_content)
        except (TypeError, json.JSONDecodeError, ValueError):
            pass

    return None


def extract_tool_arguments(response_json, expected_name, *, scrape_content=True):
    """Parse a tool call, or fall back to content when the server ignored tool_choice.

    The content fallback is not a nicety: on 2026-08-11 this server was
    measured answering finish_reason=stop with no tool_calls at all, despite
    tool_choice "required". A parser that assumes a tool call arrived is a
    parser that raises on a perfectly good answer.

    scrape_content=False hardens only that fallback, for callers whose verdict
    is IRREVERSIBLE: content must be JSON end to end, inline <function=> markup
    is not lifted out of prose either, and the response must actually have
    finished (finish_reason "stop"). Scraping an object out of prose turns "I could not read this
    email, {"thoughts": []}" into a successful empty result: the model's stated
    reason is discarded and the message is retired for good. For a caller that
    can simply try again, the scrape is worth having and stays on by default.

    What this never does is judge whether the parsed object means what the
    model intended. Callers making an irreversible decision should also run the
    result through a shape gate — see validate_thoughts_payload.
    """
    message = chat_message(response_json)
    tool_calls = message.get("tool_calls")

    if not isinstance(tool_calls, list) or not tool_calls:
        if not scrape_content:
            # No shape check can see this: a response cut off mid-generation,
            # or refused by a filter, can still carry a complete and perfectly
            # well-formed object. finish_reason is the only field that says
            # what actually happened, so it is an ALLOWLIST — an unknown or
            # absent value is refused rather than assumed benign.
            #
            # Only the fallback is gated. A real tool call is the contract
            # working and is left alone.
            finish_reason = chat_finish_reason(response_json)
            if finish_reason != "stop":
                raise ValueError(
                    "Model did not return a tool call "
                    f"(finish_reason={finish_reason!r})"
                )

        from_content = _tool_arguments_from_content(
            message, expected_name, scrape_content=scrape_content
        )
        if from_content is not None:
            return from_content

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


def validate_thoughts_payload(payload):
    """Shape gate for submit_thoughts results — opt-in, per caller.

    Parsing only proves the response was JSON. It can still be {} or
    {"thoughts": "a string"}, both of which .get("thoughts", []) quietly turns
    into "no durable content". Callers that must not silently drop thoughts
    run the parsed payload through here instead.

    This is a SHAPE gate only. It cannot tell a genuine empty answer from a
    well-shaped one the model did not mean; nothing in the response
    distinguishes those. It catches the shapes that are wrong on their face.
    """
    if not isinstance(payload, dict):
        raise ValueError(f"Expected a thoughts object, got {type(payload).__name__}")

    if "thoughts" not in payload:
        raise ValueError('Response object is missing the "thoughts" key')

    # THOUGHTS_TOOL declares exactly one property, so anything else means the
    # model answered something other than the tool it was given — typically a
    # refusal carried beside an empty list, {"thoughts": [], "error": "..."},
    # which a key-blind gate records as "no durable content" and retires
    # permanently. The rule is the declared schema rather than a blacklist,
    # which would only move to the next key the model invents.
    extra = sorted(set(payload) - {"thoughts"})
    if extra:
        raise ValueError(
            'Response object carries keys outside the declared schema: '
            + ", ".join(repr(k) for k in extra)
        )

    thoughts = payload["thoughts"]
    if not isinstance(thoughts, list):
        raise ValueError(f'"thoughts" must be a list, got {type(thoughts).__name__}')

    for index, item in enumerate(thoughts):
        if not isinstance(item, str):
            raise ValueError(f'"thoughts"[{index}] must be a string, got {type(item).__name__}')

    return thoughts


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


def _dedupe_preserving_order(values):
    seen = set()
    ordered = []
    for value in values:
        normalized = (value or "").strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        ordered.append(normalized)
    return ordered


def render_markdown_from_chunks(chunks):
    parts = []
    last_headings = []

    for chunk in chunks or []:
        if not isinstance(chunk, dict):
            continue

        headings = _dedupe_preserving_order(chunk.get("headings") or [])
        for level, heading in enumerate(headings, start=1):
            if len(last_headings) >= level and last_headings[level - 1] == heading:
                continue
            parts.append(f"{'#' * min(level, 6)} {heading}")
        if headings:
            last_headings = headings

        text = (chunk.get("text") or "").strip()
        if text:
            parts.append(text)

    return "\n\n".join(part.strip() for part in parts if part and part.strip()).strip()


def docling_markdown_artifact(_path_name, extraction):
    raw_payload = extraction.get("raw_payload") if isinstance(extraction, dict) else None
    if isinstance(raw_payload, dict):
        for key in ("markdown", "md", "document_markdown"):
            value = raw_payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        document = raw_payload.get("document")
        if isinstance(document, dict):
            value = document.get("md_content")
            if isinstance(value, str) and value.strip():
                return value.strip()

    rendered = render_markdown_from_chunks((extraction or {}).get("chunks") or [])
    if rendered:
        return rendered
    return ((extraction or {}).get("document_text") or "").strip()


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


def vlm_result_is_better(standard_signals, vlm_signals):
    """Whether the VLM fallback output should REPLACE the standard output.

    The 2026-03-15 imap incident: a Cyrillic scan double-soft-failed the
    standard (tesseract) pipeline, the granite VLM fallback transcribed it
    into Latin-lookalike mojibake in a repetition loop, and the result was
    accepted UNCONDITIONALLY (`if vlm_chunks:`) even though its own quality
    signals were strictly worse (duplicate_line_ratio 0.708 vs 0.564). The
    signals were already computed for both sides — just never compared.

    Rules:
      * A VLM result with hard fails never wins.
      * If the standard result hard-failed (zero chunks / empty text), any
        hard-fail-free VLM result wins — something beats nothing.
      * Otherwise the VLM result must have strictly FEWER soft fails than
        the standard result, and must not sit above the duplicate-line
        threshold while also being worse than standard on that ratio.
    """
    if vlm_signals["hard_fail_reasons"]:
        return False
    if standard_signals["hard_fail_reasons"]:
        return True
    if len(vlm_signals["soft_fail_reasons"]) >= len(standard_signals["soft_fail_reasons"]):
        return False
    if (
        vlm_signals["duplicate_line_ratio"] > DOCLING_VLM_FALLBACK_MAX_DUPLICATE_LINE_RATIO
        and vlm_signals["duplicate_line_ratio"] > standard_signals["duplicate_line_ratio"]
    ):
        return False
    return True


class DoclingContentError(ValueError):
    """This FILE cannot be turned into chunks — as opposed to Docling being
    unavailable. A ValueError so callers classifying by cause see content,
    not infrastructure."""


class DoclingHttpError(RuntimeError):
    """A non-200 from Docling, carrying the status so a caller can tell a file
    Docling will never accept from Docling being unavailable. Subclasses
    RuntimeError, so existing `except Exception` / `except RuntimeError`
    handlers are unaffected."""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


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

    # `resp is None`, never `not resp`: requests.Response defines __bool__ as
    # status_code < 400, so a real 4xx/5xx response is FALSY and `not resp`
    # silently discards it along with the status we need to classify by.
    if resp is None or resp.status_code != 200:
        body = resp.text[:500] if resp is not None else "no response"
        # `is not None`, not truthiness — see the note above. This exact line
        # is why the status arrived as None for every 4xx.
        status = resp.status_code if resp is not None else None
        raise DoclingHttpError(
            f"Docling chunking failed for {path.name}: "
            f"{status if status is not None else 'no response'} {body}",
            status=status,
        )

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
    fallback_exception = None
    fallback_reasons = standard_signals["hard_fail_reasons"] + standard_signals["soft_fail_reasons"]

    if DOCLING_VLM_FALLBACK_ENABLED and should_run_vlm_fallback(standard_signals):
        fallback_attempted = True
        try:
            vlm_payload = docling_request(base_url, path, chunker, pipeline="vlm", force_ocr=force_ocr)
            vlm_chunks = vlm_payload.get("chunks", [])
            vlm_text = collect_chunk_text(vlm_chunks)
            vlm_signals = score_extraction_quality(path, vlm_chunks, vlm_text)

            if not vlm_chunks:
                fallback_error = "vlm_returned_zero_chunks"
                final_signals = standard_signals
            elif vlm_result_is_better(standard_signals, vlm_signals):
                final_payload = vlm_payload
                final_chunks = vlm_chunks
                final_text = vlm_text
                final_pipeline = "vlm"
                fallback_triggered = True
                final_signals = vlm_signals
            else:
                # 2026-03-15 incident guard: keep the standard output when the
                # VLM result is no better by its own quality signals.
                fallback_error = "vlm_result_not_better"
                final_signals = standard_signals
        except Exception as exc:
            fallback_error = str(exc)
            fallback_exception = exc
            final_signals = standard_signals
    else:
        final_signals = standard_signals

    if not final_chunks:
        # "Zero chunks" only means the FILE is unprocessable if we actually got
        # a verdict from Docling. When the VLM fallback was attempted and blew
        # up — service down, timeout, connection refused — its exception was
        # swallowed into fallback_error above, and calling the empty result a
        # content failure would retire a perfectly good attachment on the
        # strength of an outage. Only these two markers mean the fallback ran
        # and genuinely had nothing better to offer.
        fallback_had_a_verdict = fallback_error in (
            None, "vlm_returned_zero_chunks", "vlm_result_not_better",
        )
        if fallback_attempted and not fallback_had_a_verdict:
            # The fallback raised. Stringifying it threw away the one thing
            # that distinguishes "the VLM is down" from "the VLM looked at this
            # file and refused it" — so a permanent 4xx about the file was
            # laundered into a generic outage and retried forever. Re-raise the
            # original so its status survives.
            status = getattr(fallback_exception, "status", None)
            if status is not None:
                raise DoclingHttpError(
                    f"Docling returned zero chunks for {Path(path).name} and the vlm "
                    f"fallback rejected it: {fallback_error}",
                    status=status,
                ) from fallback_exception
            raise RuntimeError(
                f"Docling returned zero chunks for {Path(path).name} and the vlm "
                f"fallback failed, so whether the file is processable is unknown: "
                f"{fallback_error}"
            ) from fallback_exception
        raise DoclingContentError(
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
            # Same contract as distill_email_thoughts in the imap recipe (both
            # run in the same daemon): "required" plus a prompt that also asks
            # for the tool call, never a prompt that asks for a bare JSON
            # object while the request demands a tool call.
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

    if resp is None or resp.status_code != 200:
        status = resp.status_code if resp is not None else "no response"
        raise RuntimeError(f"Local document summarization failed ({status})")

    # Same shape gate as the email body. An earlier revision skipped it here on
    # the belief that raising would mark the whole message failed and re-Docling
    # it forever — that was a misreading: process_attachment in import-imap.py
    # catches this, stores summary_error and carries on with chunk ingest, so
    # message_failed is never set. Without the gate a malformed response
    # silently became zero attachment thoughts.
    result = extract_tool_arguments(resp.json(), "submit_thoughts")
    thoughts = validate_thoughts_payload(result)
    return [t.strip() for t in thoughts if t.strip()][:3]


def ingest_thought(content, metadata_dict, *, dedupe_key, thought_type, source="document", tags=None, extract_metadata=False):
    # Thin adapter over the shared Capture client (PRD docs/34, module 4,
    # decision A): this signature is preserved so its callers (document-import,
    # email-history-import) need no change, while capture traffic now shares the
    # one retry policy + header/auth convention. The payload shape is unchanged
    # — metadata_dict is the caller's pre-built block (no structured-core
    # injection), and no occurred_at key is sent, exactly as before.
    client = CaptureClient(
        "", LOCAL_INGEST_KEY, ingest_url=LOCAL_INGEST_URL
    )
    return client.capture(
        {
            "content": content,
            "metadata": metadata_dict,
            "source": source,
            "type": thought_type,
            "tags": tags or [],
            "dedupe_key": dedupe_key,
            "extract_metadata": extract_metadata,
        }
    )
