#!/usr/bin/env python3
"""
Deterministic secret hygiene for imported text.

This is intentionally narrow and auditable:
- redact obvious literal secrets
- never invent replacement values
- optionally drop thought strings that become meaningless after redaction
"""

from __future__ import annotations

import re

PEM_PRIVATE_KEY_PATTERN = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z0-9 ]*PRIVATE KEY-----",
    re.MULTILINE,
)

REDACTION_PATTERNS = (
    (
        "authorization_bearer",
        re.compile(r"(?i)(\bauthorization\b\s*:\s*bearer\s+)([A-Za-z0-9._~+/=-]{8,})"),
        r"\1[REDACTED]",
    ),
    (
        "api_key_header",
        re.compile(r"(?i)(\bx-?api-?key\b\s*:\s*)([A-Za-z0-9._~+/=-]{8,})"),
        r"\1[REDACTED]",
    ),
    (
        "credential_assignment",
        re.compile(
            r"(?i)(\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|secret(?: key)?|password|passphrase)\b\s*[:=]\s*[\"']?)([^\"'\s,;)\]}]{8,})([\"']?)"
        ),
        r"\1[REDACTED]\3",
    ),
    (
        "credential_parenthetical",
        re.compile(
            r"(?i)(\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|secret(?: key)?|password|passphrase)\b\s*\(\s*)([^)\s]{8,})(\s*\))"
        ),
        r"\1[REDACTED]\3",
    ),
    (
        "aws_access_key_id",
        re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
        "[REDACTED]",
    ),
)

REDACTED_TOKEN_PATTERN = re.compile(r"\[REDACTED(?: [A-Z_]+)?\]")


def sanitize_text(text: str) -> dict:
    if not isinstance(text, str) or not text:
        return {"text": text or "", "redaction_count": 0, "rules": []}

    sanitized = text
    redaction_count = 0
    rules = []

    sanitized, replacements = PEM_PRIVATE_KEY_PATTERN.subn("[REDACTED PRIVATE KEY]", sanitized)
    if replacements:
        redaction_count += replacements
        rules.append("pem_private_key")

    for rule_name, pattern, replacement in REDACTION_PATTERNS:
        sanitized, replacements = pattern.subn(replacement, sanitized)
        if replacements:
            redaction_count += replacements
            rules.append(rule_name)

    sanitized = re.sub(r"(?:\[REDACTED(?: [A-Z_]+)?\]\s*){2,}", "[REDACTED] ", sanitized).strip()

    return {
        "text": sanitized,
        "redaction_count": redaction_count,
        "rules": sorted(set(rules)),
    }


def thought_is_low_signal_after_redaction(text: str) -> bool:
    stripped = (text or "").strip()
    if not stripped:
        return True

    without_redactions = REDACTED_TOKEN_PATTERN.sub("", stripped)
    visible_words = re.findall(r"[A-Za-z0-9_]+", without_redactions)
    if len(visible_words) < 3:
        return True

    return False


def sanitize_thoughts(thoughts, limit=None) -> dict:
    sanitized = []
    seen = set()
    redaction_count = 0
    rules = set()

    for item in thoughts or []:
        if not isinstance(item, str):
            continue

        result = sanitize_text(item.strip())
        redaction_count += result["redaction_count"]
        rules.update(result["rules"])
        thought = result["text"].strip()

        if thought_is_low_signal_after_redaction(thought):
            continue
        if thought in seen:
            continue

        seen.add(thought)
        sanitized.append(thought)
        if limit is not None and len(sanitized) >= limit:
            break

    return {
        "thoughts": sanitized,
        "redaction_count": redaction_count,
        "rules": sorted(rules),
    }
