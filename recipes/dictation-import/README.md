# Dictation Import

> Import canonical dictation artifacts from MinIO into OB1 as searchable source notes and distilled thoughts.

## What It Does

Consumes canonical markdown artifacts produced by the separate `dictation` service, then ingests them into the local OB1 runtime as:

- `dictation_note` source rows
- `dictation_thought` distilled rows

The preferred source is the MinIO artifact bucket described in [docs/11-local-dictation-ingest-prd.md](/Users/luchoh/Dev/OB1/docs/11-local-dictation-ingest-prd.md#L1).

For `capture_channel=telegram` artifacts, the importer now applies the same meaningfulness/novelty gate as Telegram text capture before anything is stored in OB1.

## Prerequisites

- Working Open Brain local runtime
- Access key for `POST /ingest/thought`
- MinIO access to the canonical dictation artifact bucket
- Local `mlx-server` available for thought distillation

## Install

```bash
cd /Users/luchoh/Dev/OB1/recipes/dictation-import
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Required Env

```bash
export MCP_ACCESS_KEY=...
export CONSUL_HTTP_ADDR=...
export MINIO_SERVICE_NAME=minio
export MINIO_ACCESS_KEY=...
export MINIO_SECRET_KEY=...
export MINIO_SECURE=false
export DICTATION_MINIO_BUCKET=dictation-artifacts
```

Optional:

```bash
export OPEN_BRAIN_BASE_URL=http://localhost:8787
export DICTATION_MINIO_PREFIX=canonical/
export CONSUL_HTTP_TOKEN=...  # if Consul ACLs are enabled
export MINIO_ENDPOINT=minio.example.internal:9000  # explicit override only
```

Current local managed deployment note:

- discover MinIO through Consul service name `minio`
- keep `MINIO_ENDPOINT` unset unless you are deliberately bypassing Consul
- use `MINIO_SECURE=false`

Recommended for Telegram-origin dictation review:

```bash
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_REVIEW_MODE=full
export TELEGRAM_REVIEW_MATCH_THRESHOLD=0.78
export TELEGRAM_REVIEW_MATCH_COUNT=3
export TELEGRAM_REVIEW_STATE_FILE=/usr/local/var/ob1-telegram-bridge/telegram-review-state.json
```

## One-Shot Import

```bash
python import-dictation.py \
  --bucket "$DICTATION_MINIO_BUCKET" \
  --prefix "${DICTATION_MINIO_PREFIX:-canonical/}"
```

## Polling Mode

```bash
python import-dictation.py \
  --bucket "$DICTATION_MINIO_BUCKET" \
  --prefix "${DICTATION_MINIO_PREFIX:-canonical/}" \
  --poll \
  --poll-interval 30
```

## Dry-Run On A Local Artifact

```bash
python import-dictation.py \
  --artifact-file /path/to/sample-artifact.md \
  --dry-run \
  --verbose
```

## Expected Outcome

For each imported artifact:

- one `dictation_note` source row is stored in OB1
- up to 3 `dictation_thought` rows are stored
- artifact provenance is preserved in `metadata.user_metadata`
- `dictation-sync-log.json` records the processed artifact identity

For Telegram-origin artifacts:

- low-signal transcripts are not auto-ingested
- extracted thoughts are shown in Telegram before ingest
- the user can approve, edit, deny, commit, or view the raw transcript
- nothing is stored until `Commit`
- zero-thought transcripts still use the simpler `Record / Ignore` override path
- set `TELEGRAM_REVIEW_MODE=exceptions_only` to keep the older auto-ingest behavior for clearly novel thoughts

## Notes

- Source-row dedupe identity prefers `audio_sha256`, then `artifact_id`.
- The importer trusts the canonical markdown artifact contents, not MinIO object metadata.
- This importer does not require direct filesystem access to the dictation producer host.
