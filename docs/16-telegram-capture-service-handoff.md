# Telegram Capture And Dictation Import Service Handoff

This is the deployment handoff for running Telegram capture and dictation import as unattended local services.

`launchd` wiring is expected to be handled by the sysadmin. This document defines the service contract so the setup is mechanical rather than interpretive.

## Canonical Runtimes

Telegram bridge:

- bridge: [integrations/telegram-capture/telegram_bridge.py](/Users/luchoh/Dev/OB1/integrations/telegram-capture/telegram_bridge.py#L1)
- docs: [integrations/telegram-capture/README.md](/Users/luchoh/Dev/OB1/integrations/telegram-capture/README.md#L1)

Dictation importer:

- importer: [recipes/dictation-import/import-dictation.py](/Users/luchoh/Dev/OB1/recipes/dictation-import/import-dictation.py#L1)
- docs: [recipes/dictation-import/README.md](/Users/luchoh/Dev/OB1/recipes/dictation-import/README.md#L1)

Supporting product/infra docs:

- [docs/14-telegram-capture-prd.md](/Users/luchoh/Dev/OB1/docs/14-telegram-capture-prd.md#L1)
- [docs/15-telegram-dictation-minio-prd.md](/Users/luchoh/Dev/OB1/docs/15-telegram-dictation-minio-prd.md#L1)
- [docs/11-local-dictation-ingest-prd.md](/Users/luchoh/Dev/OB1/docs/11-local-dictation-ingest-prd.md#L1)

## Required Env

Managed-service auth note:

- the canonical MinIO discovery path for these workers is `CONSUL_HTTP_ADDR` plus `MINIO_SERVICE_NAME`
- `CONSUL_HTTP_TOKEN` is optional and depends on the Consul ACL setup
- the MinIO credential contract remains `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, and `MINIO_SECURE`
- in managed deployments, those values must come from per-service MinIO credentials, not shared developer or admin credentials
- local workstation development may continue using static MinIO credentials
- `MINIO_ENDPOINT` is now only an explicit override for isolated/manual runs
- optional OIDC parity must materialize the same credential env vars before process start; direct worker-side OIDC or STS is not part of this contract today
- the current local managed deployment resolves `minio` through Consul with `MINIO_SECURE=false`
- managed Telegram launchers must set `TELEGRAM_ENSURE_RAW_BUCKET=false`

### Telegram Bridge

Minimum required values:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_CHAT_IDS`
- `MCP_ACCESS_KEY`
- `CONSUL_HTTP_ADDR`
- `MINIO_SERVICE_NAME=minio`
- `MINIO_ACCESS_KEY`
- `MINIO_SECRET_KEY`
- `MINIO_SECURE=false`
- `TELEGRAM_RAW_AUDIO_BUCKET=telegram-raw-audio`
- `TELEGRAM_ENSURE_RAW_BUCKET=false`
- `DICTATION_ACCESS_KEY`

Recommended values:

- `OPEN_BRAIN_BASE_URL=http://localhost:8787`
- `TELEGRAM_POLL_TIMEOUT_SECONDS=25`
- `TELEGRAM_REVIEW_MODE=full`
- `DICTATION_BASE_URL=https://dictation.lincoln.luchoh.net`
- `DICTATION_OBJECT_SUBMIT_URL=https://dictation.lincoln.luchoh.net/v1/dictation/notes/from-object`
- `DICTATION_CLEANUP_MODE=llm`
- `TELEGRAM_REVIEW_STATE_FILE=/usr/local/var/ob1-telegram-bridge/telegram-review-state.json`

### Dictation Importer

Minimum required values:

- `MCP_ACCESS_KEY`
- `CONSUL_HTTP_ADDR`
- `MINIO_SERVICE_NAME=minio`
- `MINIO_ACCESS_KEY`
- `MINIO_SECRET_KEY`
- `MINIO_SECURE=false`
- `DICTATION_MINIO_BUCKET=dictation-artifacts`

Recommended values:

- `OPEN_BRAIN_BASE_URL=http://localhost:8787`
- `DICTATION_MINIO_PREFIX=canonical/`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_REVIEW_MODE=full`
- `TELEGRAM_REVIEW_MATCH_THRESHOLD=0.78`
- `TELEGRAM_REVIEW_MATCH_COUNT=3`
- `TELEGRAM_REVIEW_STATE_FILE=/usr/local/var/ob1-telegram-bridge/telegram-review-state.json`

## Required External Changes

### Dictation

The `dictation` service must add:

- `POST /v1/dictation/notes/from-object`

Required behavior:

- read an audio object from MinIO
- run the normal transcription/cleanup pipeline
- preserve Telegram provenance metadata
- publish the canonical markdown artifact to the MinIO artifact bucket after success

### MinIO

Required buckets:

- `telegram-raw-audio`
- `dictation-artifacts`

Required key layouts:

- raw audio: `telegram/YYYY/MM/DD/<chat_id>/<message_id>-<file_unique_id>.<ext>`
- artifacts: `canonical/YYYY/MM/DD/<artifact_id>.md`

## Managed Service Contract

The sysadmin-managed deployment should:

1. Ensure the local OB1 runtime is already running and healthy.
2. Ensure MinIO is reachable with the configured buckets and credentials.
3. Ensure the dictation object-submit endpoint is live before enabling Telegram voice capture.
4. Create a Python virtualenv for the Telegram bridge under [integrations/telegram-capture](/Users/luchoh/Dev/OB1/integrations/telegram-capture#L1) and install [requirements.txt](/Users/luchoh/Dev/OB1/integrations/telegram-capture/requirements.txt#L1).
5. Create a Python virtualenv for the dictation importer under [recipes/dictation-import](/Users/luchoh/Dev/OB1/recipes/dictation-import#L1) and install [requirements.txt](/Users/luchoh/Dev/OB1/recipes/dictation-import/requirements.txt#L1).
6. Run exactly one Telegram bridge instance.
7. Run exactly one dictation importer instance in polling mode.
8. Pass `--verbose` to both services so progress is visible in logs.
9. Restart the workers if they exit.
10. Do not register either worker in Consul; these are background ingest jobs, not network services.
11. Provide `MINIO_SECURE=false` explicitly in the worker env for the current local managed deployment.
12. Keep `MINIO_ENDPOINT` unset unless deliberately bypassing Consul for an isolated manual probe.

## Example Commands

Telegram bridge:

```bash
cd /Users/luchoh/Dev/OB1/integrations/telegram-capture
.venv/bin/python telegram_bridge.py --verbose
```

Dictation importer:

```bash
cd /Users/luchoh/Dev/OB1/recipes/dictation-import
.venv/bin/python import-dictation.py \
  --bucket "$DICTATION_MINIO_BUCKET" \
  --prefix "${DICTATION_MINIO_PREFIX:-canonical/}" \
  --poll \
  --poll-interval 30 \
  --verbose
```

## Verification

After deployment, verify in this order:

1. Confirm OB1 is healthy:
   ```bash
   curl -fsS http://localhost:8787/health
   ```
2. Run a one-batch Telegram bridge dry-run:
   ```bash
   cd /Users/luchoh/Dev/OB1/integrations/telegram-capture
   .venv/bin/python telegram_bridge.py --once --verbose
   ```
3. Run a one-shot dictation import probe:
   ```bash
   cd /Users/luchoh/Dev/OB1/recipes/dictation-import
   .venv/bin/python import-dictation.py \
     --bucket "$DICTATION_MINIO_BUCKET" \
     --prefix "${DICTATION_MINIO_PREFIX:-canonical/}" \
     --limit 1 \
     --verbose
   ```
4. Send a typed Telegram message and confirm it appears in OB1.
5. Send a Telegram voice note and confirm:
   - raw audio object written to `telegram-raw-audio`
   - dictation accepts the object submission
   - canonical artifact appears in `dictation-artifacts`
   - OB1 imports the resulting dictation note/thoughts

## Sysadmin Prompt

Use this exact prompt if you want to hand off the setup cleanly:

```text
Please deploy the Telegram capture and dictation import background workers for OB1, and make the required dictation/MinIO changes for the voice path.

Repo-managed worker entrypoints:
- Telegram bridge:
  - integrations/telegram-capture/telegram_bridge.py
- Dictation importer:
  - recipes/dictation-import/import-dictation.py

Supporting product/infra docs:
- docs/14-telegram-capture-prd.md
- docs/15-telegram-dictation-minio-prd.md
- docs/11-local-dictation-ingest-prd.md

Target behavior:
1. Typed Telegram messages sent to the bot should ingest directly into OB1.
2. Telegram voice/audio should upload to MinIO raw storage first.
3. Dictation should accept an object-reference submission:
   - POST /v1/dictation/notes/from-object
4. Dictation should fetch the object, transcribe/clean it, and publish the canonical markdown artifact into MinIO.
5. The dictation importer should poll the canonical artifact bucket and ingest resulting dictation notes/thoughts into OB1.
6. Telegram-origin transcripts must pass the same meaningfulness/novelty gate as typed Telegram text before they are stored in OB1.
7. Telegram-origin text and Telegram-origin dictation thoughts must default to the full Telegram review loop before ingest, using the shared Telegram review-state file.
8. Zero-thought Telegram captures may still use the simpler `Record / Ignore` override prompt.

Required MinIO setup:
- Create bucket: telegram-raw-audio
- Create bucket: dictation-artifacts
- Keep these key layouts:
  - telegram/YYYY/MM/DD/<chat_id>/<message_id>-<file_unique_id>.<ext>
  - canonical/YYYY/MM/DD/<artifact_id>.md

Required worker behavior:
- run exactly one Telegram bridge instance
- run exactly one dictation importer instance
- pass --verbose to both
- restart them if they exit
- do not register them in Consul

Suggested commands:
- Telegram bridge:
  cd /Users/luchoh/Dev/OB1/integrations/telegram-capture
  .venv/bin/python telegram_bridge.py --verbose

- Dictation importer:
  cd /Users/luchoh/Dev/OB1/recipes/dictation-import
  .venv/bin/python import-dictation.py \
    --bucket "$DICTATION_MINIO_BUCKET" \
    --prefix "${DICTATION_MINIO_PREFIX:-canonical/}" \
    --poll \
    --poll-interval 30 \
    --verbose

Required env for Telegram bridge:
- TELEGRAM_BOT_TOKEN
- TELEGRAM_ALLOWED_CHAT_IDS
- MCP_ACCESS_KEY
- CONSUL_HTTP_ADDR
- MINIO_SERVICE_NAME=minio
- MINIO_ACCESS_KEY
- MINIO_SECRET_KEY
- MINIO_SECURE=false
- TELEGRAM_RAW_AUDIO_BUCKET=telegram-raw-audio
- TELEGRAM_ENSURE_RAW_BUCKET=false
- DICTATION_ACCESS_KEY
- OPEN_BRAIN_BASE_URL=http://localhost:8787
- DICTATION_BASE_URL=https://dictation.lincoln.luchoh.net
- DICTATION_OBJECT_SUBMIT_URL=https://dictation.lincoln.luchoh.net/v1/dictation/notes/from-object

Required env for dictation importer:
- MCP_ACCESS_KEY
- CONSUL_HTTP_ADDR
- MINIO_SERVICE_NAME=minio
- MINIO_ACCESS_KEY
- MINIO_SECRET_KEY
- MINIO_SECURE=false
- DICTATION_MINIO_BUCKET=dictation-artifacts
- OPEN_BRAIN_BASE_URL=http://localhost:8787
- DICTATION_MINIO_PREFIX=canonical/
- TELEGRAM_BOT_TOKEN
- TELEGRAM_REVIEW_MATCH_THRESHOLD=0.78
- TELEGRAM_REVIEW_MATCH_COUNT=3
- TELEGRAM_REVIEW_STATE_FILE=/usr/local/var/ob1-telegram-bridge/telegram-review-state.json

Please return:
- the final launchd labels for both workers
- the final env file paths used by both workers
- confirmation that the MinIO buckets exist
- confirmation that dictation now supports POST /v1/dictation/notes/from-object
- the final log file paths
- any deviations from the repo contract
```
