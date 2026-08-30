#!/usr/bin/env bash
# Every skills/*/SKILL.md must have YAML frontmatter that parses.
#
# Why this exists: Claude Code loads unparseable frontmatter by dropping EVERY
# field, including `disable-model-invocation: true`. So a YAML error does not
# merely lose a description — it disarms the human-only guard on skills that
# provision and rotate credentials. skills/ob1-estate-setup carried exactly that
# defect from 83a87c5 (2026-06-04) until 2026-08-28: an unquoted description
# containing ": ", which YAML reads as a mapping key.
#
# It was found by system-config's deploy gate refusing to ship the skill, not by
# us. Nothing in this repo parsed its own frontmatter. This test is that check.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 - "$ROOT_DIR" <<'PY'
import glob
import os
import re
import sys

try:
    import yaml
except ImportError:  # pragma: no cover - environment without pyyaml
    print("SKIP: pyyaml unavailable; run inside devenv")
    raise SystemExit(0)

root = sys.argv[1]
paths = sorted(glob.glob(os.path.join(root, "skills", "**", "SKILL.md"), recursive=True))
if not paths:
    print("FAIL: no skills/*/SKILL.md found — wrong root?")
    raise SystemExit(1)

failures = []
for path in paths:
    rel = os.path.relpath(path, root)
    text = open(path, encoding="utf-8").read()
    match = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not match:
        failures.append(f"{rel}: no YAML frontmatter block")
        continue
    try:
        parsed = yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:
        detail = str(exc).replace("\n", " | ")
        failures.append(f"{rel}: {type(exc).__name__}: {detail}")
        continue
    if not isinstance(parsed, dict):
        failures.append(f"{rel}: frontmatter is {type(parsed).__name__}, expected a mapping")
        continue
    if "name" not in parsed:
        failures.append(f"{rel}: frontmatter parsed but has no 'name' key")

if failures:
    print(f"FAIL: {len(failures)} of {len(paths)} SKILL.md frontmatter blocks are invalid:")
    for line in failures:
        print(f"  {line}")
    print()
    print("A plain YAML scalar may not contain ': ' — quote the value.")
    raise SystemExit(1)

print(f"OK: {len(paths)} SKILL.md frontmatter blocks parse")
PY
