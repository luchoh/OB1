#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

source "$ROOT_DIR/scripts/lib/consul.sh"

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

# The ob1-stable launchd wrapper runs this script synchronously before starting
# node, so a migration that blocks on a lock (016 takes ACCESS EXCLUSIVE on
# thoughts) would hang the deploy forever with no health endpoint and no error.
# Fail fast on lock acquisition instead; the statement budget stays generous so
# a legitimately slow rewrite still completes.
MIGRATION_LOCK_TIMEOUT="${MIGRATION_LOCK_TIMEOUT:-5s}"
MIGRATION_STATEMENT_TIMEOUT="${MIGRATION_STATEMENT_TIMEOUT:-1800s}"
# Appended last so these win over any inherited PGOPTIONS.
export PGOPTIONS="${PGOPTIONS:+$PGOPTIONS }-c lock_timeout=$MIGRATION_LOCK_TIMEOUT -c statement_timeout=$MIGRATION_STATEMENT_TIMEOUT"

PSQL=(psql "host=$PGHOST port=$PGPORT dbname=$PGDATABASE user=$PGUSER")
MIGRATIONS_DIR="$ROOT_DIR/local/open-brain-mcp/migrations"

"${PSQL[@]}" -v ON_ERROR_STOP=1 <<'SQL'
create table if not exists open_brain_schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);
SQL

for file in "$MIGRATIONS_DIR"/*.sql; do
  name="$(basename "$file")"
  # Without ON_ERROR_STOP a failed ledger read returns empty, which reads as
  # "not applied" and would re-run the migration.
  applied="$("${PSQL[@]}" -v ON_ERROR_STOP=1 -Atq -c "select 1 from open_brain_schema_migrations where name = '$name'")"

  if [[ "$applied" == "1" ]]; then
    echo "Skipping already-applied migration: $name"
    continue
  fi

  echo "Applying migration: $name"
  if ! "${PSQL[@]}" -v ON_ERROR_STOP=1 <<SQL
begin;
\i $file
insert into open_brain_schema_migrations (name) values ('$name');
commit;
SQL
  then
    cat >&2 <<MSG
Migration failed and was rolled back: $name
If the error above is "canceling statement due to lock timeout", another
transaction holds a conflicting lock (016 needs ACCESS EXCLUSIVE on thoughts).
Find and clear it, then re-run this script:
  select pid, state, wait_event_type, left(query, 120)
    from pg_stat_activity
   where datname = '$PGDATABASE' and pid <> pg_backend_pid();
Timeouts are lock_timeout=$MIGRATION_LOCK_TIMEOUT statement_timeout=$MIGRATION_STATEMENT_TIMEOUT
(override with MIGRATION_LOCK_TIMEOUT / MIGRATION_STATEMENT_TIMEOUT).
MSG
    exit 1
  fi
done

echo "All migrations applied."
