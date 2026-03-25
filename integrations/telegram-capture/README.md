# Telegram Capture

> Use a Telegram bot as a private capture inbox for typed notes and voice/audio handoff into Open Brain.

## What It Does

Adds a dedicated Telegram bot inbox to OB1.

- typed messages are ingested directly into OB1 as `telegram_message` source rows plus `telegram_thought` distilled rows
- voice notes and audio clips are uploaded to MinIO and handed off to the separate dictation service for transcription
- trivial text like `Hi` is not auto-recorded
- Telegram-origin text now defaults to a full thought-review loop in Telegram before OB1 ingest

This integration is bot-based and direct-chat-only in v1.

## Prerequisites

- Working Open Brain local runtime
- Existing dictation service with object-reference submission support
- MinIO reachable for raw Telegram audio
- Telegram bot token from BotFather

## Install

```bash
cd /Users/luchoh/Dev/OB1/integrations/telegram-capture
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Env

Copy `.env.example` and fill in the values you actually use.

Minimum required values:

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_CHAT_IDS=123456789
MCP_ACCESS_KEY=...
CONSUL_HTTP_ADDR=...
MINIO_SERVICE_NAME=minio
MINIO_ACCESS_KEY=...
MINIO_SECRET_KEY=...
MINIO_SECURE=false
TELEGRAM_ENSURE_RAW_BUCKET=false
TELEGRAM_REVIEW_MODE=full
DICTATION_ACCESS_KEY=...
```

Notes:

- the canonical MinIO path is Consul discovery through `MINIO_SERVICE_NAME`
- `MINIO_ENDPOINT` is only an explicit manual override
- the current local managed deployment uses `MINIO_SECURE=false`

## One Batch Test

```bash
python telegram_bridge.py --once --verbose
```

## Dry-Run On A Saved Update

```bash
python telegram_bridge.py \
  --update-file /tmp/telegram-update.json \
  --dry-run \
  --verbose
```

## Long Polling

```bash
python telegram_bridge.py --verbose
```

## Expected Outcome

Typed message:

- if durable thoughts are extracted:
  - Telegram shows the candidate thoughts before ingest
  - the user can `Approve`, `Edit`, `Deny`, `Approve All`, `Commit`, `Deny All`, or `View Raw`
  - nothing is stored until `Commit`
- if trivial:
  - nothing is stored automatically
  - Telegram explains why it was not auto-recorded
  - Telegram offers `Record / Ignore` and `View Raw` so the user can override without resending
- if you need the older behavior:
  - set `TELEGRAM_REVIEW_MODE=exceptions_only`
  - the bridge will auto-ingest clearly novel thoughts and only prompt on ambiguous, duplicate, or zero-thought cases

Voice or audio message:

- raw file stored in the configured MinIO bucket
- object reference submitted to dictation
- short Telegram acknowledgment confirming it was queued for transcription
- after transcription, Telegram-origin transcripts follow the same Telegram review loop before any OB1 ingest

## Notes

- v1 only supports direct private chat capture.
- v1 does not use TDLib or Telegram-native transcription.
- v1 sends raw audio through MinIO first, then hands off an object reference to dictation.
- managed deployments should not auto-create the raw-audio bucket; set `TELEGRAM_ENSURE_RAW_BUCKET=false`.
