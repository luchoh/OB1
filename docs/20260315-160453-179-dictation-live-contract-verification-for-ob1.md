---
title: "Dictation Live Contract Verification for OB1"
created_at: "2026-03-15T23:04:53+00:00"
artifact_id: "fad194bc85dce3837c4f4ac2c852909bdb2ce32ab522e08ee4bb1f7532940b08"
source: "codex-manual"
source_host: "m3ultrastudio"
language: "en"
tags:
  - "ob1"
  - "dictation"
  - "contract"
  - "verification"
  - "rollout"
raw_transcript: |
  Manual notification for OB1 about the live dictation contract changes and verification state.
whisper_model: null
cleanup_model: null
cleanup_mode: "none"
cleanup_applied: false
cleanup_thinking_disabled: false
audio_duration_seconds: null
cleaned_text_hash: "e7e272be8e12febd762d62030cd85994195c1e3954dce0dbf744ab0c355f1895"
audio_sha256: null
audio_filename: null
dictation_service_version: "manual"
---

`dictation` has now been verified live on `m3ultrastudio` after the contract normalization changes.

What changed and is now live:
- canonical service name: `dictation`
- canonical outbox path: `/Volumes/llama-models/dictation/outbox`
- service binds to `127.0.0.1:8888`
- health reports `local_only: true`
- typed metadata no longer uses fake string placeholders such as `"none"`; non-applicable typed fields use `null`
- producer now emits `artifact_id`
- producer emits `audio_sha256` for produced audio artifacts
- `cleanup_mode` allowed values are `llm` and `none`
- `cleanup_mode=llm` means the markdown body is cleaned note text and `raw_transcript` preserves the speech record
- `cleanup_mode=none` means the markdown body is the raw transcript and a consumer may do its own logical pass later
- `cleaned_text_hash` now matches the exact markdown body bytes on disk for new artifacts

Live verification summary:
- `http://127.0.0.1:8888/health` reports `service: dictation`, `bind_host: 127.0.0.1`, `local_only: true`, `whisper_model_default: large-v3`, and `cleanup_mode_default: llm`
- `lsof` confirms the service listens only on `127.0.0.1:8888`
- a default cleanup request produced a valid artifact with `artifact_id`, `whisper_model: large-v3`, `cleanup_model: qwen3.5-35b`, and a body hash that matches the saved file
- a raw override request produced a valid artifact with `cleanup_model: null`, `cleanup_mode: none`, `cleanup_applied: false`, and a body exactly equal to `raw_transcript`

Consumer guidance for OB1 stays unchanged:
- treat `dictation` as the producer
- watch `/Volumes/llama-models/dictation/outbox`
- ingest artifacts asynchronously
- do not require synchronous push from `dictation` into OB1

One nuance:
Older artifacts created before the final hash fix may still have the previous `cleaned_text_hash` mismatch. New artifacts created after the final rebuild are correct.
