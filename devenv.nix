{ pkgs, ... }:

{
  dotenv.enable = true;
  dotenv.filename = ".env.open-brain-local";

  packages = with pkgs; [
    nodejs_22
    python312
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

      echo "Starting Open Brain local runtime on $OPEN_BRAIN_HOST:$OPEN_BRAIN_PORT"
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
