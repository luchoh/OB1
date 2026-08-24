#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/check-ob1-minter-whoami.sh"

for profile in dev prod system-config; do
  bash -n "$SCRIPT"
  case "$profile" in
    dev)
      grep -Fq 'base_url="http://[::1]:8787"' "$SCRIPT"
      ;;
    prod)
      grep -Fq 'base_url="http://127.0.0.1:8788"' "$SCRIPT"
      ;;
  esac
done

grep -Fq 'read -r -s key' "$SCRIPT"
grep -Fq 'curl --config -' "$SCRIPT"
grep -Fq 'unset key' "$SCRIPT"
