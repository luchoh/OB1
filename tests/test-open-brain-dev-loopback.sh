#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

grep -Fxq 'OPEN_BRAIN_HOST=::1' "$ROOT_DIR/.env.open-brain-local.example"
grep -Fq 'http://[::1]:8787' "$ROOT_DIR/.env.open-brain-local.example"
grep -Fq 'base_url="http://[::1]:8787"' "$ROOT_DIR/scripts/check-ob1-minter-whoami.sh"
grep -Fq 'runtime_address="[$OPEN_BRAIN_HOST]:$OPEN_BRAIN_PORT"' "$ROOT_DIR/devenv.nix"
