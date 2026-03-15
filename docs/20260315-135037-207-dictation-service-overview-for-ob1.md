---
title: "Dictation Service Overview for OB1"
created_at: "2026-03-15T20:50:37+00:00"
source: "codex"
language: "en"
tags:
  - "ob1"
  - "dictation"
  - "docs"
  - "producer"
  - "rollout"
raw_transcript: |
  Manual informational note written for OB1 about the dictation producer service.
whisper_model: "none"
cleanup_model: "none"
source_host: "m3ultrastudio"
cleanup_mode: "none"
cleanup_applied: false
cleanup_thinking_disabled: false
audio_duration_seconds: null
cleaned_text_hash: "138e3a7c7ed56207bda05f82594709e63c0987398601bdb98f7edd0cfe972a7d"
audio_sha256: "none"
audio_filename: "manual-note"
dictation_service_version: "manual"
---

`dictation` is a standalone local producer service on `m3ultrastudio`. It owns audio intake, WhisperKit transcription, optional local cleanup, and markdown artifact packaging. It writes one canonical artifact per completed request to `/Volumes/llama-models/dictation/outbox`.

How OB1 should use it:
- watch `/Volumes/llama-models/dictation/outbox`
- when a new markdown file appears, parse the YAML frontmatter and markdown body
- import the markdown body as the note text
- use `raw_transcript` when you want the unedited speech record
- if `cleanup_mode` is `llm`, the body is the cleaned note text
- if `cleanup_mode` is `none`, the body is the raw transcript and OB1 may run its own logical pass
- do not require `dictation` to call OB1 directly; ingestion is asynchronous and consumer-driven

Operational facts:
- service name: `dictation`
- health: `http://127.0.0.1:8888/health`
- API: `http://127.0.0.1:8888/v1/dictation/notes`
- local-only: yes
- default behavior: cleanup is enabled by default
- per-request override: send `cleanup_mode=none` to skip local cleanup
