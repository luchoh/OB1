#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

source "$ROOT_DIR/scripts/lib/consul.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/bootstrap-open-brain-household.sh \
    --household-slug local-household \
    --household-name "Local Household" \
    --owner-principal-slug owner \
    --owner-display-name "Owner" \
    --owner-brain-slug owner \
    --owner-brain-name "Owner Personal Brain" \
    [--shared-brain-slug household] \
    [--shared-brain-name "Shared Household Brain"] \
    [--keycloak-sub <sub>] \
    [--preferred-username <username>] \
    [--email <email>]
EOF
}

sql_quote() {
  printf "%s" "$1" | sed "s/'/''/g"
}

sql_literal_or_null() {
  local value="$1"
  if [[ -z "$value" ]]; then
    printf "null"
  else
    printf "'%s'" "$(sql_quote "$value")"
  fi
}

HOUSEHOLD_SLUG=""
HOUSEHOLD_NAME=""
OWNER_PRINCIPAL_SLUG=""
OWNER_DISPLAY_NAME=""
OWNER_BRAIN_SLUG=""
OWNER_BRAIN_NAME=""
SHARED_BRAIN_SLUG=""
SHARED_BRAIN_NAME=""
KEYCLOAK_SUB=""
PREFERRED_USERNAME=""
EMAIL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --household-slug)
      HOUSEHOLD_SLUG="$2"
      shift 2
      ;;
    --household-name)
      HOUSEHOLD_NAME="$2"
      shift 2
      ;;
    --owner-principal-slug)
      OWNER_PRINCIPAL_SLUG="$2"
      shift 2
      ;;
    --owner-display-name)
      OWNER_DISPLAY_NAME="$2"
      shift 2
      ;;
    --owner-brain-slug)
      OWNER_BRAIN_SLUG="$2"
      shift 2
      ;;
    --owner-brain-name)
      OWNER_BRAIN_NAME="$2"
      shift 2
      ;;
    --shared-brain-slug)
      SHARED_BRAIN_SLUG="$2"
      shift 2
      ;;
    --shared-brain-name)
      SHARED_BRAIN_NAME="$2"
      shift 2
      ;;
    --keycloak-sub)
      KEYCLOAK_SUB="$2"
      shift 2
      ;;
    --preferred-username)
      PREFERRED_USERNAME="$2"
      shift 2
      ;;
    --email)
      EMAIL="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

for required in HOUSEHOLD_SLUG HOUSEHOLD_NAME OWNER_PRINCIPAL_SLUG OWNER_DISPLAY_NAME OWNER_BRAIN_SLUG OWNER_BRAIN_NAME; do
  if [[ -z "${!required}" ]]; then
    echo "Missing required argument: ${required}" >&2
    usage >&2
    exit 1
  fi
done

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

if [[ -f ".env.open-brain-local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env.open-brain-local"
  set +a
fi

CONSUL_HTTP_ADDR="${CONSUL_HTTP_ADDR:-https://consul.lincoln.luchoh.net}"
CONSUL_SKIP_TLS_VERIFY="${CONSUL_SKIP_TLS_VERIFY:-false}"
CONSUL_FORCE_DISCOVERY="${CONSUL_FORCE_DISCOVERY:-false}"
CONSUL_POSTGRES_SERVICE="${CONSUL_POSTGRES_SERVICE:-postgresql}"
PGHOST="${PGHOST:-}"
PGPORT="${PGPORT:-}"
PGDATABASE="${PGDATABASE:-ob1}"
PGUSER="${PGUSER:-${POSTGRES_USER:-ob1}}"
PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"

if consul_bool_is_true "$CONSUL_FORCE_DISCOVERY" || [[ -z "$PGHOST" || -z "$PGPORT" ]]; then
  pg_address_port="$(consul_service_address_port "$CONSUL_POSTGRES_SERVICE")"
  PGHOST="${pg_address_port%:*}"
  PGPORT="${pg_address_port##*:}"
fi

if [[ -z "$PGPASSWORD" ]]; then
  echo "PGPASSWORD is not set." >&2
  exit 1
fi

export PGPASSWORD

PSQL=(psql "host=$PGHOST port=$PGPORT dbname=$PGDATABASE user=$PGUSER")

HOUSEHOLD_ID="$("${PSQL[@]}" -Atq <<SQL
insert into households (slug, display_name)
values ('$(sql_quote "$HOUSEHOLD_SLUG")', '$(sql_quote "$HOUSEHOLD_NAME")')
on conflict (slug)
do update set
  display_name = excluded.display_name,
  updated_at = now()
returning id;
SQL
)"

OWNER_BRAIN_ID="$("${PSQL[@]}" -Atq <<SQL
insert into brains (household_id, slug, display_name, kind, is_default_shared)
values (
  '$HOUSEHOLD_ID',
  '$(sql_quote "$OWNER_BRAIN_SLUG")',
  '$(sql_quote "$OWNER_BRAIN_NAME")',
  'personal',
  false
)
on conflict (household_id, slug)
do update set
  display_name = excluded.display_name,
  kind = excluded.kind,
  updated_at = now()
returning id;
SQL
)"

SHARED_BRAIN_ID=""
if [[ -n "$SHARED_BRAIN_SLUG" ]]; then
  SHARED_NAME="${SHARED_BRAIN_NAME:-Shared Household Brain}"
  SHARED_BRAIN_ID="$("${PSQL[@]}" -Atq <<SQL
insert into brains (household_id, slug, display_name, kind, is_default_shared)
values (
  '$HOUSEHOLD_ID',
  '$(sql_quote "$SHARED_BRAIN_SLUG")',
  '$(sql_quote "$SHARED_NAME")',
  'shared_household',
  true
)
on conflict (household_id, slug)
do update set
  display_name = excluded.display_name,
  kind = excluded.kind,
  is_default_shared = excluded.is_default_shared,
  updated_at = now()
returning id;
SQL
)"
fi

OWNER_PRINCIPAL_ID="$("${PSQL[@]}" -Atq <<SQL
insert into brain_principals (household_id, slug, display_name, principal_type, default_brain_id)
values (
  '$HOUSEHOLD_ID',
  '$(sql_quote "$OWNER_PRINCIPAL_SLUG")',
  '$(sql_quote "$OWNER_DISPLAY_NAME")',
  'person',
  '$OWNER_BRAIN_ID'
)
on conflict (household_id, slug)
do update set
  display_name = excluded.display_name,
  principal_type = excluded.principal_type,
  default_brain_id = excluded.default_brain_id,
  updated_at = now()
returning id;
SQL
)"

"${PSQL[@]}" -v ON_ERROR_STOP=1 <<SQL
insert into brain_memberships (principal_id, brain_id, role)
values ('$OWNER_PRINCIPAL_ID', '$OWNER_BRAIN_ID', 'owner')
on conflict (principal_id, brain_id)
do update set role = excluded.role;
SQL

if [[ -n "$SHARED_BRAIN_ID" ]]; then
  "${PSQL[@]}" -v ON_ERROR_STOP=1 <<SQL
insert into brain_memberships (principal_id, brain_id, role)
values ('$OWNER_PRINCIPAL_ID', '$SHARED_BRAIN_ID', 'owner')
on conflict (principal_id, brain_id)
do update set role = excluded.role;
SQL
fi

if [[ -n "$KEYCLOAK_SUB" ]]; then
  "${PSQL[@]}" -v ON_ERROR_STOP=1 <<SQL
insert into principal_identity_bindings (
  principal_id,
  provider,
  subject,
  preferred_username,
  email,
  is_active,
  last_seen_at
)
values (
  '$OWNER_PRINCIPAL_ID',
  'keycloak',
  '$(sql_quote "$KEYCLOAK_SUB")',
  $(sql_literal_or_null "$PREFERRED_USERNAME"),
  $(sql_literal_or_null "$EMAIL"),
  true,
  now()
)
on conflict (provider, subject)
do update set
  principal_id = excluded.principal_id,
  preferred_username = excluded.preferred_username,
  email = excluded.email,
  is_active = true,
  last_seen_at = now(),
  updated_at = now();
SQL
fi

if [[ -n "${MCP_ACCESS_KEY:-}" ]]; then
  "${PSQL[@]}" -v ON_ERROR_STOP=1 <<SQL
insert into brain_access_keys (
  principal_id,
  brain_id,
  key_hash,
  label,
  credential_type,
  is_active,
  is_admin,
  last_used_at
)
values (
  '$OWNER_PRINCIPAL_ID',
  '$OWNER_BRAIN_ID',
  encode(digest('$(sql_quote "$MCP_ACCESS_KEY")', 'sha256'), 'hex'),
  'bootstrap-admin',
  'admin',
  true,
  true,
  now()
)
on conflict (key_hash)
do update set
  principal_id = excluded.principal_id,
  brain_id = excluded.brain_id,
  label = excluded.label,
  credential_type = excluded.credential_type,
  is_active = true,
  is_admin = true,
  last_used_at = now(),
  updated_at = now();
SQL
fi

"${PSQL[@]}" -v ON_ERROR_STOP=1 <<SQL
update thoughts
set brain_id = '$OWNER_BRAIN_ID'
where brain_id is null;

update thought_graph_projection_state
set brain_id = '$OWNER_BRAIN_ID'
where brain_id is null;
SQL

echo "Bootstrapped household $HOUSEHOLD_SLUG"
echo "owner_principal_id=$OWNER_PRINCIPAL_ID"
echo "owner_brain_id=$OWNER_BRAIN_ID"
if [[ -n "$SHARED_BRAIN_ID" ]]; then
  echo "shared_brain_id=$SHARED_BRAIN_ID"
fi
