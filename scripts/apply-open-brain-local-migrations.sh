#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

source "$ROOT_DIR/scripts/lib/consul.sh"

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
MIGRATIONS_DIR="$ROOT_DIR/local/open-brain-mcp/migrations"

"${PSQL[@]}" -v ON_ERROR_STOP=1 <<'SQL'
create table if not exists open_brain_schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);
SQL

for file in "$MIGRATIONS_DIR"/*.sql; do
  name="$(basename "$file")"
  applied="$("${PSQL[@]}" -Atq -c "select 1 from open_brain_schema_migrations where name = '$name'")"

  if [[ "$applied" == "1" ]]; then
    echo "Skipping already-applied migration: $name"
    continue
  fi

  echo "Applying migration: $name"
  "${PSQL[@]}" -v ON_ERROR_STOP=1 <<SQL
begin;
\i $file
insert into open_brain_schema_migrations (name) values ('$name');
commit;
SQL
done

echo "All migrations applied."
