"""Compile sensitivity patterns from sensitivity_patterns.json and run detection.

Ported from upstream recipes/thought-enrichment/lib/sensitivity-patterns.mjs.
Behaviour: any restricted-pattern hit short-circuits to tier="restricted".
Otherwise, any personal-pattern hit yields tier="personal". No hits → "standard".
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import NamedTuple


_PATTERNS_PATH = Path(__file__).resolve().parent.parent / "sensitivity_patterns.json"


def _compile_flags(flag_str: str) -> int:
    flags = 0
    for ch in flag_str or "":
        if ch == "i":
            flags |= re.IGNORECASE
        elif ch == "m":
            flags |= re.MULTILINE
        elif ch == "s":
            flags |= re.DOTALL
    return flags


def _load_patterns() -> tuple[list[tuple[re.Pattern, str]], list[tuple[re.Pattern, str]]]:
    with _PATTERNS_PATH.open("r", encoding="utf-8") as fp:
        data = json.load(fp)

    def compile_section(defs: list[dict]) -> list[tuple[re.Pattern, str]]:
        return [(re.compile(d["pattern"], _compile_flags(d.get("flags", ""))), d["label"]) for d in defs]

    return compile_section(data["restricted"]), compile_section(data["personal"])


RESTRICTED_PATTERNS, PERSONAL_PATTERNS = _load_patterns()


class SensitivityResult(NamedTuple):
    tier: str  # "standard" | "personal" | "restricted"
    reasons: list[str]


def detect_sensitivity(text: str) -> SensitivityResult:
    """Run regex-based sensitivity detection on `text`."""
    text = text or ""
    reasons: list[str] = []

    for pattern, reason in RESTRICTED_PATTERNS:
        if pattern.search(text):
            reasons.append(reason)
            return SensitivityResult(tier="restricted", reasons=reasons)

    for pattern, reason in PERSONAL_PATTERNS:
        if pattern.search(text):
            reasons.append(reason)

    if reasons:
        return SensitivityResult(tier="personal", reasons=reasons)

    return SensitivityResult(tier="standard", reasons=[])
