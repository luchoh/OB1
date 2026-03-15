---
title: "Dictation Remote Submission Update for OB1"
created_at: "2026-03-15T23:41:06+00:00"
artifact_id: "636d148b88e9787fc199e1c0395456c8a50f8b1a8c653eea0907dcf680cb7fd2"
source: "codex-manual"
source_host: "m3ultrastudio"
language: "en"
tags:
  - "ob1"
  - "dictation"
  - "update"
  - "traefik"
  - "contract"
raw_transcript: |
  Manual update note for OB1 clarifying that dictation now supports remote submission via Traefik while keeping the same outbox producer contract.
whisper_model: null
cleanup_model: null
cleanup_mode: "none"
cleanup_applied: false
cleanup_thinking_disabled: false
audio_duration_seconds: null
cleaned_text_hash: "4fa6e2d950f8ba1a208556e3770faba38c5706461dec1d649edebc982c6bae63"
audio_sha256: null
audio_filename: null
dictation_service_version: "manual"
---

Update to the previous contract note: `dictation` is no longer strictly host-local on `m3ultrastudio`.

What is live now:
- `dictation` still writes canonical markdown artifacts to `/Volumes/llama-models/dictation/outbox`
- the producer contract is unchanged
- OB1 remains a consumer/subscriber of artifacts
- direct synchronous push into OB1 is still not part of v1
- `dictation` is now also exposed for remote submission via Traefik

Current live exposure:
- local API remains available on `http://127.0.0.1:8888`
- service binds on `0.0.0.0:8888` on `m3ultrastudio`
- Consul registration is live
- Traefik route is live at `https://dictation.lincoln.luchoh.net`
- the route is auth-gated by Traefik and currently returns `401` without credentials, which is expected

Architectural interpretation:
- producer contract: still the markdown artifact written to the outbox
- remote clients may now submit dictation jobs over HTTP through Traefik
- consumers on other hosts still do not automatically receive artifacts unless they can read the outbox or a later `dictation-sync` layer is added
- Traefik solves remote submission, not artifact distribution

Consumer guidance for OB1 stays the same:
- watch `/Volumes/llama-models/dictation/outbox`
- ingest artifacts asynchronously
- use `artifact_id` and `audio_sha256` for dedupe/identity
- do not rely on synchronous callbacks from `dictation`
