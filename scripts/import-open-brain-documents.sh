#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RECIPE_DIR="$ROOT_DIR/recipes/document-import"
IMPORT_SCRIPT="$RECIPE_DIR/import-documents.py"
VENV_PYTHON="$RECIPE_DIR/.venv/bin/python"

if [[ -f "$ROOT_DIR/.env.open-brain-local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env.open-brain-local"
  set +a
fi

if [[ -x "$VENV_PYTHON" ]]; then
  PYTHON_BIN="$VENV_PYTHON"
else
  PYTHON_BIN="${PYTHON_BIN:-python3}"
fi

STATE_FILE="${OPEN_BRAIN_DOCUMENT_IMPORT_STATE_FILE:-$ROOT_DIR/local/open-brain-mcp/.runtime/document-import-state.json}"
ARTIFACT_ROOT="${OPEN_BRAIN_DOCUMENT_ARTIFACT_ROOT:-$ROOT_DIR/local/open-brain-mcp/.runtime/document-import-artifacts}"

cd "$ROOT_DIR"
exec "$PYTHON_BIN" "$IMPORT_SCRIPT" --state-file "$STATE_FILE" --artifact-root "$ARTIFACT_ROOT" --skip-unchanged "$@"
