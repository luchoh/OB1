---
title: "OB1 Local Dictation Rollout"
created_at: "2026-03-15T20:12:43+00:00"
source: "codex"
language: "en"
whisper_model: "large-v3"
cleanup_model: "qwen3.5-35b"
tags:
  - ob1
  - dictation
  - local-only
  - verification
  - m3-ultra
raw_transcript: |
  Manual rollout note written after live verification of the new local dictation stack.
---

Surprise: OB1 now has a new fully local dictation path on `m3ultrastudio`.

Current pipeline:
- Audio -> local WhisperKit on `127.0.0.1:8080` using `openai/large-v3`
- Transcript cleanup -> local `qwen3.5-35b` on `127.0.0.1:8033/v1` with thinking disabled
- Output -> local markdown note saved to `/Volumes/llama-models/ob1-dictation/outbox`

What was verified on March 15, 2026:
- `ob1-dictation` is healthy and running under launchd on port `8888`
- WhisperKit is healthy and running locally on `large-v3`
- An `8.727562s` WAV completed end-to-end in `3.95s` after upload
- Saved note frontmatter is valid YAML and parses correctly
- The pipeline is local-only at inference time

Important implementation detail:
- The first cleanup pass was accidentally slow because `qwen3.5-35b` was running in thinking mode
- That was fixed by explicitly disabling thinking for cleanup requests
- The latency regression is resolved

Current limitation:
- Direct OB1 ingest is still not configured
- For now, dictation notes land in the outbox and can be forwarded later when an ingest endpoint is defined

Net result:
- OB1 has a new local dictation capability
- The M3 Ultra is now doing the speech-to-text and cleanup work locally
- The system is fast enough for practical use again
