#!/usr/bin/env bash
# provision-ingest-key.sh — mint a local_trusted, NON-admin scoped key for an
# external-ingest daemon (mail / telegram / dictation) or for the operator
# enrichment scripts, so its writes reach a private_local brain under
# OB1_EGRESS_ENFORCE=enforce.
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
# WHY --purpose (ADR-0004/0007):
#   Ingest daemons and the enrichment scripts need the *same* key shape — scoped,
#   non-admin, local_trusted, editor on the personal brain — and differ only in
#   which env var the operator wires the value into. One script, one shape, one
#   set of preconditions; a second script would have been a copy with one string
#   changed. credential_type stays 'service_key' for both on purpose: it is the
#   shape authorizePurge inspects (access-policy.mjs isNamedAdminServiceKey) and
#   inventing purpose-specific values here would put unmanaged strings in a
#   security-relevant column for zero behavioural gain.
#
# WHY --key-hash (ADR-0007, docs/51):
#   Each daemon exists as a prod instance (database ob1) and a dev instance
#   (database ob1_dev) reading the SAME key file but talking to different
#   servers. ONE plaintext value therefore has to be registered in BOTH
#   databases: mint in the first with no flag, then re-register the printed
#   hash in the second with --key-hash. Same flag pattern as
#   scripts/agent_estate/provision.sh.
#
# SECURITY NOTES:
#   - The plaintext key is printed ONCE, and ONLY when this script minted it.
#     With --key-hash nothing secret is read, printed, or required.
#   - --key-stdin (not --key) is the way to supply a plaintext you already hold:
#     argv is world-readable via ps and lands in shell history.
#   - Only the sha256 hash is persisted (brain_access_keys.key_hash).
#   - This is a deliberate local_trusted credential. Keep it on the trusted M2
#     host only; never on a cloud-harness host. Revoke per-key via is_active.
#
# USAGE:
#   # 1. mint against dev (prints the plaintext AND its hash)
#   PGDATABASE=ob1_dev \
#     scripts/provision-ingest-key.sh --brain luchoh --principal ingest-imap \
#       --label imap-ingest [--purpose ingest] [--role editor] [--display "IMAP ingest"]
#
#   # 2. register the SAME value against prod, without handling the plaintext
#   PGDATABASE=ob1 \
#     scripts/provision-ingest-key.sh --brain luchoh --principal ingest-imap \
#       --label imap-ingest --key-hash <64-hex-from-step-1>
#
#   # enrichment scripts (OPEN_BRAIN_ENRICHMENT_KEY) — same shape, other env var
#   PGDATABASE=ob1_dev \
#     scripts/provision-ingest-key.sh --purpose enrichment --brain luchoh \
#       --principal enrichment-ops --label enrichment-ops
#
#   Connection: set PGHOST/PGPORT explicitly, OR rely on Consul discovery
#   (CONSUL_HTTP_ADDR/CONSUL_HTTP_TOKEN + scripts/lib/consul.sh). PGUSER/
#   PGPASSWORD as usual. PGDATABASE is REQUIRED and never defaulted (so you
#   cannot accidentally mint against prod).

set -euo pipefail

ROLE="editor"
DISPLAY=""
PURPOSE="ingest"
SUPPLIED_HASH=""
KEY_FROM_STDIN=""
BRAIN=""; PRINCIPAL=""; LABEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --brain) BRAIN="$2"; shift 2;;
    --principal) PRINCIPAL="$2"; shift 2;;
    --label) LABEL="$2"; shift 2;;
    --role) ROLE="$2"; shift 2;;
    --display) DISPLAY="$2"; shift 2;;
    --purpose) PURPOSE="$2"; shift 2;;
    --key-hash) SUPPLIED_HASH="$2"; shift 2;;
    --key-stdin) KEY_FROM_STDIN=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

: "${PGDATABASE:?set PGDATABASE explicitly (ob1_dev | ob1) — refusing to guess}"
[ -n "$BRAIN" ]     || { echo "--brain <slug> required" >&2; exit 2; }
[ -n "$PRINCIPAL" ] || { echo "--principal <slug> required" >&2; exit 2; }
[ -n "$LABEL" ]     || { echo "--label <label> required" >&2; exit 2; }
case "$ROLE" in owner|editor) ;; *) echo "--role must be owner|editor" >&2; exit 2;; esac
case "$PURPOSE" in
  ingest)     ENV_VAR="OPEN_BRAIN_INGEST_KEY" ;;
  enrichment) ENV_VAR="OPEN_BRAIN_ENRICHMENT_KEY" ;;
  *) echo "--purpose must be ingest|enrichment" >&2; exit 2;;
esac
[ -n "$DISPLAY" ] || DISPLAY="$PRINCIPAL"

[ -z "$SUPPLIED_HASH" ] || [ -z "$KEY_FROM_STDIN" ] \
  || { echo "--key-hash and --key-stdin are mutually exclusive" >&2; exit 2; }
if [ -n "$SUPPLIED_HASH" ]; then
  # A typo'd hash would silently register a key nobody holds, so fail loudly.
  case "$SUPPLIED_HASH" in
    *[!0-9a-f]* | "") echo "--key-hash must be 64 lowercase hex chars (a sha256 digest)" >&2; exit 2;;
  esac
  [ "${#SUPPLIED_HASH}" -eq 64 ] \
    || { echo "--key-hash must be 64 lowercase hex chars (a sha256 digest)" >&2; exit 2; }
fi

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

# ADR-0007: no ingest client ever sends a brain selector, so the key's own
# default brain is the ONLY thing deciding where captures land once the legacy
# admin path is gone. If the principal already carries a DIFFERENT default, the
# key's brain_id still wins (auth.mjs defaultBrainOverride) — but say so out
# loud, because a mismatch means some other key on this principal writes
# elsewhere.
PRIOR_DEFAULT="$(psql_q -c "select coalesce(b.slug,'(none)') from brain_principals p left join brains b on b.id=p.default_brain_id where p.slug='$PRINCIPAL' and p.household_id='$HOUSEHOLD_ID'")"
if [ -n "$PRIOR_DEFAULT" ] && [ "$PRIOR_DEFAULT" != "$BRAIN" ]; then
  echo "WARNING: principal '$PRINCIPAL' already defaults to brain '$PRIOR_DEFAULT'; this key pins '$BRAIN' regardless." >&2
fi

# --- refuse to re-mint over an existing active key with the same label ---
DUP="$(psql_q -c "select count(*) from brain_access_keys k join brain_principals p on p.id=k.principal_id where k.label='$LABEL' and p.slug='$PRINCIPAL' and k.is_active=true")"
[ "$DUP" = "0" ] || { echo "ERROR: an active key labelled '$LABEL' already exists for principal '$PRINCIPAL'. Revoke it first (is_active=false) or use a new --label." >&2; exit 1; }

# --- the key: supplied by hash, supplied by value on stdin, or freshly minted ---
KEY=""
if [ -n "$SUPPLIED_HASH" ]; then
  KEY_HASH="$SUPPLIED_HASH"
  echo "registering a supplied key hash — no plaintext is read or printed" >&2
elif [ -n "$KEY_FROM_STDIN" ]; then
  # No echo, no argv: the value never appears in ps output or shell history.
  # `|| true` is load-bearing: `read` returns 1 at EOF-without-delimiter, which is
  # exactly what `printf '%s' "$key" | ...` produces (no trailing newline). Under
  # `set -euo pipefail` that killed the script here with no message and provisioned
  # nothing, while the emptiness guard below was unreachable. The guard is the check;
  # read's exit status is not.
  IFS= read -rs KEY || true
  [ -n "$KEY" ] || { echo "ERROR: --key-stdin read an empty key" >&2; exit 2; }
  KEY_HASH="$(printf '%s' "$KEY" | shasum -a256 | cut -d' ' -f1)"
  KEY=""  # already hashed; the caller holds it, so do not re-print it
  echo "registering a supplied key value — its plaintext is NOT re-printed" >&2
else
  KEY="obik_$(openssl rand -hex 32)"
  KEY_HASH="$(printf '%s' "$KEY" | shasum -a256 | cut -d' ' -f1)"
fi

# A hash already live in THIS database means the second-database registration
# was run twice (or against the wrong database); a duplicate row is confusing,
# not useful.
HASH_DUP="$(psql_q -c "select count(*) from brain_access_keys where key_hash='$KEY_HASH' and is_active=true")"
[ "$HASH_DUP" = "0" ] || { echo "ERROR: that key hash is already registered and active in $PGDATABASE." >&2; exit 1; }

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

# Read the destination back OUT of the row we just wrote, rather than echoing
# the argument: this is the value auth.mjs will actually use as the default brain.
read -r KEY_BRAIN PRINCIPAL_BRAIN <<<"$(psql_q -c "select b.slug, coalesce(pb.slug,'(none)') from brain_access_keys k join brains b on b.id=k.brain_id join brain_principals p on p.id=k.principal_id left join brains pb on pb.id=p.default_brain_id where k.key_hash='$KEY_HASH' and k.is_active=true" | tr '|' ' ')"
[ -n "${KEY_BRAIN:-}" ] || { echo "ERROR: key row not found after commit — nothing was provisioned" >&2; exit 1; }

cat >&2 <<EOF

provisioned: principal='$PRINCIPAL' (service) -> brain '$BRAIN' role=$ROLE, key label='$LABEL'
  purpose=$PURPOSE  read_egress_class=local_trusted  is_admin=false
  CAPTURES LAND IN: brain '$KEY_BRAIN' (key default_brain; principal default='$PRINCIPAL_BRAIN')
EOF

if [ -n "$SUPPLIED_HASH" ] || [ -n "$KEY_FROM_STDIN" ]; then
  cat >&2 <<EOF

NEXT (operator):
  The supplied value is now registered in $PGDATABASE too, so ONE key file serves
  both the prod (ob1) and dev (ob1_dev) instances of this daemon. Nothing new to
  store — $ENV_VAR already carries it.
  Revoke: update brain_access_keys set is_active=false where label='$LABEL';
EOF
  exit 0
fi

cat >&2 <<EOF

NEXT (operator):
  1. Put the key below into agenix (e.g. ob1-$PURPOSE-<source>-key.age), m2Only.
  2. Set $ENV_VAR to that secret (system-config) for every consumer.
     MCP_ACCESS_KEY is NOT involved: it is the server's own boot secret after the
     split (ADR-0004), and the clients keep it only as a legacy fallback.
  3. Register the SAME value in the other database so prod and dev agree:
       PGDATABASE=<other> $0 --brain $BRAIN --principal $PRINCIPAL \\
         --label $LABEL --purpose $PURPOSE --key-hash $KEY_HASH
  4. Smoke-test under enforce on ob1_dev, then ob1 (see docs/51).
  Revoke: update brain_access_keys set is_active=false where label='$LABEL';

THE KEY (shown once — store in agenix, NEVER commit):
EOF
printf '%s\n' "$KEY"
