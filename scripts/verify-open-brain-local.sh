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
LLM_BASE_URL="${LLM_BASE_URL:-}"
LLM_HEALTH_URL="${LLM_HEALTH_URL:-}"
LLM_MODEL="${LLM_MODEL:-mlx-community/Qwen3.5-397B-A17B-nvfp4}"

EMBEDDING_BASE_URL="${EMBEDDING_BASE_URL:-}"
EMBEDDING_HEALTH_URL="${EMBEDDING_HEALTH_URL:-}"
EMBEDDING_MODEL="${EMBEDDING_MODEL:-mlx-community/Qwen3-Embedding-8B-mxfp8}"
EXPECTED_EMBEDDING_DIMENSION="${EXPECTED_EMBEDDING_DIMENSION:-1536}"
UNSUPPORTED_EMBEDDING_DIMENSION="${UNSUPPORTED_EMBEDDING_DIMENSION:-3072}"
DOCLING_BASE_URL="${DOCLING_BASE_URL:-}"
DOCLING_HEALTH_URL="${DOCLING_HEALTH_URL:-}"
CONSUL_HTTP_TOKEN="${CONSUL_HTTP_TOKEN:-}"
LLM_SERVICE_NAME="${OPEN_BRAIN_LLM_SERVICE_NAME:-mlx-server}"
EMBEDDING_SERVICE_NAME="${OPEN_BRAIN_EMBEDDING_SERVICE_NAME:-ob1-embedding}"
DOCLING_SERVICE_NAME="${DOCLING_SERVICE_NAME:-docling}"
CONSUL_POSTGRES_SERVICE="${CONSUL_POSTGRES_SERVICE:-postgresql}"
OPEN_BRAIN_GRAPH_ENABLED="${OPEN_BRAIN_GRAPH_ENABLED:-false}"
OPEN_BRAIN_GRAPH_SERVICE_NAME="${OPEN_BRAIN_GRAPH_SERVICE_NAME:-neo4j-enterprise}"
NEO4J_URI="${NEO4J_URI:-}"
NEO4J_USERNAME="${NEO4J_USERNAME:-neo4j}"
NEO4J_PASSWORD="${NEO4J_PASSWORD:-}"
OPEN_BRAIN_GRAPH_DATABASE="${OPEN_BRAIN_GRAPH_DATABASE:-ob1-graph}"

PGHOST="${PGHOST:-}"
PGPORT="${PGPORT:-}"
PGDATABASE="${PGDATABASE:-ob1}"
PGUSER="${PGUSER:-${POSTGRES_USER:-ob1}}"
PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"

export LLM_BASE_URL
export LLM_MODEL
export EMBEDDING_BASE_URL
export EMBEDDING_MODEL
export EXPECTED_EMBEDDING_DIMENSION
export UNSUPPORTED_EMBEDDING_DIMENSION
export DOCLING_BASE_URL
export CONSUL_HTTP_ADDR
export CONSUL_HTTP_TOKEN
export CONSUL_SKIP_TLS_VERIFY
export LLM_SERVICE_NAME
export EMBEDDING_SERVICE_NAME
export DOCLING_SERVICE_NAME
export OPEN_BRAIN_GRAPH_ENABLED
export OPEN_BRAIN_GRAPH_SERVICE_NAME
export NEO4J_URI
export NEO4J_USERNAME
export NEO4J_PASSWORD
export OPEN_BRAIN_GRAPH_DATABASE

if [[ -z "$LLM_BASE_URL" || -z "$LLM_HEALTH_URL" ]]; then
  llm_service_url="$(consul_service_url "$LLM_SERVICE_NAME")"
  [[ -z "$LLM_BASE_URL" ]] && LLM_BASE_URL="${llm_service_url}/v1"
  [[ -z "$LLM_HEALTH_URL" ]] && LLM_HEALTH_URL="${llm_service_url}/health"
fi

if [[ -z "$EMBEDDING_BASE_URL" || -z "$EMBEDDING_HEALTH_URL" ]]; then
  embedding_service_url="$(consul_service_url "$EMBEDDING_SERVICE_NAME")"
  [[ -z "$EMBEDDING_BASE_URL" ]] && EMBEDDING_BASE_URL="${embedding_service_url}/v1"
  [[ -z "$EMBEDDING_HEALTH_URL" ]] && EMBEDDING_HEALTH_URL="${embedding_service_url}/health"
fi

if [[ -z "$DOCLING_BASE_URL" ]]; then
  DOCLING_BASE_URL="$(consul_service_url "$DOCLING_SERVICE_NAME")"
fi

if consul_bool_is_true "$OPEN_BRAIN_GRAPH_ENABLED" && [[ -z "$NEO4J_URI" ]]; then
  graph_address_port="$(consul_service_address_port "$OPEN_BRAIN_GRAPH_SERVICE_NAME")"
  NEO4J_URI="bolt://${graph_address_port}"
fi

if [[ -z "$DOCLING_HEALTH_URL" ]]; then
  DOCLING_HEALTH_URL="${DOCLING_BASE_URL%/}/health"
fi

if [[ -z "$PGHOST" || -z "$PGPORT" ]]; then
  pg_address_port="$(consul_service_address_port "$CONSUL_POSTGRES_SERVICE")"
  [[ -z "$PGHOST" ]] && PGHOST="${pg_address_port%:*}"
  [[ -z "$PGPORT" ]] && PGPORT="${pg_address_port##*:}"
fi

echo "== Health =="
curl -fsS "$LLM_HEALTH_URL"
echo
curl -fsS "$EMBEDDING_HEALTH_URL"
echo
curl -fsS "$DOCLING_HEALTH_URL"
echo

echo "== Model IDs =="
LLM_MODELS="$(curl -fsS "$LLM_BASE_URL/models")"
EMBED_MODELS="$(curl -fsS "$EMBEDDING_BASE_URL/models")"
echo "$LLM_MODELS"
echo
echo "$EMBED_MODELS"
echo

python3 - <<'PY'
import json
import os
import sys
import urllib.error
import urllib.request

llm_base = os.environ["LLM_BASE_URL"]
emb_base = os.environ["EMBEDDING_BASE_URL"]
llm_model = os.environ["LLM_MODEL"]
emb_model = os.environ["EMBEDDING_MODEL"]
expected_dim = int(os.environ["EXPECTED_EMBEDDING_DIMENSION"])
unsupported_dim = int(os.environ["UNSUPPORTED_EMBEDDING_DIMENSION"])

def get_json(url, payload=None):
    if payload is None:
        req = urllib.request.Request(url)
    else:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

llm_models = get_json(f"{llm_base}/models")
emb_models = get_json(f"{emb_base}/models")

llm_ids = {m["id"] for m in llm_models.get("data", [])}
emb_ids = {m["id"] for m in emb_models.get("data", [])}

if llm_model not in llm_ids:
    raise SystemExit(f"LLM model missing: {llm_model}")
if emb_model not in emb_ids:
    raise SystemExit(f"Embedding model missing: {emb_model}")

emb = get_json(
    f"{emb_base}/embeddings",
    {
        "model": emb_model,
        "input": "hello world",
        "dimensions": expected_dim,
    },
)
actual_dim = len(emb["data"][0]["embedding"])
print(f"embedding_dimension_explicit={actual_dim}")
if actual_dim != expected_dim:
    raise SystemExit(
        f"Embedding dimension mismatch: expected {expected_dim}, got {actual_dim}"
    )

emb_default = get_json(
    f"{emb_base}/embeddings",
    {
        "model": emb_model,
        "input": "hello world",
    },
)
default_dim = len(emb_default["data"][0]["embedding"])
print(f"embedding_dimension_default={default_dim}")
if default_dim != expected_dim:
    raise SystemExit(
        f"Default embedding dimension mismatch: expected {expected_dim}, got {default_dim}"
    )

try:
    get_json(
        f"{emb_base}/embeddings",
        {
            "model": emb_model,
            "input": "hello world",
            "dimensions": unsupported_dim,
        },
    )
except urllib.error.HTTPError as exc:
    if exc.code != 400:
        raise SystemExit(
            f"Unsupported-dimension request returned HTTP {exc.code}, expected 400"
        )
    print(f"unsupported_dimension_http={exc.code}")
else:
    raise SystemExit(
        f"Unsupported-dimension request unexpectedly succeeded for {unsupported_dim}"
    )

consul_addr = os.environ["CONSUL_HTTP_ADDR"].rstrip("/")
consul_token = os.environ.get("CONSUL_HTTP_TOKEN", "")
llm_service_name = os.environ["LLM_SERVICE_NAME"]
embedding_service_name = os.environ["EMBEDDING_SERVICE_NAME"]
docling_service_name = os.environ["DOCLING_SERVICE_NAME"]

def consul_get(path):
    headers = {}
    if consul_token:
        headers["X-Consul-Token"] = consul_token
    req = urllib.request.Request(f"{consul_addr}{path}", headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

for service_name in (llm_service_name, embedding_service_name, docling_service_name):
    checks = consul_get(f"/v1/health/service/{service_name}?passing=1")
    if not checks:
        raise SystemExit(f"Consul has no passing instances for {service_name}")
    print(f"consul_passing_service={service_name}")

if os.environ.get("OPEN_BRAIN_GRAPH_ENABLED", "").strip().lower() in {"1", "true", "yes", "on"}:
    graph_service_name = os.environ["OPEN_BRAIN_GRAPH_SERVICE_NAME"]
    checks = consul_get(f"/v1/health/service/{graph_service_name}?passing=1")
    if not checks:
        raise SystemExit(f"Consul has no passing instances for {graph_service_name}")
    print(f"consul_passing_service={graph_service_name}")
PY

echo
echo "== PostgreSQL =="
if [[ -z "$PGPASSWORD" ]]; then
  echo "PGPASSWORD is not set; skipping PostgreSQL verification." >&2
  exit 0
fi

export PGPASSWORD
psql "host=$PGHOST port=$PGPORT dbname=$PGDATABASE user=$PGUSER" -Atc \
  "select extname || ':' || extversion from pg_extension where extname = 'vector';"
psql "host=$PGHOST port=$PGPORT dbname=$PGDATABASE user=$PGUSER" -Atc \
  "select attname || ':' || format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'thoughts'::regclass and attname = 'embedding';"
psql "host=$PGHOST port=$PGPORT dbname=$PGDATABASE user=$PGUSER" -Atc \
  "select attname || ':' || format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'thoughts'::regclass and attname = 'dedupe_key';"
psql "host=$PGHOST port=$PGPORT dbname=$PGDATABASE user=$PGUSER" -Atc \
  "select coalesce(to_regclass('public.thought_graph_projection_state')::text, 'missing');"

if consul_bool_is_true "$OPEN_BRAIN_GRAPH_ENABLED"; then
  echo
  echo "== Neo4j =="
  if [[ -z "$NEO4J_PASSWORD" ]]; then
    echo "NEO4J_PASSWORD is not set; skipping Neo4j verification." >&2
  else
    (
      cd "$ROOT_DIR/local/open-brain-mcp"
      node --input-type=module <<'JS'
import { healthcheckGraph, closeGraph } from "./src/graph.mjs";
import { closePool } from "./src/db.mjs";

try {
  const result = await healthcheckGraph();
  console.log(JSON.stringify(result));
} finally {
  await closeGraph();
  await closePool();
}
JS
    )
  fi
fi

echo
echo "Verification passed."
