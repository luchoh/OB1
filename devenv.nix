{ pkgs, ... }:

{
  dotenv.enable = true;
  dotenv.filename = ".env.open-brain-local";

  packages = with pkgs; [
    nodejs_22
    python312
    python312Packages.requests
    python312Packages.minio
    python312Packages.asyncpg
    python312Packages.httpx
    uv
    jq
    curl
    git
    postgresql_16
  ];

  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_22;
  };

  languages.python = {
    enable = true;
    package = pkgs.python312;
    venv.enable = false;
  };

  process.manager.implementation = "process-compose";

  scripts = {
    "ob1-check".exec = "cd local/open-brain-mcp && npm run check";
    "ob1-migrate".exec = "./scripts/apply-open-brain-local-migrations.sh";
    "ob1-verify".exec = "./scripts/verify-open-brain-local.sh";
    "ob1-smoke".exec = "./scripts/smoke-open-brain-local-mcp.sh";
  };

  processes.open_brain_local.exec = ''
    set -euo pipefail
    cd "$DEVENV_ROOT"

    if [ ! -f .env.open-brain-local ]; then
      echo "ERROR: .env.open-brain-local not found!"
      echo "Run: cp .env.open-brain-local.example .env.open-brain-local"
      echo "Then fill in your local secrets."
      exit 1
    fi

    runtime_pid=

    kill_tree() {
      pid="$1"
      if [ -z "$pid" ]; then
        return
      fi
      if command -v pgrep >/dev/null 2>&1; then
        for child in $(pgrep -P "$pid" 2>/dev/null); do
          kill_tree "$child"
        done
      fi
      kill "$pid" 2>/dev/null || true
    }

    cleanup() {
      if [ -n "''${runtime_pid}" ]; then
        kill_tree "''${runtime_pid}"
      fi
    }

    trap cleanup INT TERM EXIT

    (
      set -a
      source .env.open-brain-local
      set +a

      if [ -z "''${OPEN_BRAIN_PORT:-}" ] || ! printf '%s' "$OPEN_BRAIN_PORT" | grep -Eq '^[0-9]+$'; then
        echo "OPEN_BRAIN_PORT must be numeric" >&2
        exit 1
      fi

      if [ ! -d local/open-brain-mcp/node_modules ]; then
        echo "Bootstrapping local/open-brain-mcp dependencies with npm install..."
        (cd local/open-brain-mcp && npm install)
      fi

      # The developer-owned 8787 runtime may select the isolated ob1_dev
      # profile. Its non-secret settings still come from the repo dotenv file;
      # its DB credentials come only from the caller-supplied runtime env file.
      # Production and every other profile keep their existing environment
      # behavior. Keep this immediately before the Node exec boundary.
      source "$DEVENV_ROOT/scripts/load-open-brain-dev-runtime-env.sh" \
        "$DEVENV_ROOT/.env.open-brain-local"

      # DEV's boot/admin key comes from agenix, NOT from the dotenv above.
      #
      # Until 2026-08-21 MCP_ACCESS_KEY came from .env.open-brain-local, whose
      # value was byte-identical to the fleet-wide ob1-ingest-access-key. So
      # this runtime silently accepted the shared admin key that every shell on
      # the box exported, and rotating that key could not close dev — the dotenv
      # is dev's real key source, so dev kept honouring the old value.
      #
      # This override sits AFTER both the dotenv source and the runtime-env
      # loader and immediately before the Node exec boundary, so nothing
      # downstream can put the old value back.
      #
      # Fail CLOSED: refuse to start rather than fall back to the dotenv value.
      # A dev runtime booting on the shared fleet admin key is the exact
      # condition being removed, and it looks identical to success.
      #
      # The two dev-facing ingest daemons (ob1-telegram-bridges.dev,
      # ob1-dictation-imports.dev) read this SAME file in system-config. Change
      # the source here and you must change it there, or every dev ingest 401s.
      if [ ! -r /run/agenix/ob1-dev-boot-access-key ]; then
        echo "ERROR: /run/agenix/ob1-dev-boot-access-key is missing or unreadable." >&2
        echo "       Refusing to start on a fallback credential." >&2
        echo "       Rebuild m2maxstudio (nixdev) to provision it." >&2
        exit 1
      fi
      export MCP_ACCESS_KEY="$(cat /run/agenix/ob1-dev-boot-access-key)"

      case "$OPEN_BRAIN_HOST" in
        *:*) runtime_address="[$OPEN_BRAIN_HOST]:$OPEN_BRAIN_PORT" ;;
        *) runtime_address="$OPEN_BRAIN_HOST:$OPEN_BRAIN_PORT" ;;
      esac
      echo "Starting Open Brain local runtime on $runtime_address"
      exec ./scripts/run-open-brain-local.sh
    ) &
    runtime_pid=$!

    wait "''${runtime_pid}"
    status=$?
    if [ "$status" -eq 143 ] || [ "$status" -eq 130 ]; then
      exit 0
    fi
    exit "$status"
  '';

  enterShell = ''
    # OB1's own scoped PROD brain key (repo-service:ob1 — editor on repo:ob1 only,
    # non-admin, non-minter, cannot purge). Consumed by .mcp.json as
    # ''${OB1_MCP_ACCESS_KEY} and expanded at connect time; the value never lands
    # in a config file.
    #
    # This export EXISTS TO OVERRIDE a global. OB1_MCP_ACCESS_KEY is one shared
    # variable written by three zshrc blocks (pi-cli, codex-cli, grok-cli),
    # last-wins, and the last one exports system-config's DEV key. A fresh shell
    # here would otherwise present another repo's credential against prod.
    # direnv applies per-directory, so this wins inside ~/Dev/OB1.
    #
    # Fail CLOSED: if the secret is unreadable we UNSET rather than inherit. A
    # 401 from an empty header is a visible failure; silently presenting
    # system-config's dev key is a wrong-credential bug that looks like success.
    if [ -r /run/agenix/ob1-ob1-repo-key ]; then
      export OB1_MCP_ACCESS_KEY="$(cat /run/agenix/ob1-ob1-repo-key)"
    else
      unset OB1_MCP_ACCESS_KEY
      echo "WARNING: /run/agenix/ob1-ob1-repo-key is missing or unreadable."
      echo "         OB1_MCP_ACCESS_KEY unset — the ob1 MCP server will not authenticate."
    fi

    echo "Open Brain development shell"
    echo ""
    echo "Commands:"
    echo "  devenv shell                # enter this shell again"
    echo "  devenv up open_brain_local  # run the local MCP runtime (port from .env.open-brain-local)"
    echo "  ob1-migrate                 # apply local runtime migrations"
    echo "  ob1-check                   # node syntax checks for the local runtime"
    echo "  ob1-verify                  # verify upstreams, PostgreSQL, and runtime contract"
    echo "  ob1-smoke                   # full local smoke test"
    echo ""
    echo "Service lifecycle:"
    echo "  The user owns 'devenv up' / 'devenv down'. Agents should probe health before using the runtime."
  '';
}
