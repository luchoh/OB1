#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOADER="$ROOT_DIR/scripts/load-open-brain-dev-runtime-env.sh"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

DOTENV="$TEST_DIR/dotenv"
DEV_RUNTIME_ENV="$TEST_DIR/dev-runtime-env"
FORBIDDEN_DOTENV="$TEST_DIR/forbidden-dotenv"
printf 'OPEN_BRAIN_PORT=8787\n' > "$DOTENV"
printf 'PGHOST=127.0.0.1\nPGPORT=5432\nPGDATABASE=ob1_dev\nPGUSER=ob1_dev_app\nPGPASSWORD=dev-password\n' > "$DEV_RUNTIME_ENV"
printf 'PGDATABASE=ob1_dev\n' > "$FORBIDDEN_DOTENV"

# The selected dev profile accepts database credentials only from the supplied
# runtime env file and clears inherited/dotenv connection aliases first.
(
  export OPEN_BRAIN_ENV=local
  export OPEN_BRAIN_PORT=8787
  export PGPASSWORD=dotenv-password
  export PGHOST=dotenv-host
  export PGPORT=1234
  export POSTGRES_PASSWORD=dotenv-password
  export OPEN_BRAIN_DATABASE_URL='postgres://dotenv-password@invalid/ob1_dev'
  export DATABASE_URL='postgres://dotenv-password@invalid/ob1_dev'
  export OB1_DEV_RUNTIME_ENV_FILE="$DEV_RUNTIME_ENV"
  source "$LOADER" "$DOTENV"
  [[ "$PGPASSWORD" == 'dev-password' ]]
  [[ "$PGHOST" == '127.0.0.1' ]]
  [[ "$PGPORT" == '5432' ]]
  [[ "$OB1_DEV_RUNTIME_ENV_FILE_LOADED" == '1' ]]
  [[ -z "${POSTGRES_PASSWORD:-}" ]]
  [[ -z "${OPEN_BRAIN_DATABASE_URL:-}" ]]
  [[ -z "${DATABASE_URL:-}" ]]
)

# Non-dev profiles need neither the runtime env path nor its file, and retain
# their existing dotenv DB profile.
(
  export OPEN_BRAIN_ENV=production
  export OPEN_BRAIN_PORT=8788
  export PGPASSWORD=production-password
  unset OB1_DEV_RUNTIME_ENV_FILE
  source "$LOADER" "$FORBIDDEN_DOTENV"
  [[ "$PGPASSWORD" == 'production-password' ]]
)

# Selected dev profiles fail rather than accepting dotenv database credentials.
if (
  export OPEN_BRAIN_ENV=local
  export OPEN_BRAIN_PORT=8787
  export OB1_DEV_RUNTIME_ENV_FILE="$DEV_RUNTIME_ENV"
  source "$LOADER" "$FORBIDDEN_DOTENV"
); then
  echo "expected selected dev profile to reject dotenv database credentials" >&2
  exit 1
fi

# Selected dev profiles also fail if the supplied runtime env file lacks a
# password, instead of falling back to any inherited value.
if (
  export OPEN_BRAIN_ENV=local
  export OPEN_BRAIN_PORT=8787
  export PGPASSWORD=dotenv-password
  export OB1_DEV_RUNTIME_ENV_FILE="$TEST_DIR/missing"
  source "$LOADER" "$DOTENV"
); then
  echo "expected selected dev profile to reject an unreadable runtime env file" >&2
  exit 1
fi

# A local 8787 launch must fail with the missing Home Manager export, rather
# than falling through to Node with a misleading missing-PGPASSWORD failure.
if (
  export OPEN_BRAIN_ENV=local
  export OPEN_BRAIN_PORT=8787
  unset OB1_DEV_RUNTIME_ENV_FILE
  source "$LOADER" "$DOTENV"
); then
  echo "expected local 8787 launch to require OB1_DEV_RUNTIME_ENV_FILE" >&2
  exit 1
fi
