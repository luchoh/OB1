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
OPEN_BRAIN_HOST="${OPEN_BRAIN_HOST:-localhost}"
OPEN_BRAIN_PORT="${OPEN_BRAIN_PORT:-8787}"
OPEN_BRAIN_BASE_URL="http://${OPEN_BRAIN_HOST}:${OPEN_BRAIN_PORT}"
MCP_ACCESS_KEY="${MCP_ACCESS_KEY:-}"
PGHOST="${PGHOST:-}"
PGPORT="${PGPORT:-}"
PGDATABASE="${PGDATABASE:-${POSTGRES_DB:-ob1}}"
PGUSER="${PGUSER:-${POSTGRES_USER:-ob1}}"
PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"
SERVICE_DIR="$ROOT_DIR/local/open-brain-mcp"
SERVICE_LOG="$ROOT_DIR/.open-brain-local-smoke.log"
SMOKE_MARKER="OB1 local smoke $(date +%s)"
SUCCESS=0

if [[ -z "$MCP_ACCESS_KEY" ]]; then
  echo "MCP_ACCESS_KEY is not set." >&2
  exit 1
fi

if [[ -z "$PGPASSWORD" ]]; then
  echo "PGPASSWORD is not set." >&2
  exit 1
fi

if consul_bool_is_true "$CONSUL_FORCE_DISCOVERY" || [[ -z "$PGHOST" || -z "$PGPORT" ]]; then
  pg_address_port="$(consul_service_address_port "$CONSUL_POSTGRES_SERVICE")"
  PGHOST="${pg_address_port%:*}"
  PGPORT="${pg_address_port##*:}"
fi

cleanup() {
  if [[ -n "${SERVICE_PID:-}" ]] && kill -0 "$SERVICE_PID" 2>/dev/null; then
    kill "$SERVICE_PID" 2>/dev/null || true
    wait "$SERVICE_PID" 2>/dev/null || true
  fi

  PGPASSWORD="$PGPASSWORD" psql \
    "host=$PGHOST port=$PGPORT dbname=$PGDATABASE user=$PGUSER" \
    -v ON_ERROR_STOP=1 \
    -c "delete from thoughts where content like '${SMOKE_MARKER}%';" >/dev/null 2>&1 || true

  if [[ "$SUCCESS" -eq 1 ]]; then
    rm -f "$SERVICE_LOG"
  fi
}

trap cleanup EXIT

echo "== Upstream Verification =="
./scripts/verify-open-brain-local.sh

echo
echo "== Local Install =="
if [[ ! -d "$SERVICE_DIR/node_modules" ]]; then
  (cd "$SERVICE_DIR" && npm install)
fi
(cd "$SERVICE_DIR" && npm run check)

echo
echo "== Migrations =="
./scripts/apply-open-brain-local-migrations.sh

echo
echo "== Start Local Service =="
rm -f "$SERVICE_LOG"
(
  cd "$SERVICE_DIR"
  npm start
) >"$SERVICE_LOG" 2>&1 &
SERVICE_PID=$!

for _ in $(seq 1 30); do
  if curl -fsS "$OPEN_BRAIN_BASE_URL/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "$OPEN_BRAIN_BASE_URL/health" >/dev/null 2>&1; then
  echo "Local service failed to become healthy. Recent log output:" >&2
  tail -n 50 "$SERVICE_LOG" >&2 || true
  exit 1
fi

curl -fsS "$OPEN_BRAIN_BASE_URL/health"
echo

echo
echo "== MCP Smoke =="
export MCP_ACCESS_KEY
export OPEN_BRAIN_BASE_URL
export SMOKE_MARKER

(
  cd "$SERVICE_DIR"
  node --input-type=module <<'EOF'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const timeout = (ms) =>
  new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms));

const client = new Client({ name: 'ob1-local-smoke', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(`${process.env.OPEN_BRAIN_BASE_URL}/mcp`), {
  requestInit: {
    headers: {
      'x-access-key': process.env.MCP_ACCESS_KEY,
    },
  },
});

try {
  await client.connect(transport);

  const parseToolJson = (result, name) => {
    if (result.isError) {
      throw new Error(`${name} returned an error: ${JSON.stringify(result)}`);
    }
    const text = result.content?.find((item) => item.type === 'text')?.text;
    if (!text) {
      throw new Error(`${name} returned no text payload`);
    }
    return JSON.parse(text);
  };

  const tools = await Promise.race([client.listTools(), timeout(5000)]);
  console.log(JSON.stringify({ tools: tools.tools.map((tool) => tool.name) }, null, 2));

  const capture = await Promise.race([
    client.callTool({
      name: 'capture_thought',
      arguments: {
        content: `${process.env.SMOKE_MARKER}: remember the local MCP server is now wired to PostgreSQL and MLX services.`,
        source: 'local-smoke-test',
        tags: ['smoke-test', 'local-setup'],
      },
    }),
    timeout(20000),
  ]);
  parseToolJson(capture, 'capture_thought');

  const search = await Promise.race([
    client.callTool({
      name: 'search_thoughts',
      arguments: {
        query: process.env.SMOKE_MARKER,
        match_count: 3,
        match_threshold: 0.1,
      },
    }),
    timeout(20000),
  ]);
  parseToolJson(search, 'search_thoughts');

  const listThoughts = await Promise.race([
    client.callTool({ name: 'list_thoughts', arguments: { limit: 3 } }),
    timeout(5000),
  ]);
  parseToolJson(listThoughts, 'list_thoughts');

  const stats = await Promise.race([
    client.callTool({ name: 'stats', arguments: {} }),
    timeout(5000),
  ]);
  parseToolJson(stats, 'stats');

  const answer = await Promise.race([
    client.callTool({
      name: 'ask_brain',
      arguments: {
        question: `What does the note beginning "${process.env.SMOKE_MARKER}" say the local MCP server is wired to?`,
        match_count: 4,
        match_threshold: 0.1,
      },
    }),
    timeout(30000),
  ]);
  const answerPayload = parseToolJson(answer, 'ask_brain');
  if (!answerPayload.grounded || answerPayload.insufficient_evidence || !Array.isArray(answerPayload.citations) || answerPayload.citations.length === 0) {
    throw new Error(`ask_brain returned an ungrounded answer: ${JSON.stringify(answerPayload)}`);
  }

  console.log(JSON.stringify({
    capture_ok: true,
    search_ok: true,
    list_ok: true,
    stats_ok: true,
    ask_brain_ok: true,
  }, null, 2));
} finally {
  await client.close().catch(() => {});
}
EOF
)

echo
SUCCESS=1
echo "Smoke test passed."
