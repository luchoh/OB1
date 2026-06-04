#!/usr/bin/env bash
#
# Provision an agent-estate repo principal (v24 Phase 5).
#
# Idempotently ensures: the agent estate (a household), the shared common brain,
# a repo principal + its repo brain, the two brain memberships (repo=owner,
# common=editor), and the operator's estate membership for visibility. On first
# provision of a principal it also mints an access key and writes the plaintext
# to a gitignored file (never stdout) so it does not leak into logs.
#
# Usage:   scripts/agent_estate/provision.sh <repo-slug>
# Slugs are overridable for testing:
#   AGENT_ESTATE_SLUG (default agent-estate)
#   COMMON_BRAIN_SLUG (default agent-common)
#   OPERATOR_PRINCIPAL_TYPE (default person)
set -euo pipefail

SLUG="${1:?usage: provision.sh <repo-slug> [--key-hash <sha256-hex>] [--database <name>]}"
shift
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && cd .. && pwd)"
cd "$ROOT_DIR"

# Optional: register a key generated elsewhere (the repo-init skill flow) by its
# sha256 hash, so the plaintext key never leaves the repo it belongs to.
SUPPLIED_HASH=""
DB_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --key-hash) SUPPLIED_HASH="${2:?--key-hash needs a value}"; shift 2 ;;
    --database) DB_OVERRIDE="${2:?--database needs a value}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ -n "$SUPPLIED_HASH" && ! "$SUPPLIED_HASH" =~ ^[0-9a-f]{64}$ ]]; then
  echo "--key-hash must be 64 lowercase hex chars (a sha256 digest)" >&2; exit 2
fi

# Slugs are interpolated into a couple of -c queries; keep them strictly safe.
valid_slug() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]*$ ]]; }

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/lib/consul.sh"
if [[ -f ".env.open-brain-local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env.open-brain-local"
  set +a
fi

ESTATE_SLUG="${AGENT_ESTATE_SLUG:-agent-estate}"
COMMON_SLUG="${COMMON_BRAIN_SLUG:-agent-common}"

for s in "$SLUG" "$ESTATE_SLUG" "$COMMON_SLUG"; do
  valid_slug "$s" || { echo "Invalid slug '$s' (allowed: [a-z0-9-], must start alphanumeric)" >&2; exit 2; }
done

PGHOST="${PGHOST:-}"
PGPORT="${PGPORT:-}"
if consul_bool_is_true "${CONSUL_FORCE_DISCOVERY:-false}" || [[ -z "$PGHOST" || -z "$PGPORT" ]]; then
  pg_address_port="$(consul_service_address_port "${CONSUL_POSTGRES_SERVICE:-postgresql}")"
  PGHOST="${pg_address_port%:*}"
  PGPORT="${pg_address_port##*:}"
fi
: "${PGPASSWORD:?PGPASSWORD is not set}"
export PGHOST PGPORT PGPASSWORD

# --database wins over the env file's PGDATABASE (the env file pins dev).
CONN="host=$PGHOST port=$PGPORT dbname=${DB_OVERRIDE:-${PGDATABASE:-ob1}} user=${PGUSER:-postgres}"
psql_run() { nix shell nixpkgs#postgresql_16 --command psql "$CONN" -v ON_ERROR_STOP=1 "$@"; }

# --- idempotent estate / brains / principal / memberships -------------------
psql_run \
  -v estate_slug="$ESTATE_SLUG" \
  -v common_slug="$COMMON_SLUG" \
  -v repo_slug="$SLUG" \
  -q <<'SQL'
begin;

insert into households (slug, display_name)
  values (:'estate_slug', 'Agent Estate')
  on conflict (slug) do nothing;

insert into brains (household_id, slug, display_name, kind)
  select id, :'common_slug', 'Agent Common', 'personal' from households where slug = :'estate_slug'
  on conflict (household_id, slug) do nothing;

insert into brains (household_id, slug, display_name, kind)
  select id, :'repo_slug', :'repo_slug' || ' repo brain', 'personal' from households where slug = :'estate_slug'
  on conflict (household_id, slug) do nothing;

insert into brain_principals (household_id, slug, display_name, principal_type, default_brain_id)
  select h.id, :'repo_slug', :'repo_slug', 'agent', b.id
  from households h
  join brains b on b.household_id = h.id and b.slug = :'repo_slug'
  where h.slug = :'estate_slug'
  on conflict (household_id, slug) do update set default_brain_id = excluded.default_brain_id;

insert into brain_memberships (principal_id, brain_id, role)
  select p.id, b.id, 'owner'
  from brain_principals p
  join households h on h.id = p.household_id
  join brains b on b.household_id = h.id and b.slug = :'repo_slug'
  where h.slug = :'estate_slug' and p.slug = :'repo_slug'
  on conflict (principal_id, brain_id) do nothing;

insert into brain_memberships (principal_id, brain_id, role)
  select p.id, b.id, 'editor'
  from brain_principals p
  join households h on h.id = p.household_id
  join brains b on b.household_id = h.id and b.slug = :'common_slug'
  where h.slug = :'estate_slug' and p.slug = :'repo_slug'
  on conflict (principal_id, brain_id) do nothing;

-- operator (the person principal) gets estate-level visibility into the estate
insert into estate_memberships (principal_id, estate_id, role)
  select op.id, h.id, 'admin'
  from households h
  cross join lateral (
    select id from brain_principals where principal_type = 'person' order by created_at asc limit 1
  ) op
  where h.slug = :'estate_slug'
  on conflict (principal_id, estate_id) do nothing;

commit;
SQL

# --- access key --------------------------------------------------------------
# Slugs/hash are validated/hex, so direct interpolation here is safe (and avoids
# psql's -c variable-interpolation quirk).
if [[ -n "$SUPPLIED_HASH" ]]; then
  # Register an externally-generated key by hash (repo-init skill flow); the
  # plaintext key stays in the repo it belongs to. Idempotent on the hash.
  EXISTS="$(psql_run -Atq -c \
    "select count(*) from brain_access_keys where key_hash = '${SUPPLIED_HASH}' and is_active = true")"
  if [[ "$EXISTS" == "0" ]]; then
    psql_run -q -c \
      "insert into brain_access_keys (principal_id, brain_id, is_admin, key_hash, is_active, label, credential_type)
         select p.id, null, false, '${SUPPLIED_HASH}', true, '${SLUG} repo key', 'service_key'
         from brain_principals p join households h on h.id = p.household_id
         where h.slug = '${ESTATE_SLUG}' and p.slug = '${SLUG}'"
    echo "Provisioned '${SLUG}' in estate '${ESTATE_SLUG}': registered supplied key hash."
  else
    echo "Provisioned '${SLUG}' in estate '${ESTATE_SLUG}': supplied key hash already registered."
  fi
else
  # Mint a fresh key only if the principal has none.
  HAS_KEY="$(psql_run -Atq -c \
    "select count(*) from brain_access_keys k
       join brain_principals p on p.id = k.principal_id
       join households h on h.id = p.household_id
      where h.slug = '${ESTATE_SLUG}' and p.slug = '${SLUG}' and k.is_active = true")"
  if [[ "$HAS_KEY" == "0" ]]; then
    KEY="ob1_$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
    HASH="$(node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$KEY")"
    psql_run -q -c \
      "insert into brain_access_keys (principal_id, brain_id, is_admin, key_hash, is_active, label, credential_type)
         select p.id, null, false, '${HASH}', true, '${SLUG} repo key', 'service_key'
         from brain_principals p join households h on h.id = p.household_id
         where h.slug = '${ESTATE_SLUG}' and p.slug = '${SLUG}'"
    mkdir -p "$ROOT_DIR/.agent-estate-keys"
    umask 077
    printf '%s\n' "$KEY" > "$ROOT_DIR/.agent-estate-keys/${SLUG}.key"
    echo "Provisioned '${SLUG}' in estate '${ESTATE_SLUG}': NEW access key -> .agent-estate-keys/${SLUG}.key (gitignored)."
  else
    echo "Provisioned '${SLUG}' in estate '${ESTATE_SLUG}': principal/brains/memberships ensured; existing active key kept."
  fi
fi
