# Telegram Capture

> Use a Telegram bot as a private capture inbox for typed notes and voice/audio handoff into Open Brain.

## What It Does

Adds a dedicated Telegram bot inbox to OB1.

- typed messages are ingested directly into OB1 as `telegram_message` source rows plus `telegram_thought` distilled rows
- voice notes and audio clips are uploaded to MinIO and handed off to the separate dictation service for transcription
- trivial text like `Hi` is not auto-recorded
- text that looks duplicate or ambiguous is held for `Record / Ignore` review in Telegram before OB1 ingest

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
MINIO_ENDPOINT=...
MINIO_ACCESS_KEY=...
MINIO_SECRET_KEY=...
DICTATION_ACCESS_KEY=...
```

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

- if meaningful and novel:
  - one `telegram_message` source row
  - up to 3 `telegram_thought` rows
- if trivial:
  - nothing is stored automatically
  - Telegram explains why it was not auto-recorded
  - Telegram offers `Record / Ignore` so the user can override without resending
- if duplicate or uncertain:
  - nothing is stored yet
  - Telegram sends a `Record / Ignore` review prompt

Voice or audio message:

- raw file stored in the configured MinIO bucket
- object reference submitted to dictation
- short Telegram acknowledgment confirming it was queued for transcription

## Notes

- v1 only supports direct private chat capture.
- v1 does not use TDLib or Telegram-native transcription.
- v1 sends raw audio through MinIO first, then hands off an object reference to dictation.
