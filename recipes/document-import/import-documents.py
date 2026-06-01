#!/usr/bin/env python3
"""
Open Brain — Document Importer

Converts local documents with the LAN Docling service, ingests the extracted
chunks into the local OB1 service, and can also create 0-3 summary thoughts
per document with the canonical local oMLX endpoint.
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
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
STATE_SCHEMA_VERSION = 1
BUNDLE_SCHEMA_VERSION = 1
DEFAULT_ARTIFACT_ROOT = first_env(
    "OPEN_BRAIN_DOCUMENT_ARTIFACT_ROOT",
    "DOCUMENT_IMPORT_ARTIFACT_ROOT",
    default=str(REPO_ROOT / "local" / "open-brain-mcp" / ".runtime" / "document-import-artifacts"),
)
SUPPORTED_DOCUMENT_SUFFIXES = {
    ".bmp",
    ".csv",
    ".doc",
    ".docx",
    ".gif",
    ".htm",
    ".html",
    ".jpeg",
    ".jpg",
    ".md",
    ".pdf",
    ".png",
    ".ppt",
    ".pptx",
    ".rtf",
    ".tif",
    ".tiff",
    ".txt",
    ".webp",
    ".xls",
    ".xlsx",
}
GENERATED_FILE_SUFFIXES = {".err", ".json", ".jsonl", ".log"}
GENERATED_FILE_NAMES = {
    "_conversion_manifest.json",
    "_conversion_forensics.json",
    "_docling_rescue_manifest.jsonl",
    "_failed_pdfs.txt",
    "_failed_pdfs.initial.txt",
    "_remaining_failed_pdfs.txt",
}
GENERATED_DIR_NAMES = {"_Docling Rescue"}
SIDECAR_STATE_DIR = "state"
SIDECAR_CONTENT_DIR = "content"
SIDECAR_ARTIFACT_DIR = "artifacts"
BUNDLE_MANIFEST_FILENAME = "bundles.jsonl"
RUN_MANIFEST_FILENAME = "import-runs.jsonl"


def is_relative_to(path, root):
    try:
        Path(path).resolve().relative_to(Path(root).resolve())
        return True
    except ValueError:
        return False


def is_generated_bookkeeping_file(path):
    path = Path(path)
    if path.name in GENERATED_FILE_NAMES:
        return True
    if path.name.startswith("_") and path.suffix.lower() in {".json", ".jsonl", ".txt", ".err", ".log"}:
        return True
    return path.suffix.lower() in GENERATED_FILE_SUFFIXES


def is_supported_document_file(path):
    return Path(path).suffix.lower() in SUPPORTED_DOCUMENT_SUFFIXES


def should_ignore_candidate(path, artifact_root=None):
    path = Path(path)
    if any(part in GENERATED_DIR_NAMES for part in path.parts):
        return True
    if artifact_root and is_relative_to(path, artifact_root):
        return True
    return is_generated_bookkeeping_file(path)


def iter_files(paths, recursive, *, artifact_root=None):
    files = []
    for raw in paths:
        path = Path(raw).expanduser().resolve()
        if not path.exists():
            raise FileNotFoundError(f"Path does not exist: {path}")
        if path.is_file():
            if is_supported_document_file(path) and not should_ignore_candidate(path, artifact_root=artifact_root):
                files.append(path)
            continue
        if recursive:
            files.extend(
                sorted(
                    p
                    for p in path.rglob("*")
                    if p.is_file()
                    and is_supported_document_file(p)
                    and not should_ignore_candidate(p, artifact_root=artifact_root)
                )
            )
        else:
            files.extend(
                sorted(
                    p
                    for p in path.iterdir()
                    if p.is_file()
                    and is_supported_document_file(p)
                    and not should_ignore_candidate(p, artifact_root=artifact_root)
                )
            )
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


def utc_now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def path_mtime_iso(path):
    return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def state_key_for_path(path):
    return str(Path(path).expanduser().resolve())


def new_import_state():
    return {
        "schema_version": STATE_SCHEMA_VERSION,
        "updated_at": None,
        "files": {},
    }


def load_import_state(state_file):
    if not state_file:
        return new_import_state()

    path = Path(state_file).expanduser().resolve()
    if not path.exists():
        return new_import_state()

    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"Import state file is not a JSON object: {path}")

    files = payload.get("files")
    if not isinstance(files, dict):
        files = {}

    return {
        "schema_version": payload.get("schema_version", STATE_SCHEMA_VERSION),
        "updated_at": payload.get("updated_at"),
        "files": files,
    }


def save_import_state(state_file, state):
    if not state_file:
        return

    path = Path(state_file).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(f"{path.suffix}.tmp")
    tmp_path.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp_path.replace(path)


def should_skip_unchanged(state, path, document_hash):
    entry = state.get("files", {}).get(state_key_for_path(path))
    return bool(
        entry
        and entry.get("status") == "success"
        and entry.get("document_sha256") == document_hash
    )


def update_import_state(state, path, *, document_hash, status, result=None, error=None):
    result = result or {}
    key = state_key_for_path(path)
    state["files"][key] = {
        "path": key,
        "filename": path.name,
        "document_sha256": document_hash,
        "size_bytes": path.stat().st_size,
        "mtime": path_mtime_iso(path),
        "status": status,
        "chunk_count": int(result.get("chunk_count", 0) or 0),
        "summary_count": int(result.get("summary_count", 0) or 0),
        "summary_error": result.get("summary_error"),
        "bundle_path": result.get("bundle_path"),
        "markdown_path": result.get("markdown_path"),
        "markdown_sha256": result.get("document_markdown_sha256"),
        "error": error,
        "updated_at": utc_now_iso(),
    }
    state["updated_at"] = utc_now_iso()


def source_roots_for_paths(paths):
    roots = []
    for raw in paths:
        path = Path(raw).expanduser().resolve()
        root = path.parent if path.is_file() else path
        if root not in roots:
            roots.append(root)
    return roots


def source_relative_path(path, source_roots):
    path = Path(path).expanduser().resolve()
    matches = []
    for root in source_roots:
        root = Path(root).expanduser().resolve()
        if is_relative_to(path, root):
            matches.append(path.relative_to(root))
    if not matches:
        return Path(path.name)
    return min(matches, key=lambda value: len(value.parts))


def append_hash_suffix(path, document_hash):
    suffix = document_hash[:12]
    return path.with_name(f"{path.stem}.{suffix}{path.suffix}")


def safe_relative_path(path):
    parts = []
    for part in Path(path).parts:
        cleaned = re.sub(r"[\x00-\x1f:]", "_", part).strip()
        if cleaned in {"", ".", ".."}:
            cleaned = "_"
        parts.append(cleaned)
    return Path(*parts)


def sidecar_paths_for_source(path, source_roots, artifact_root, document_hash, used_content_paths=None):
    artifact_root = Path(artifact_root).expanduser().resolve()
    source_rel = safe_relative_path(source_relative_path(path, source_roots))
    content_rel = source_rel.with_suffix(".md")
    artifact_rel = source_rel.with_name(f"{source_rel.name}.json")
    used_content_paths = used_content_paths if used_content_paths is not None else {}

    content_key = str(content_rel)
    source_key = str(Path(path).expanduser().resolve())
    collision = False
    if content_key in used_content_paths and used_content_paths[content_key] != source_key:
        collision = True

    candidate_bundle_path = artifact_root / SIDECAR_ARTIFACT_DIR / artifact_rel
    if not collision and candidate_bundle_path.exists():
        try:
            existing = json.loads(candidate_bundle_path.read_text(encoding="utf-8"))
            existing_source = existing.get("source") or {}
            existing_source_path = existing_source.get("path")
            existing_source_hash = existing_source.get("sha256")
            collision = bool(existing_source_path and existing_source_path != source_key) or bool(
                existing_source_path == source_key
                and existing_source_hash
                and existing_source_hash != document_hash
            )
        except (json.JSONDecodeError, OSError):
            collision = True

    if collision:
        content_rel = append_hash_suffix(content_rel, document_hash)
        artifact_rel = append_hash_suffix(artifact_rel, document_hash)
    used_content_paths[str(content_rel)] = source_key

    return {
        "source_relative_path": str(source_rel),
        "markdown_relative_path": str(Path(SIDECAR_CONTENT_DIR) / content_rel),
        "bundle_relative_path": str(Path(SIDECAR_ARTIFACT_DIR) / artifact_rel),
        "markdown_path": artifact_root / SIDECAR_CONTENT_DIR / content_rel,
        "bundle_path": artifact_root / SIDECAR_ARTIFACT_DIR / artifact_rel,
    }


def sidecar_state_path(artifact_root, filename):
    return Path(artifact_root).expanduser().resolve() / SIDECAR_STATE_DIR / filename


def write_text_atomic(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(f"{path.suffix}.tmp")
    tmp_path.write_text(text, encoding="utf-8")
    tmp_path.replace(path)


def write_json_atomic(path, payload):
    write_text_atomic(path, json.dumps(payload, indent=2, sort_keys=True) + "\n")


def append_jsonl(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(payload, sort_keys=True) + "\n")


def path_or_none(path):
    if path is None:
        return None
    return str(Path(path).expanduser().resolve())


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


def source_info_for_path(path, document_hash, source_relative_path_value=None):
    path = Path(path).expanduser().resolve()
    return {
        "path": str(path),
        "relative_path": source_relative_path_value or path.name,
        "filename": path.name,
        "sha256": document_hash,
        "mimetype": file_content_type(path),
        "size_bytes": path.stat().st_size,
        "mtime": path_mtime_iso(path),
    }


def normalized_markdown_info(path, markdown_text, markdown_path=None, markdown_relative_path=None):
    markdown_hash = sha256_text(markdown_text)
    return {
        "path": path_or_none(markdown_path),
        "relative_path": markdown_relative_path,
        "filename": Path(markdown_path).name if markdown_path else f"{Path(path).stem}.md",
        "sha256": markdown_hash,
        "retained": bool(markdown_path),
    }


def build_extraction_bundle(path, extraction, *, document_hash, sidecar_paths, markdown_info):
    source_info = source_info_for_path(
        path,
        document_hash,
        source_relative_path_value=sidecar_paths["source_relative_path"],
    )
    bundle = {
        "schema_version": BUNDLE_SCHEMA_VERSION,
        "created_at": utc_now_iso(),
        "source": source_info,
        "normalized_markdown": markdown_info,
        "docling": {
            "chunker": extraction["chunker"],
            "pipeline_used": extraction["pipeline_used"],
            "fallback_triggered": extraction["fallback_triggered"],
            "quality_signals": extraction["quality_signals"],
            "chunk_count": len(extraction["chunks"]),
            "raw_payload": extraction.get("raw_payload"),
        },
        "chunks": extraction["chunks"],
        "document_text": extraction["document_text"],
        "artifact": {
            "path": path_or_none(sidecar_paths["bundle_path"]),
            "relative_path": sidecar_paths["bundle_relative_path"],
        },
    }
    return bundle


def write_extraction_bundle(path, args, extraction, *, document_hash, sidecar_paths):
    markdown_text = docling_markdown_artifact(path.name, extraction).rstrip() + "\n"
    markdown_path = sidecar_paths["markdown_path"] if args.materialize_markdown else None
    markdown_relative_path = sidecar_paths["markdown_relative_path"] if args.materialize_markdown else None
    markdown_info = normalized_markdown_info(
        path,
        markdown_text,
        markdown_path=markdown_path,
        markdown_relative_path=markdown_relative_path,
    )

    if markdown_path:
        write_text_atomic(markdown_path, markdown_text.rstrip() + "\n")

    extraction = {
        **extraction,
        "chunker": args.chunker,
    }
    bundle = build_extraction_bundle(
        path,
        extraction,
        document_hash=document_hash,
        sidecar_paths=sidecar_paths,
        markdown_info=markdown_info,
    )
    write_json_atomic(sidecar_paths["bundle_path"], bundle)
    bundle_hash = sha256_file(sidecar_paths["bundle_path"])

    append_jsonl(
        sidecar_state_path(args.artifact_root, BUNDLE_MANIFEST_FILENAME),
        {
            "schema_version": BUNDLE_SCHEMA_VERSION,
            "updated_at": utc_now_iso(),
            "source_path": bundle["source"]["path"],
            "source_sha256": bundle["source"]["sha256"],
            "bundle_path": bundle["artifact"]["path"],
            "bundle_sha256": bundle_hash,
            "markdown_path": bundle["normalized_markdown"]["path"],
            "markdown_sha256": bundle["normalized_markdown"]["sha256"],
        },
    )
    bundle["artifact"]["sha256"] = bundle_hash
    return bundle


def load_extraction_bundle(path):
    path = Path(path).expanduser().resolve()
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"Extraction bundle is not a JSON object: {path}")
    if payload.get("schema_version") != BUNDLE_SCHEMA_VERSION:
        raise RuntimeError(f"Unsupported extraction bundle schema in {path}: {payload.get('schema_version')}")
    payload.setdefault("artifact", {})
    payload["artifact"]["path"] = str(path)
    payload["artifact"]["sha256"] = sha256_file(path)
    return payload


def iter_bundle_paths(paths):
    bundle_paths = []
    for raw in paths:
        path = Path(raw).expanduser().resolve()
        if not path.exists():
            raise FileNotFoundError(f"Path does not exist: {path}")
        if path.is_file():
            if path.suffix.lower() == ".json":
                bundle_paths.append(path)
                continue
            if path.name.endswith(".jsonl"):
                for line in path.read_text(encoding="utf-8").splitlines():
                    if not line.strip():
                        continue
                    row = json.loads(line)
                    bundle_path = row.get("bundle_path")
                    if bundle_path:
                        bundle_paths.append(Path(bundle_path).expanduser().resolve())
                continue
            raise RuntimeError(f"Unsupported bundle input file: {path}")

        manifest = sidecar_state_path(path, BUNDLE_MANIFEST_FILENAME)
        if not manifest.exists():
            raise RuntimeError(f"Artifact root is missing bundle manifest: {manifest}")
        for line in manifest.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            bundle_path = row.get("bundle_path")
            if bundle_path:
                bundle_paths.append(Path(bundle_path).expanduser().resolve())

    unique = []
    seen = set()
    for bundle_path in bundle_paths:
        key = str(bundle_path)
        if key in seen:
            continue
        seen.add(key)
        unique.append(bundle_path)
    return unique


def document_artifact_refs(path, args, *, extraction, document_hash, bundle):
    normalized_markdown = bundle.get("normalized_markdown") or {}
    local_markdown_path = normalized_markdown.get("path")
    if local_markdown_path and Path(local_markdown_path).exists():
        markdown_text = Path(local_markdown_path).read_text(encoding="utf-8")
    else:
        markdown_text = docling_markdown_artifact(path.name, extraction)
    markdown_filename = f"{path.stem}.md"
    markdown_hash = normalized_markdown.get("sha256") or sha256_text(markdown_text)

    if args.dry_run or not args.retain_artifacts:
        return {
            "markdown_text": markdown_text,
            "original": {
                "storage_backend": "file",
                "bucket": None,
                "object_key": None,
                "retained": False,
                "filename": path.name,
                "local_path": str(Path(path).expanduser().resolve()),
            },
            "markdown": {
                "storage_backend": "file" if local_markdown_path else "inline_only",
                "bucket": None,
                "object_key": local_markdown_path,
                "retained": bool(local_markdown_path),
                "filename": normalized_markdown.get("filename") or markdown_filename,
                "sha256": markdown_hash,
                "local_path": local_markdown_path,
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
            "local_path": str(Path(path).expanduser().resolve()),
        },
        "markdown": {
            "storage_backend": markdown_ref["storage_backend"],
            "bucket": markdown_ref["bucket"],
            "object_key": markdown_ref["object_key"],
            "retained": True,
            "filename": markdown_ref["original_filename"],
            "sha256": markdown_hash,
            "local_path": local_markdown_path,
        },
    }


def artifact_refs_from_bundle(bundle):
    source = bundle["source"]
    normalized_markdown = bundle.get("normalized_markdown") or {}
    return {
        "markdown_text": bundle.get("document_text") or "",
        "original": {
            "storage_backend": "file",
            "bucket": None,
            "object_key": None,
            "retained": False,
            "filename": source["filename"],
            "local_path": source["path"],
        },
        "markdown": {
            "storage_backend": "file" if normalized_markdown.get("path") else "inline_only",
            "bucket": None,
            "object_key": normalized_markdown.get("path"),
            "retained": bool(normalized_markdown.get("path")),
            "filename": normalized_markdown.get("filename") or f"{Path(source['filename']).stem}.md",
            "sha256": normalized_markdown.get("sha256"),
            "local_path": normalized_markdown.get("path"),
        },
    }


def bundle_source_path(bundle):
    return Path(bundle["source"]["path"]).expanduser()


def ingest_bundle(bundle, args, artifact_refs, *, summary_thoughts=None, summary_error=None):
    source = bundle["source"]
    chunks = bundle["chunks"]
    document_text = bundle.get("document_text") or ""
    docling = bundle["docling"]
    bundle_artifact = bundle.get("artifact") or {}
    bundle_path = bundle_artifact.get("path")
    bundle_hash = bundle_artifact.get("sha256")

    summary_thoughts = summary_thoughts if summary_thoughts is not None else []
    if not args.no_summaries and document_text.strip():
        try:
            summary_thoughts = summarize_document(source["filename"], document_text)
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

    print(f"document_original_retained={artifact_refs['original']['retained']}")
    print(f"document_markdown_retained={artifact_refs['markdown']['retained']}")
    if args.verbose:
        print(f"document_markdown_sha256={artifact_refs['markdown']['sha256']}")

    if args.dry_run:
        return {
            "chunk_count": len(chunks),
            "summary_count": len(summary_thoughts),
            "document_sha256": source["sha256"],
            "document_markdown_sha256": artifact_refs["markdown"]["sha256"],
            "bundle_path": bundle_path,
            "bundle_sha256": bundle_hash,
            "markdown_path": artifact_refs["markdown"]["local_path"],
            "summary_error": summary_error,
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
            "document_filename": source["filename"],
            "document_path": source["path"],
            "document_sha256": source["sha256"],
            "document_mimetype": origin.get("mimetype") or source["mimetype"],
            "document_size_bytes": source["size_bytes"],
            "document_original_storage_backend": artifact_refs["original"]["storage_backend"],
            "document_original_bucket": artifact_refs["original"]["bucket"],
            "document_original_object_key": artifact_refs["original"]["object_key"],
            "document_original_retained": artifact_refs["original"]["retained"],
            "document_original_filename": artifact_refs["original"]["filename"],
            "document_original_local_path": artifact_refs["original"]["local_path"],
            "document_markdown_storage_backend": artifact_refs["markdown"]["storage_backend"],
            "document_markdown_bucket": artifact_refs["markdown"]["bucket"],
            "document_markdown_object_key": artifact_refs["markdown"]["object_key"],
            "document_markdown_retained": artifact_refs["markdown"]["retained"],
            "document_markdown_filename": artifact_refs["markdown"]["filename"],
            "document_markdown_sha256": artifact_refs["markdown"]["sha256"],
            "document_markdown_local_path": artifact_refs["markdown"]["local_path"],
            "document_extraction_bundle_path": bundle_path,
            "document_extraction_bundle_sha256": bundle_hash,
            "document_chunk_index": chunk.get("chunk_index"),
            "document_chunk_count": len(chunks),
            "document_page_numbers": chunk.get("page_numbers") or [],
            "document_headings": headings,
            "document_doc_items": chunk.get("doc_items") or [],
            "docling_chunker": docling["chunker"],
            "docling_pipeline_used": docling["pipeline_used"],
            "docling_fallback_triggered": docling["fallback_triggered"],
            "docling_quality_signals": docling["quality_signals"],
            "document_summary_extraction_error": summary_error,
            "docling_origin": origin,
        }
        dedupe_key = sha256_text(f"document:{source['sha256']}:chunk:{chunk.get('chunk_index')}")
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
            "document_filename": source["filename"],
            "document_path": source["path"],
            "document_sha256": source["sha256"],
            "document_chunk_count": len(chunks),
            "document_original_storage_backend": artifact_refs["original"]["storage_backend"],
            "document_original_bucket": artifact_refs["original"]["bucket"],
            "document_original_object_key": artifact_refs["original"]["object_key"],
            "document_original_retained": artifact_refs["original"]["retained"],
            "document_original_filename": artifact_refs["original"]["filename"],
            "document_original_local_path": artifact_refs["original"]["local_path"],
            "document_markdown_storage_backend": artifact_refs["markdown"]["storage_backend"],
            "document_markdown_bucket": artifact_refs["markdown"]["bucket"],
            "document_markdown_object_key": artifact_refs["markdown"]["object_key"],
            "document_markdown_retained": artifact_refs["markdown"]["retained"],
            "document_markdown_filename": artifact_refs["markdown"]["filename"],
            "document_markdown_sha256": artifact_refs["markdown"]["sha256"],
            "document_markdown_local_path": artifact_refs["markdown"]["local_path"],
            "document_extraction_bundle_path": bundle_path,
            "document_extraction_bundle_sha256": bundle_hash,
            "docling_chunker": docling["chunker"],
            "docling_pipeline_used": docling["pipeline_used"],
            "docling_fallback_triggered": docling["fallback_triggered"],
            "docling_quality_signals": docling["quality_signals"],
            "document_summary_extraction_error": summary_error,
        }
        dedupe_key = sha256_text(f"document:{source['sha256']}:summary:{idx}")
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
        "document_sha256": source["sha256"],
        "document_markdown_sha256": artifact_refs["markdown"]["sha256"],
        "bundle_path": bundle_path,
        "bundle_sha256": bundle_hash,
        "markdown_path": artifact_refs["markdown"]["local_path"],
        "summary_error": summary_error,
    }


def process_document(path, args, docling_base_url, *, document_hash=None, sidecar_paths=None):
    document_hash = document_hash or sha256_file(path)
    if sidecar_paths is None:
        sidecar_paths = sidecar_paths_for_source(
            path,
            [Path(path).expanduser().resolve().parent],
            args.artifact_root,
            document_hash,
        )
    print(f"\n== {path}")
    print(f"document_sha256={document_hash}")

    extraction = docling_chunk(docling_base_url, path, args.chunker)
    print(f"chunks={len(extraction['chunks'])}")
    print(f"docling_pipeline={extraction['pipeline_used']}")
    print(f"docling_fallback_triggered={extraction['fallback_triggered']}")

    bundle = write_extraction_bundle(
        path,
        args,
        extraction,
        document_hash=document_hash,
        sidecar_paths=sidecar_paths,
    )
    artifact_refs = document_artifact_refs(path, args, extraction=extraction, document_hash=document_hash, bundle=bundle)
    return ingest_bundle(bundle, args, artifact_refs)


def process_bundle(bundle_path, args):
    bundle = load_extraction_bundle(bundle_path)
    source = bundle["source"]
    print(f"\n== {bundle_path}")
    print(f"document_sha256={source['sha256']}")
    print(f"source_document={source['path']}")
    print(f"chunks={len(bundle['chunks'])}")
    print(f"docling_pipeline={bundle['docling']['pipeline_used']}")
    print(f"docling_fallback_triggered={bundle['docling']['fallback_triggered']}")
    artifact_refs = artifact_refs_from_bundle(bundle)
    return ingest_bundle(bundle, args, artifact_refs)


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
    parser.add_argument("--state-file", help="Optional JSON file that records per-file import status for repeat folder runs.")
    parser.add_argument(
        "--artifact-root",
        default=DEFAULT_ARTIFACT_ROOT,
        help="Local sidecar root for normalized Markdown, extraction bundles, and run state.",
    )
    parser.add_argument(
        "--materialize-markdown",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Write normalized Markdown into the local sidecar content directory.",
    )
    parser.add_argument(
        "--ingest-from-bundle",
        action="store_true",
        help="Read saved extraction bundles or an artifact root manifest instead of converting source files with Docling.",
    )
    parser.add_argument(
        "--skip-unchanged",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="When paired with --state-file, skip files whose SHA256 already has a successful recorded import.",
    )
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
    if args.skip_unchanged and not args.state_file:
        parser.error("--skip-unchanged requires --state-file.")
    if args.retain_artifacts and not args.dry_run and args.minio_secure is None:
        parser.error("Missing MinIO secure mode. Set MINIO_SECURE or pass --minio-secure/--no-minio-secure.")
    return args


def main():
    args = parse_args()
    args.artifact_root = str(Path(args.artifact_root).expanduser().resolve())

    try:
        if args.ingest_from_bundle:
            inputs = iter_bundle_paths(args.paths)
        else:
            inputs = iter_files(args.paths, args.recursive, artifact_root=args.artifact_root)
    except (FileNotFoundError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    if args.limit is not None:
        inputs = inputs[: args.limit]

    if not inputs:
        print("Error: no files found to process.", file=sys.stderr)
        return 1

    docling_base_url = None
    if not args.ingest_from_bundle:
        docling_base_url = discover_docling_base_url(args.docling_url)
        print(f"docling_base_url={docling_base_url}")
    print(f"ingest_url={LOCAL_INGEST_URL}")
    print(f"chunker={args.chunker}")
    print(f"artifact_root={args.artifact_root}")
    print(f"materialize_markdown={args.materialize_markdown}")
    print(f"ingest_from_bundle={args.ingest_from_bundle}")
    print(f"retain_artifacts={args.retain_artifacts}")
    print(f"skip_unchanged={args.skip_unchanged}")
    if args.state_file:
        print(f"state_file={Path(args.state_file).expanduser().resolve()}")
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
    skipped = 0
    state = load_import_state(args.state_file) if args.state_file else None
    source_roots = source_roots_for_paths(args.paths) if not args.ingest_from_bundle else []
    used_content_paths = {}

    for item in inputs:
        path = item
        document_hash = None
        try:
            if args.ingest_from_bundle:
                result = process_bundle(item, args)
            else:
                path = item
                document_hash = sha256_file(path)
                sidecar_paths = sidecar_paths_for_source(
                    path,
                    source_roots,
                    args.artifact_root,
                    document_hash,
                    used_content_paths=used_content_paths,
                )
                sidecar_ready = Path(sidecar_paths["bundle_path"]).exists() and (
                    not args.materialize_markdown or Path(sidecar_paths["markdown_path"]).exists()
                )
                if args.skip_unchanged and state is not None and sidecar_ready and should_skip_unchanged(state, path, document_hash):
                    skipped += 1
                    print(f"\n== {path}")
                    print(f"document_sha256={document_hash}")
                    print("skipped=unchanged")
                    continue
                result = process_document(
                    path,
                    args,
                    docling_base_url,
                    document_hash=document_hash,
                    sidecar_paths=sidecar_paths,
                )
            total_chunks += result["chunk_count"]
            total_summaries += result["summary_count"]
            if state is not None and not args.dry_run and not args.ingest_from_bundle:
                update_import_state(
                    state,
                    path,
                    document_hash=document_hash,
                    status="success",
                    result=result,
                )
        except Exception as exc:
            failures += 1
            if state is not None and not args.dry_run and not args.ingest_from_bundle and document_hash:
                update_import_state(
                    state,
                    path,
                    document_hash=document_hash,
                    status="failure",
                    error=str(exc),
                )
            print(f"ERROR {item}: {exc}", file=sys.stderr)

    if state is not None and not args.dry_run:
        save_import_state(args.state_file, state)

    append_jsonl(
        sidecar_state_path(args.artifact_root, RUN_MANIFEST_FILENAME),
        {
            "schema_version": 1,
            "finished_at": utc_now_iso(),
            "mode": "bundle" if args.ingest_from_bundle else "source",
            "dry_run": args.dry_run,
            "inputs": len(inputs),
            "skipped": skipped,
            "failures": failures,
            "chunks": total_chunks,
            "summary_thoughts": total_summaries,
        },
    )

    print("\n== Result ==")
    print(f"files={len(inputs)}")
    print(f"skipped={skipped}")
    print(f"failures={failures}")
    print(f"chunks={total_chunks}")
    print(f"summary_thoughts={total_summaries}")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
