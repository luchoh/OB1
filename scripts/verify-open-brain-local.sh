#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f ".env.open-brain-local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env.open-brain-local"
  set +a
fi

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

LLM_BASE_URL="${LLM_BASE_URL:-http://10.10.10.101:8035/v1}"
LLM_HEALTH_URL="${LLM_HEALTH_URL:-http://10.10.10.101:8035/health}"
LLM_MODEL="${LLM_MODEL:-mlx-community/Qwen3.5-397B-A17B-nvfp4}"

EMBEDDING_BASE_URL="${EMBEDDING_BASE_URL:-http://10.10.10.101:8082/v1}"
EMBEDDING_HEALTH_URL="${EMBEDDING_HEALTH_URL:-http://10.10.10.101:8082/health}"
EMBEDDING_MODEL="${EMBEDDING_MODEL:-mlx-community/Qwen3-Embedding-8B-mxfp8}"
EXPECTED_EMBEDDING_DIMENSION="${EXPECTED_EMBEDDING_DIMENSION:-1536}"
UNSUPPORTED_EMBEDDING_DIMENSION="${UNSUPPORTED_EMBEDDING_DIMENSION:-3072}"
CONSUL_HTTP_ADDR="${CONSUL_HTTP_ADDR:-http://127.0.0.1:8500}"
CONSUL_HTTP_TOKEN="${CONSUL_HTTP_TOKEN:-}"
LLM_SERVICE_NAME="${OPEN_BRAIN_LLM_SERVICE_NAME:-mlx-server}"
EMBEDDING_SERVICE_NAME="${OPEN_BRAIN_EMBEDDING_SERVICE_NAME:-ob1-embedding}"

PGHOST="${PGHOST:-10.10.10.100}"
PGPORT="${PGPORT:-5432}"
PGDATABASE="${PGDATABASE:-ob1}"
PGUSER="${PGUSER:-${POSTGRES_USER:-ob1}}"
PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"

export LLM_BASE_URL
export LLM_MODEL
export EMBEDDING_BASE_URL
export EMBEDDING_MODEL
export EXPECTED_EMBEDDING_DIMENSION
export UNSUPPORTED_EMBEDDING_DIMENSION
export CONSUL_HTTP_ADDR
export CONSUL_HTTP_TOKEN
export LLM_SERVICE_NAME
export EMBEDDING_SERVICE_NAME

echo "== Health =="
curl -fsS "$LLM_HEALTH_URL"
echo
curl -fsS "$EMBEDDING_HEALTH_URL"
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

def consul_get(path):
    headers = {}
    if consul_token:
        headers["X-Consul-Token"] = consul_token
    req = urllib.request.Request(f"{consul_addr}{path}", headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

for service_name in (llm_service_name, embedding_service_name):
    checks = consul_get(f"/v1/health/service/{service_name}?passing=1")
    if not checks:
        raise SystemExit(f"Consul has no passing instances for {service_name}")
    print(f"consul_passing_service={service_name}")
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

echo
echo "Verification passed."
