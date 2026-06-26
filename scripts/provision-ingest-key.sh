#!/usr/bin/env bash
# provision-ingest-key.sh — mint a local_trusted, NON-admin ingest key for an
# external-ingest daemon (mail / telegram / dictation), so its writes reach a
# private_local brain under OB1_EGRESS_ENFORCE=enforce.
#
# WHY THIS EXISTS (read docs/51 for the full handover):
#   Under `enforce`, a cloud_bound caller is 404'd writing to a private_local
#   brain (legacy-admin confinement, commit 7495350). The ingest daemons today
#   authenticate with the bare MCP_ACCESS_KEY (cloud_bound legacy admin) and
#   default to the private `luchoh` brain, so they BREAK on the enforce flip.
#   The fix is a per-daemon stored key that is:
#     - read_egress_class = 'local_trusted'  (may write a private_local brain)
#     - is_admin = false                     (NOT a global admin / skeleton key)
#     - scoped: default brain = the target, membership = editor on that brain
#   Content is still stamped UNTRUSTED at /ingest/thought (commit f401b22), so a
#   trusted-to-WRITE key does NOT make external content trusted-as-CONTENT.
#
# SECURITY NOTES:
#   - The plaintext key is printed ONCE. Store it in agenix; NEVER commit it.
#   - Only the sha256 hash is persisted (brain_access_keys.key_hash).
#   - This is a deliberate local_trusted credential. Keep it on the trusted M2
#     host only; never on a cloud-harness host. Revoke per-key via is_active.
#
# USAGE:
#   PGDATABASE=ob1_dev \
#     scripts/provision-ingest-key.sh --brain luchoh --principal ingest-imap \
#       --label imap-ingest [--role editor] [--display "IMAP ingest"]
#
#   Connection: set PGHOST/PGPORT explicitly, OR rely on Consul discovery
#   (CONSUL_HTTP_ADDR/CONSUL_HTTP_TOKEN + scripts/lib/consul.sh). PGUSER/
#   PGPASSWORD as usual. PGDATABASE is REQUIRED and never defaulted (so you
#   cannot accidentally mint against prod).

set -euo pipefail

ROLE="editor"
DISPLAY=""
BRAIN=""; PRINCIPAL=""; LABEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --brain) BRAIN="$2"; shift 2;;
    --principal) PRINCIPAL="$2"; shift 2;;
    --label) LABEL="$2"; shift 2;;
    --role) ROLE="$2"; shift 2;;
    --display) DISPLAY="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

: "${PGDATABASE:?set PGDATABASE explicitly (ob1_dev | ob1) — refusing to guess}"
[ -n "$BRAIN" ]     || { echo "--brain <slug> required" >&2; exit 2; }
[ -n "$PRINCIPAL" ] || { echo "--principal <slug> required" >&2; exit 2; }
[ -n "$LABEL" ]     || { echo "--label <label> required" >&2; exit 2; }
case "$ROLE" in owner|editor) ;; *) echo "--role must be owner|editor" >&2; exit 2;; esac
[ -n "$DISPLAY" ] || DISPLAY="$PRINCIPAL"

# --- resolve connection (explicit PGHOST/PGPORT win; else Consul discovery) ---
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${PGHOST:-}" ]; then
  # shellcheck source=/dev/null
  source "$HERE/lib/consul.sh"
  ap="$(consul_service_address_port "${CONSUL_POSTGRES_SERVICE:-postgresql}")"
  PGHOST="${ap%:*}"; PGPORT="${ap##*:}"
fi
: "${PGPORT:=5432}"
: "${PGUSER:?set PGUSER}"
CONN="host=$PGHOST port=$PGPORT dbname=$PGDATABASE user=$PGUSER"
psql_q(){ psql "$CONN" -X -Atq -v ON_ERROR_STOP=1 "$@"; }

echo "target database: $(psql_q -c 'select current_database()')  (host=$PGHOST:$PGPORT)" >&2

# --- preconditions ---
HAS_COL="$(psql_q -c "select 1 from information_schema.columns where table_name='brain_access_keys' and column_name='read_egress_class' limit 1")"
[ "$HAS_COL" = "1" ] || { echo "ERROR: brain_access_keys.read_egress_class missing — apply migration 017 first" >&2; exit 1; }

read -r BRAIN_ID HOUSEHOLD_ID BRAIN_CLASS <<<"$(psql_q -c "select id, household_id, coalesce(egress_class,'(null)') from brains where slug='$BRAIN'" | tr '|' ' ')"
[ -n "${BRAIN_ID:-}" ] || { echo "ERROR: brain '$BRAIN' not found" >&2; exit 1; }
echo "brain '$BRAIN' -> $BRAIN_ID (egress_class=$BRAIN_CLASS)" >&2

# --- refuse to re-mint over an existing active key with the same label ---
DUP="$(psql_q -c "select count(*) from brain_access_keys k join brain_principals p on p.id=k.principal_id where k.label='$LABEL' and p.slug='$PRINCIPAL' and k.is_active=true")"
[ "$DUP" = "0" ] || { echo "ERROR: an active key labelled '$LABEL' already exists for principal '$PRINCIPAL'. Revoke it first (is_active=false) or use a new --label." >&2; exit 1; }

# --- generate the key (printed once) + its hash ---
KEY="obik_$(openssl rand -hex 32)"
KEY_HASH="$(printf '%s' "$KEY" | shasum -a256 | cut -d' ' -f1)"

# --- provision principal + membership + key in ONE transaction ---
psql "$CONN" -X -q -v ON_ERROR_STOP=1 \
  -v brain_id="$BRAIN_ID" -v household_id="$HOUSEHOLD_ID" \
  -v principal="$PRINCIPAL" -v display="$DISPLAY" -v role="$ROLE" \
  -v label="$LABEL" -v key_hash="$KEY_HASH" >/dev/null <<'SQL'
begin;

-- ingest principal (service): create if missing; default brain = the target
insert into brain_principals (household_id, slug, display_name, principal_type, default_brain_id)
values (:'household_id', :'principal', :'display', 'service', :'brain_id')
on conflict (household_id, slug) do update set default_brain_id = coalesce(brain_principals.default_brain_id, excluded.default_brain_id);

-- write membership on the target brain (idempotent on the (principal,brain) PK)
insert into brain_memberships (principal_id, brain_id, role, is_deny)
select p.id, :'brain_id', :'role', false from brain_principals p
  where p.slug = :'principal' and p.household_id = :'household_id'
on conflict (principal_id, brain_id) do update set role = excluded.role, is_deny = false;

-- the local_trusted, NON-admin ingest key (default brain = the target)
insert into brain_access_keys (principal_id, brain_id, key_hash, is_active, is_admin, label, credential_type, read_egress_class)
select p.id, :'brain_id', :'key_hash', true, false, :'label', 'service_key', 'local_trusted'
from brain_principals p where p.slug = :'principal' and p.household_id = :'household_id';

commit;
SQL

cat >&2 <<EOF

provisioned: principal='$PRINCIPAL' (service) -> brain '$BRAIN' role=$ROLE, key label='$LABEL'
  read_egress_class=local_trusted  is_admin=false  default_brain=$BRAIN

NEXT (operator):
  1. Put the key below into agenix (e.g. ob1-ingest-<source>-key.age), m2Only.
  2. Set the daemon's OPEN_BRAIN_INGEST_KEY env to that secret (system-config).
  3. Smoke-test the pipeline under enforce on ob1_dev, then ob1 (see docs/51).
  Revoke: update brain_access_keys set is_active=false where label='$LABEL';

THE KEY (shown once — store in agenix, NEVER commit):
EOF
printf '%s\n' "$KEY"
