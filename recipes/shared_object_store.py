#!/usr/bin/env python3
"""
Shared MinIO-backed object-retention helpers for local OB1 importers.
"""

from __future__ import annotations

import io
import json
import os
import re
import ssl
from pathlib import Path
from urllib import error as urllib_error
from urllib import request as urllib_request


def env_flag(*names: str, default: bool = False) -> bool:
    for name in names:
        value = os.environ.get(name)
        if value is None:
            continue
        return value.strip().lower() in ("1", "true", "yes", "on")
    return default


def optional_env_flag(*names: str) -> bool | None:
    for name in names:
        value = os.environ.get(name)
        if value is None:
            continue
        return value.strip().lower() in ("1", "true", "yes", "on")
    return None


def first_env(*names: str, default: str = "") -> str:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return default


def sanitize_object_name(name: str) -> str:
    cleaned = (name or "").strip().replace("\\", "/").split("/")[-1]
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", cleaned).strip("-.")
    return cleaned or "file.bin"


def content_addressed_object_key(prefix: str, sha256_hex: str, filename: str) -> str:
    safe_prefix = prefix.strip("/")
    suffix = Path(filename).suffix.lower() or Path(sanitize_object_name(filename)).suffix.lower() or ".bin"
    base_name = f"original{suffix}"
    path_parts = [part for part in (safe_prefix, sha256_hex[:2], sha256_hex, base_name) if part]
    return "/".join(path_parts)


def discover_consul_service_endpoint(
    service_name: str,
    *,
    consul_addr: str = "",
    consul_token: str = "",
    skip_tls_verify: bool | None = None,
) -> str:
    effective_service_name = (service_name or "").strip()
    if not effective_service_name:
        raise RuntimeError("Consul service discovery requires a non-empty service name.")

    effective_consul_addr = (consul_addr or os.environ.get("CONSUL_HTTP_ADDR") or "").rstrip("/")
    if not effective_consul_addr:
        raise RuntimeError("CONSUL_HTTP_ADDR is not set.")

    effective_consul_token = consul_token or os.environ.get("CONSUL_HTTP_TOKEN") or ""
    effective_skip_tls_verify = env_flag("CONSUL_SKIP_TLS_VERIFY", default=False) if skip_tls_verify is None else skip_tls_verify

    request = urllib_request.Request(f"{effective_consul_addr}/v1/health/service/{effective_service_name}?passing=1")
    if effective_consul_token:
        request.add_header("X-Consul-Token", effective_consul_token)

    context = ssl._create_unverified_context() if effective_skip_tls_verify else None

    try:
        with urllib_request.urlopen(request, timeout=20, context=context) as response:
            payload = json.load(response)
    except urllib_error.HTTPError as exc:
        raise RuntimeError(f"Consul discovery failed for {effective_service_name}: HTTP {exc.code}") from exc
    except urllib_error.URLError as exc:
        raise RuntimeError(f"Consul discovery failed for {effective_service_name}: {exc.reason}") from exc

    if not payload:
        raise RuntimeError(f"Could not discover a passing Consul service: {effective_service_name}")

    service = payload[0].get("Service", {})
    address = service.get("Address") or payload[0].get("Node", {}).get("Address")
    port = service.get("Port")
    if not address or not port:
        raise RuntimeError(f"Consul service {effective_service_name} is missing address/port")

    return f"{address}:{port}"


def resolve_minio_endpoint(
    endpoint: str,
    *,
    service_name: str = "",
    consul_addr: str = "",
    consul_token: str = "",
    consul_skip_tls_verify: bool | None = None,
) -> str:
    effective_endpoint = (endpoint or "").strip()
    if effective_endpoint:
        return effective_endpoint

    effective_service_name = (service_name or os.environ.get("MINIO_SERVICE_NAME") or "").strip()
    if not effective_service_name:
        return ""

    return discover_consul_service_endpoint(
        effective_service_name,
        consul_addr=consul_addr,
        consul_token=consul_token,
        skip_tls_verify=consul_skip_tls_verify,
    )


def normalize_minio_config(config: dict) -> dict:
    resolved = dict(config)
    resolved["endpoint"] = resolve_minio_endpoint(
        resolved.get("endpoint", ""),
        service_name=resolved.get("service_name", ""),
        consul_addr=resolved.get("consul_addr", ""),
        consul_token=resolved.get("consul_token", ""),
        consul_skip_tls_verify=resolved.get("consul_skip_tls_verify"),
    )
    return resolved


def minio_client(
    endpoint: str,
    access_key: str,
    secret_key: str,
    secure: bool,
    *,
    service_name: str = "",
    consul_addr: str = "",
    consul_token: str = "",
    consul_skip_tls_verify: bool | None = None,
):
    try:
        from minio import Minio
    except ImportError as exc:
        raise RuntimeError("Missing dependency: minio. Install with: pip install minio") from exc

    resolved_endpoint = resolve_minio_endpoint(
        endpoint,
        service_name=service_name,
        consul_addr=consul_addr,
        consul_token=consul_token,
        consul_skip_tls_verify=consul_skip_tls_verify,
    )
    return Minio(
        resolved_endpoint,
        access_key=access_key,
        secret_key=secret_key,
        secure=secure,
    )


def _missing_config_fields(config: dict) -> list[str]:
    missing = []
    for field in ("endpoint", "access_key", "secret_key", "bucket", "prefix"):
        if config.get(field):
            continue
        missing.append(field)
    if config.get("secure") is None:
        missing.append("secure")
    return missing


def validate_minio_config(config: dict) -> None:
    missing = _missing_config_fields(config)
    if missing:
        raise RuntimeError(f"MinIO retention is enabled but config is incomplete: missing {', '.join(missing)}")


def _stat_object(client, bucket: str, object_key: str):
    try:
        return client.stat_object(bucket, object_key)
    except Exception as exc:
        code = getattr(exc, "code", None)
        if code in {"NoSuchKey", "NoSuchObject", "NoSuchVersion", "NoSuchResource"}:
            return None
        raise


def upload_file(config: dict, path: Path, *, sha256_hex: str, content_type: str, filename: str | None = None) -> dict:
    config = normalize_minio_config(config)
    validate_minio_config(config)

    source_path = Path(path)
    object_name = filename or source_path.name
    object_key = content_addressed_object_key(config["prefix"], sha256_hex, object_name)
    client = minio_client(
        config["endpoint"],
        config["access_key"],
        config["secret_key"],
        config["secure"],
    )

    existing = _stat_object(client, config["bucket"], object_key)
    if existing is None:
        client.fput_object(
            config["bucket"],
            object_key,
            str(source_path),
            content_type=content_type,
        )

    return {
        "storage_backend": "minio",
        "bucket": config["bucket"],
        "object_key": object_key,
        "original_filename": sanitize_object_name(object_name),
        "sha256": sha256_hex,
        "content_type": content_type,
        "size_bytes": source_path.stat().st_size,
        "already_present": existing is not None,
    }


def upload_bytes(
    config: dict,
    payload: bytes,
    *,
    sha256_hex: str,
    content_type: str,
    filename: str,
) -> dict:
    config = normalize_minio_config(config)
    validate_minio_config(config)

    object_key = content_addressed_object_key(config["prefix"], sha256_hex, filename)
    client = minio_client(
        config["endpoint"],
        config["access_key"],
        config["secret_key"],
        config["secure"],
    )

    existing = _stat_object(client, config["bucket"], object_key)
    if existing is None:
        client.put_object(
            config["bucket"],
            object_key,
            io.BytesIO(payload),
            len(payload),
            content_type=content_type,
        )

    return {
        "storage_backend": "minio",
        "bucket": config["bucket"],
        "object_key": object_key,
        "original_filename": sanitize_object_name(filename),
        "sha256": sha256_hex,
        "content_type": content_type,
        "size_bytes": len(payload),
        "already_present": existing is not None,
    }


def upload_text(
    config: dict,
    text: str,
    *,
    sha256_hex: str,
    filename: str,
    content_type: str = "text/markdown; charset=utf-8",
) -> dict:
    return upload_bytes(
        config,
        text.encode("utf-8"),
        sha256_hex=sha256_hex,
        content_type=content_type,
        filename=filename,
    )
