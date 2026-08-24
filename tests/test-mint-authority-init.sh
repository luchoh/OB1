#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/local/open-brain-mcp/scripts/mint-authority-init.mjs"

node --check "$script"
rg -F "const adoptable = !clashRow.is_active" "$script" >/dev/null
rg -F "clashRow.credential_type === \"minter\"" "$script" >/dev/null
rg -F "set principal_id = \$1::uuid" "$script" >/dev/null
