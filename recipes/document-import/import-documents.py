#!/usr/bin/env python3
"""
Open Brain — Document Importer

Converts local documents with the LAN Docling service, ingests the extracted
chunks into the local OB1 service, and can also create 0-3 summary thoughts
per document with the canonical local Qwen endpoint.
"""

import argparse
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

try:
    import requests
except ImportError:
    print("Missing dependency: requests")
    print("Install with: pip install requests")
    sys.exit(1)

from recipes.shared_docling import (
    LOCAL_INGEST_KEY,
    LOCAL_INGEST_URL,
    discover_docling_base_url,
    docling_markdown_artifact,
    docling_chunk,
    file_content_type,
    ingest_thought,
    sha256_file,
    sha256_text,
    summarize_document,
    truncate_text,
)
from recipes.shared_object_store import env_flag, first_env, optional_env_flag, upload_file, upload_text


DEFAULT_RETAIN_ARTIFACTS = env_flag(
    "OPEN_BRAIN_DOCUMENT_RETAIN_ARTIFACTS",
    "OPEN_BRAIN_DOCUMENT_RETAIN_ORIGINALS",
    "DOCUMENT_IMPORT_RETAIN_ARTIFACTS",
    "DOCUMENT_IMPORT_RETAIN_ORIGINALS",
    default=False,
)
DEFAULT_MINIO_ENDPOINT = first_env(
    "MINIO_ENDPOINT",
    "OPEN_BRAIN_DOCUMENT_MINIO_ENDPOINT",
    "DOCUMENT_IMPORT_MINIO_ENDPOINT",
)
DEFAULT_MINIO_SERVICE_NAME = first_env(
    "MINIO_SERVICE_NAME",
    "OPEN_BRAIN_DOCUMENT_MINIO_SERVICE_NAME",
    "DOCUMENT_IMPORT_MINIO_SERVICE_NAME",
    default="minio",
)
DEFAULT_MINIO_ACCESS_KEY = first_env(
    "MINIO_ACCESS_KEY",
    "OPEN_BRAIN_DOCUMENT_MINIO_ACCESS_KEY",
    "DOCUMENT_IMPORT_MINIO_ACCESS_KEY",
)
DEFAULT_MINIO_SECRET_KEY = first_env(
    "MINIO_SECRET_KEY",
    "OPEN_BRAIN_DOCUMENT_MINIO_SECRET_KEY",
    "DOCUMENT_IMPORT_MINIO_SECRET_KEY",
)
DEFAULT_MINIO_SECURE = optional_env_flag(
    "MINIO_SECURE",
    "OPEN_BRAIN_DOCUMENT_MINIO_SECURE",
    "DOCUMENT_IMPORT_MINIO_SECURE",
)
DEFAULT_MINIO_BUCKET = first_env(
    "OPEN_BRAIN_DOCUMENT_MINIO_BUCKET",
    "DOCUMENT_IMPORT_MINIO_BUCKET",
    default="open-brain-document-originals",
)
DEFAULT_MINIO_PREFIX = first_env(
    "OPEN_BRAIN_DOCUMENT_MINIO_PREFIX",
    "DOCUMENT_IMPORT_MINIO_PREFIX",
    default="documents",
)


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


def minio_config(args, suffix):
    safe_prefix = "/".join(part for part in (args.minio_prefix.strip("/"), suffix.strip("/")) if part)
    return {
        "endpoint": args.minio_endpoint,
        "service_name": args.minio_service_name,
        "access_key": args.minio_access_key,
        "secret_key": args.minio_secret_key,
        "secure": args.minio_secure,
        "bucket": args.minio_bucket,
        "prefix": safe_prefix,
    }


def document_artifact_refs(path, args, *, extraction, document_hash):
    markdown_text = docling_markdown_artifact(path.name, extraction)
    markdown_filename = f"{path.stem}.md"
    markdown_hash = sha256_text(markdown_text)

    if args.dry_run or not args.retain_artifacts:
        return {
            "markdown_text": markdown_text,
            "original": {
                "storage_backend": "file",
                "bucket": None,
                "object_key": None,
                "retained": False,
                "filename": path.name,
            },
            "markdown": {
                "storage_backend": "inline_only",
                "bucket": None,
                "object_key": None,
                "retained": False,
                "filename": markdown_filename,
                "sha256": markdown_hash,
            },
        }

    original_ref = upload_file(
        minio_config(args, "originals"),
        path,
        sha256_hex=document_hash,
        content_type=file_content_type(path),
    )
    markdown_ref = upload_text(
        minio_config(args, "markdown"),
        markdown_text,
        sha256_hex=markdown_hash,
        filename=markdown_filename,
    )

    return {
        "markdown_text": markdown_text,
        "original": {
            "storage_backend": original_ref["storage_backend"],
            "bucket": original_ref["bucket"],
            "object_key": original_ref["object_key"],
            "retained": True,
            "filename": original_ref["original_filename"],
        },
        "markdown": {
            "storage_backend": markdown_ref["storage_backend"],
            "bucket": markdown_ref["bucket"],
            "object_key": markdown_ref["object_key"],
            "retained": True,
            "filename": markdown_ref["original_filename"],
            "sha256": markdown_hash,
        },
    }


def process_document(path, args, docling_base_url):
    document_hash = sha256_file(path)
    print(f"\n== {path}")
    print(f"document_sha256={document_hash}")

    extraction = docling_chunk(docling_base_url, path, args.chunker)
    chunks = extraction["chunks"]
    document_text = extraction["document_text"]
    pipeline_used = extraction["pipeline_used"]
    fallback_triggered = extraction["fallback_triggered"]
    quality_signals = extraction["quality_signals"]

    print(f"chunks={len(chunks)}")
    print(f"docling_pipeline={pipeline_used}")
    print(f"docling_fallback_triggered={fallback_triggered}")

    summary_thoughts = []
    summary_error = None
    if not args.no_summaries and document_text.strip():
        try:
            summary_thoughts = summarize_document(path.name, document_text)
            print(f"summary_thoughts={len(summary_thoughts)}")
            if args.verbose:
                for idx, thought in enumerate(summary_thoughts):
                    print(f"  summary[{idx}] {thought}")
        except Exception as exc:
            summary_error = str(exc)
            print(f"summary_thoughts=0 (summarization failed: {summary_error})")
    elif args.no_summaries:
        print("summary_thoughts=skipped")
    else:
        print("summary_thoughts=0 (no convertible document text)")

    artifact_refs = document_artifact_refs(path, args, extraction=extraction, document_hash=document_hash)
    print(f"document_original_retained={artifact_refs['original']['retained']}")
    print(f"document_markdown_retained={artifact_refs['markdown']['retained']}")
    if args.verbose:
        print(f"document_markdown_sha256={artifact_refs['markdown']['sha256']}")

    if args.dry_run:
        return {
            "chunk_count": len(chunks),
            "summary_count": len(summary_thoughts),
            "document_sha256": document_hash,
            "document_markdown_sha256": artifact_refs["markdown"]["sha256"],
        }

    ingested_chunks = 0
    for chunk in chunks:
        headings = chunk.get("headings") or []
        origin = (chunk.get("metadata") or {}).get("origin") or {}
        metadata = {
            "source": "document",
            "type": "document_chunk",
            "retrieval_role": "source",
            "summary": truncate_text(chunk.get("text", "").strip(), 280),
            "topics": headings,
            "document_filename": path.name,
            "document_path": str(path),
            "document_sha256": document_hash,
            "document_mimetype": origin.get("mimetype") or file_content_type(path),
            "document_size_bytes": path.stat().st_size,
            "document_original_storage_backend": artifact_refs["original"]["storage_backend"],
            "document_original_bucket": artifact_refs["original"]["bucket"],
            "document_original_object_key": artifact_refs["original"]["object_key"],
            "document_original_retained": artifact_refs["original"]["retained"],
            "document_original_filename": artifact_refs["original"]["filename"],
            "document_markdown_storage_backend": artifact_refs["markdown"]["storage_backend"],
            "document_markdown_bucket": artifact_refs["markdown"]["bucket"],
            "document_markdown_object_key": artifact_refs["markdown"]["object_key"],
            "document_markdown_retained": artifact_refs["markdown"]["retained"],
            "document_markdown_filename": artifact_refs["markdown"]["filename"],
            "document_markdown_sha256": artifact_refs["markdown"]["sha256"],
            "document_chunk_index": chunk.get("chunk_index"),
            "document_chunk_count": len(chunks),
            "document_page_numbers": chunk.get("page_numbers") or [],
            "document_headings": headings,
            "document_doc_items": chunk.get("doc_items") or [],
            "docling_chunker": args.chunker,
            "docling_pipeline_used": pipeline_used,
            "docling_fallback_triggered": fallback_triggered,
            "docling_quality_signals": quality_signals,
            "document_summary_extraction_error": summary_error,
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
            "retrieval_role": "distilled",
            "summary": thought,
            "topics": [],
            "document_filename": path.name,
            "document_path": str(path),
            "document_sha256": document_hash,
            "document_chunk_count": len(chunks),
            "document_original_storage_backend": artifact_refs["original"]["storage_backend"],
            "document_original_bucket": artifact_refs["original"]["bucket"],
            "document_original_object_key": artifact_refs["original"]["object_key"],
            "document_original_retained": artifact_refs["original"]["retained"],
            "document_original_filename": artifact_refs["original"]["filename"],
            "document_markdown_storage_backend": artifact_refs["markdown"]["storage_backend"],
            "document_markdown_bucket": artifact_refs["markdown"]["bucket"],
            "document_markdown_object_key": artifact_refs["markdown"]["object_key"],
            "document_markdown_retained": artifact_refs["markdown"]["retained"],
            "document_markdown_filename": artifact_refs["markdown"]["filename"],
            "document_markdown_sha256": artifact_refs["markdown"]["sha256"],
            "docling_chunker": args.chunker,
            "docling_pipeline_used": pipeline_used,
            "docling_fallback_triggered": fallback_triggered,
            "docling_quality_signals": quality_signals,
            "document_summary_extraction_error": summary_error,
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
        "summary_error": summary_error,
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
    parser.add_argument(
        "--retain-artifacts",
        action=argparse.BooleanOptionalAction,
        default=DEFAULT_RETAIN_ARTIFACTS,
        help="Store both the original document and the converted Markdown artifact in MinIO and attach those references to ingested metadata.",
    )
    parser.add_argument(
        "--minio-endpoint",
        default=DEFAULT_MINIO_ENDPOINT,
        help="Explicit MinIO endpoint host:port override. If unset, resolve the service name through Consul.",
    )
    parser.add_argument("--minio-service-name", default=DEFAULT_MINIO_SERVICE_NAME, help="Consul service name for MinIO discovery.")
    parser.add_argument("--minio-access-key", default=DEFAULT_MINIO_ACCESS_KEY, help="MinIO access key.")
    parser.add_argument("--minio-secret-key", default=DEFAULT_MINIO_SECRET_KEY, help="MinIO secret key.")
    parser.add_argument("--minio-secure", action=argparse.BooleanOptionalAction, default=DEFAULT_MINIO_SECURE, help="Use HTTPS for MinIO.")
    parser.add_argument("--minio-bucket", default=DEFAULT_MINIO_BUCKET, help="MinIO bucket for retained document artifacts.")
    parser.add_argument("--minio-prefix", default=DEFAULT_MINIO_PREFIX, help="MinIO key prefix for retained document artifacts.")
    parser.add_argument("--verbose", action="store_true", help="Print extracted summary thoughts.")
    args = parser.parse_args()
    if args.retain_artifacts and not args.dry_run and args.minio_secure is None:
        parser.error("Missing MinIO secure mode. Set MINIO_SECURE or pass --minio-secure/--no-minio-secure.")
    return args


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

    docling_base_url = discover_docling_base_url(args.docling_url)
    print(f"docling_base_url={docling_base_url}")
    print(f"ingest_url={LOCAL_INGEST_URL}")
    print(f"chunker={args.chunker}")
    print(f"retain_artifacts={args.retain_artifacts}")
    if args.retain_artifacts:
        print(f"minio_service_name={args.minio_service_name}")
        if args.minio_endpoint:
            print(f"minio_endpoint_override={args.minio_endpoint}")
        print(f"minio_bucket={args.minio_bucket}")
        print(f"minio_prefix={args.minio_prefix}")
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
