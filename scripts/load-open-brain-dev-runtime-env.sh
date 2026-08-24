#!/usr/bin/env bash
# Source this after .env.open-brain-local has supplied non-secret runtime
# settings. It loads the selected ob1_dev profile's database environment only
# from OB1_DEV_RUNTIME_ENV_FILE, immediately before Node starts.

ob1_load_dev_runtime_env() {
  local dotenv_file="${1:?dotenv file path is required}"

  # The developer-owned runtime is the local 8787 process. Stable does not use
  # this devenv launcher, and any other local profile keeps its old behavior.
  # Do not use the env-file variable itself as the selector: if Home Manager
  # fails to export it, that would silently fall through to Node and report a
  # misleading missing-PGPASSWORD error.
  if [[ "${OPEN_BRAIN_ENV:-}" != "local" || "${OPEN_BRAIN_PORT:-}" != "8787" ]]; then
    return 0
  fi

  if [[ ! -r "$dotenv_file" ]]; then
    echo "OB1 dev dotenv file is unreadable: $dotenv_file" >&2
    return 1
  fi

  if [[ -z "${OB1_DEV_RUNTIME_ENV_FILE:-}" ]]; then
    echo "OB1_DEV_RUNTIME_ENV_FILE is required for the local 8787 development runtime" >&2
    return 1
  fi

  local forbidden_name
  for forbidden_name in \
    PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD POSTGRES_PASSWORD \
    OPEN_BRAIN_DATABASE_URL DATABASE_URL; do
    if grep -Eq "^[[:space:]]*(export[[:space:]]+)?${forbidden_name}=" "$dotenv_file"; then
      echo "OB1 dev dotenv file must not define ${forbidden_name}: $dotenv_file" >&2
      return 1
    fi
  done

  if [[ ! -r "$OB1_DEV_RUNTIME_ENV_FILE" ]]; then
    echo "OB1 dev runtime env file is unreadable: $OB1_DEV_RUNTIME_ENV_FILE" >&2
    return 1
  fi

  # Ignore inherited/dotenv database connection settings and credentials. The
  # selected runtime env file is the complete profile for this launch.
  unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD POSTGRES_PASSWORD \
    OPEN_BRAIN_DATABASE_URL DATABASE_URL
  set -a
  # shellcheck disable=SC1090
  source "$OB1_DEV_RUNTIME_ENV_FILE"
  set +a

  local required_name
  for required_name in PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD; do
    if [[ -z "${!required_name:-}" ]]; then
      echo "OB1 dev runtime env file must define non-empty ${required_name}: $OB1_DEV_RUNTIME_ENV_FILE" >&2
      return 1
    fi
  done
  if [[ "$PGDATABASE" != "ob1_dev" || "$PGUSER" != "ob1_dev_app" ]]; then
    echo "OB1 dev runtime env file must select PGDATABASE=ob1_dev and PGUSER=ob1_dev_app: $OB1_DEV_RUNTIME_ENV_FILE" >&2
    return 1
  fi

  export OB1_DEV_RUNTIME_ENV_FILE_LOADED=1
}

ob1_load_dev_runtime_env "$@"
