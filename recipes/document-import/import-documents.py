#!/usr/bin/env python3
"""
Open Brain — Document Importer

Converts local documents with the LAN Docling service, ingests the extracted
chunks into the local OB1 service, and can also create 0-3 summary thoughts
per document with the canonical local Qwen endpoint.
"""

import argparse
import hashlib
import json
import mimetypes
import os
import sys
import time
from pathlib import Path

try:
    import requests
except ImportError:
    print("Missing dependency: requests")
    print("Install with: pip install requests")
    sys.exit(1)

LOCAL_LLM_BASE = os.environ.get("LLM_BASE_URL", "http://10.10.10.101:8035/v1").rstrip("/")
LOCAL_LLM_MODEL = os.environ.get("LLM_MODEL", "mlx-community/Qwen3.5-397B-A17B-nvfp4")
LOCAL_LLM_ENABLE_THINKING = os.environ.get("LLM_ENABLE_THINKING", "false").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)

LOCAL_INGEST_URL = os.environ.get("OPEN_BRAIN_INGEST_URL") or "http://127.0.0.1:8787/ingest/thought"
LOCAL_INGEST_KEY = os.environ.get("OPEN_BRAIN_INGEST_KEY") or os.environ.get("MCP_ACCESS_KEY", "")

DOCLING_BASE_URL = os.environ.get("DOCLING_BASE_URL", "").rstrip("/")
DOCLING_SERVICE_NAME = os.environ.get("DOCLING_SERVICE_NAME", "docling")
DOCLING_FALLBACK_SERVICE_NAME = os.environ.get("DOCLING_FALLBACK_SERVICE_NAME", "docling-markdown")
CONSUL_HTTP_ADDR = os.environ.get("CONSUL_HTTP_ADDR", "").rstrip("/")
CONSUL_HTTP_TOKEN = os.environ.get("CONSUL_HTTP_TOKEN", "")

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
    """POST with exponential backoff retry on transient failures."""
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
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def discover_docling_base_url():
    if DOCLING_BASE_URL:
        return DOCLING_BASE_URL

    if not CONSUL_HTTP_ADDR:
        raise RuntimeError("DOCLING_BASE_URL is not set and CONSUL_HTTP_ADDR is unavailable")

    headers = {}
    if CONSUL_HTTP_TOKEN:
        headers["X-Consul-Token"] = CONSUL_HTTP_TOKEN

    service_names = []
    for name in (DOCLING_SERVICE_NAME, DOCLING_FALLBACK_SERVICE_NAME):
        if name and name not in service_names:
            service_names.append(name)

    for service_name in service_names:
        url = f"{CONSUL_HTTP_ADDR}/v1/health/service/{service_name}?passing=1"
        resp = requests.get(url, headers=headers, timeout=20)
        if resp.status_code != 200:
            continue
        payload = resp.json()
        if not payload:
            continue
        service = payload[0].get("Service", {})
        address = service.get("Address") or payload[0].get("Node", {}).get("Address")
        port = service.get("Port")
        if address and port:
            return f"http://{address}:{port}"

    tried = ", ".join(service_names)
    raise RuntimeError(f"Could not discover a passing Docling service in Consul. Tried: {tried}")


def file_content_type(path):
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def iter_files(paths, recursive):
    files = []
    for raw in paths:
        path = Path(raw).expanduser().resolve()
        if not path.exists():
            raise FileNotFoundError(f"Path does not exist: {path}")
        if path.is_file():
            files.append(path)
            continue
        if recursive:
            files.extend(sorted(p for p in path.rglob("*") if p.is_file()))
        else:
            files.extend(sorted(p for p in path.iterdir() if p.is_file()))
    # Preserve order but remove duplicates.
    unique = []
    seen = set()
    for path in files:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        unique.append(path)
    return unique


def docling_chunk(base_url, path, chunker):
    endpoint = {
        "hierarchical": "/v1/chunk/hierarchical/file",
        "hybrid": "/v1/chunk/hybrid/file",
    }[chunker]

    resp = None
    for attempt in range(3):
        with path.open("rb") as fh:
            try:
                resp = requests.post(
                    f"{base_url}{endpoint}",
                    files={"files": (path.name, fh, file_content_type(path))},
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

    payload = resp.json()
    chunks = payload.get("chunks", [])
    if not chunks:
        raise RuntimeError(f"Docling returned zero chunks for {path.name} with chunker={chunker}")
    return payload


def summarize_document(title, document_text):
    truncated = document_text[:12000]
    resp = http_post_with_retry(
        f"{LOCAL_LLM_BASE}/chat/completions",
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


def process_document(path, args, docling_base_url):
    document_hash = sha256_file(path)
    print(f"\n== {path}")
    print(f"document_sha256={document_hash}")

    chunk_payload = docling_chunk(docling_base_url, path, args.chunker)
    chunks = chunk_payload.get("chunks", [])
    document_text = "\n\n".join(
        chunk.get("text", "").strip()
        for chunk in chunks
        if isinstance(chunk.get("text"), str) and chunk.get("text").strip()
    )

    print(f"chunks={len(chunks)}")

    summary_thoughts = []
    if not args.no_summaries and document_text.strip():
        summary_thoughts = summarize_document(path.name, document_text)
        print(f"summary_thoughts={len(summary_thoughts)}")
        if args.verbose:
            for idx, thought in enumerate(summary_thoughts):
                print(f"  summary[{idx}] {thought}")
    elif args.no_summaries:
        print("summary_thoughts=skipped")
    else:
        print("summary_thoughts=0 (no convertible document text)")

    if args.dry_run:
        return {
            "chunk_count": len(chunks),
            "summary_count": len(summary_thoughts),
            "document_sha256": document_hash,
        }

    ingested_chunks = 0
    for chunk in chunks:
        headings = chunk.get("headings") or []
        origin = (chunk.get("metadata") or {}).get("origin") or {}
        metadata = {
            "source": "document",
            "type": "document_chunk",
            "summary": truncate_text(chunk.get("text", "").strip(), 280),
            "topics": headings,
            "document_filename": path.name,
            "document_path": str(path),
            "document_sha256": document_hash,
            "document_mimetype": origin.get("mimetype") or file_content_type(path),
            "document_size_bytes": path.stat().st_size,
            "document_chunk_index": chunk.get("chunk_index"),
            "document_chunk_count": len(chunks),
            "document_page_numbers": chunk.get("page_numbers") or [],
            "document_headings": headings,
            "document_doc_items": chunk.get("doc_items") or [],
            "docling_chunker": args.chunker,
            "docling_origin": origin,
        }
        dedupe_key = sha256_text(f"document:{document_hash}:chunk:{chunk.get('chunk_index')}")
        ingest_thought(
            chunk.get("text", "").strip(),
            metadata,
            dedupe_key=dedupe_key,
            thought_type="document_chunk",
            tags=headings,
            extract_metadata=False,
        )
        ingested_chunks += 1

    ingested_summaries = 0
    for idx, thought in enumerate(summary_thoughts):
        metadata = {
            "source": "document",
            "type": "document_summary",
            "summary": thought,
            "topics": [],
            "document_filename": path.name,
            "document_path": str(path),
            "document_sha256": document_hash,
            "document_chunk_count": len(chunks),
            "docling_chunker": args.chunker,
        }
        dedupe_key = sha256_text(f"document:{document_hash}:summary:{idx}")
        ingest_thought(
            thought,
            metadata,
            dedupe_key=dedupe_key,
            thought_type="document_summary",
            tags=["document", "summary"],
            extract_metadata=False,
        )
        ingested_summaries += 1

    return {
        "chunk_count": ingested_chunks,
        "summary_count": ingested_summaries,
        "document_sha256": document_hash,
    }


def parse_args():
    parser = argparse.ArgumentParser(description="Convert documents via Docling and ingest them into local OB1.")
    parser.add_argument("paths", nargs="+", help="One or more files or directories to import.")
    parser.add_argument("--recursive", action="store_true", help="Walk directories recursively.")
    parser.add_argument("--limit", type=int, help="Maximum number of files to process.")
    parser.add_argument(
        "--chunker",
        choices=("hierarchical", "hybrid"),
        default="hierarchical",
        help="Docling chunker to use. hierarchical is the current safe default.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Convert and summarize, but do not ingest.")
    parser.add_argument("--no-summaries", action="store_true", help="Skip whole-document summary extraction.")
    parser.add_argument("--docling-url", help="Override the Docling base URL instead of using env/Consul discovery.")
    parser.add_argument("--verbose", action="store_true", help="Print extracted summary thoughts.")
    return parser.parse_args()


def main():
    args = parse_args()
    try:
        files = iter_files(args.paths, args.recursive)
    except FileNotFoundError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    if args.limit is not None:
        files = files[: args.limit]

    if not files:
        print("Error: no files found to process.", file=sys.stderr)
        return 1

    docling_base_url = args.docling_url.rstrip("/") if args.docling_url else discover_docling_base_url()
    print(f"docling_base_url={docling_base_url}")
    print(f"ingest_url={LOCAL_INGEST_URL}")
    print(f"chunker={args.chunker}")
    print(f"dry_run={args.dry_run}")

    if not args.dry_run and not LOCAL_INGEST_KEY:
        print("Error: OPEN_BRAIN_INGEST_KEY or MCP_ACCESS_KEY is required for live ingest.", file=sys.stderr)
        return 1

    failures = 0
    total_chunks = 0
    total_summaries = 0

    for path in files:
        try:
            result = process_document(path, args, docling_base_url)
            total_chunks += result["chunk_count"]
            total_summaries += result["summary_count"]
        except Exception as exc:
            failures += 1
            print(f"ERROR {path}: {exc}", file=sys.stderr)

    print("\n== Result ==")
    print(f"files={len(files)}")
    print(f"failures={failures}")
    print(f"chunks={total_chunks}")
    print(f"summary_thoughts={total_summaries}")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
