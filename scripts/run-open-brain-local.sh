#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_DIR="$ROOT_DIR/local/open-brain-mcp"

cd "$ROOT_DIR"

if [[ ! -d "$SERVICE_DIR/node_modules" ]]; then
  echo "Missing local/open-brain-mcp/node_modules. Run 'cd local/open-brain-mcp && npm install' first." >&2
  exit 1
fi

# Env loading is handled in local/open-brain-mcp/src/config.mjs so inherited
# launchd environment can still override repo-local defaults.
cd "$SERVICE_DIR"
exec node src/index.mjs
