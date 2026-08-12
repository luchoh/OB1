#!/usr/bin/env bash
# Read-only credential identity check. The key is read from the terminal with
# echo disabled; it is never placed in argv, shell history, a file, or output.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: scripts/check-ob1-minter-whoami.sh dev|prod|system-config

Prompts once for the corresponding password-manager key and calls /whoami.
EOF
  exit 2
}

case "${1:-}" in
  dev|system-config)
    label="OB1 Minter Key [${1^^}]"
    # The developer-owned runtime binds IPv6 loopback only.
    base_url="http://[::1]:8787"
    ;;
  prod)
    label="OB1 Minter Key [PROD]"
    base_url="http://127.0.0.1:8788"
    ;;
  *) usage ;;
esac

key=""
cleanup() {
  unset key
}
trap cleanup EXIT HUP INT TERM

printf 'Paste %s (input hidden): ' "$label" >&2
IFS= read -r -s key
printf '\n' >&2
[[ -n "$key" ]] || { echo "No key entered." >&2; exit 1; }

# curl config arrives on stdin, so the key cannot appear in process arguments.
response="$(
  {
    printf '%s\n' 'silent'
    printf '%s\n' 'show-error'
    printf 'url = "%s/whoami"\n' "$base_url"
    printf 'header = "x-access-key: %s"\n' "$key"
  } | curl --config -
)"
unset key

if ! printf '%s' "$response" | jq -e '.success == true' >/dev/null; then
  printf '%s\n' "$response" | jq . 2>/dev/null || printf '%s\n' "$response"
  exit 1
fi

printf '%s\n' "$response" | jq '{
  success,
  auth_source,
  principal: { slug: .principal.slug, principal_type: .principal.principal_type },
  estate: .estate.slug,
  credential: { label: .credential.label, credential_type: .credential.credential_type, is_active: .credential.is_active },
  is_admin,
  can_mint_repo_keys,
  read_egress_class,
  reach,
  brains: [.brains[] | { slug, role, role_source, can_write, egress_class }]
}'
