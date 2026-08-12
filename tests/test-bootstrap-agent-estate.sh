#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/local/open-brain-mcp/scripts/bootstrap-agent-estate.mjs"

node --check "$script"

if node "$script" --estate 'bad_slug' --yes >/dev/null 2>&1; then
  echo "expected invalid estate slug to fail" >&2
  exit 1
fi

if node "$script" --wat >/dev/null 2>&1; then
  echo "expected unknown argument to fail" >&2
  exit 1
fi
