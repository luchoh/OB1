#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RECIPE_DIR="$ROOT_DIR/recipes/email-history-import"
WATCH_SCRIPT="$RECIPE_DIR/watch-imap.py"
VENV_PYTHON="$RECIPE_DIR/.venv/bin/python"

if [[ -x "$VENV_PYTHON" ]]; then
  PYTHON_BIN="$VENV_PYTHON"
else
  PYTHON_BIN="${PYTHON_BIN:-python3}"
fi

cd "$ROOT_DIR"
exec "$PYTHON_BIN" "$WATCH_SCRIPT" "$@"
