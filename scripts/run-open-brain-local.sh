#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_DIR="$ROOT_DIR/local/open-brain-mcp"

cd "$ROOT_DIR"

if [[ ! -d "$SERVICE_DIR/node_modules" ]]; then
  echo "Missing local/open-brain-mcp/node_modules. Run 'cd local/open-brain-mcp && npm install' first." >&2
  exit 1
fi

# The caller must provide the service environment explicitly. The repo config
# module deliberately never opens dotenv files: importing runtime code from an
# agent shell must not acquire service credentials as a side effect.
cd "$SERVICE_DIR"
exec node src/index.mjs
