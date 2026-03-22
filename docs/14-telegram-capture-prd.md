# PRD: OB1 Telegram Capture Inbox

Date: 2026-03-21
Status: Proposed
Owner: Platform / Capture Pipelines

## Summary

Add Telegram as a private mobile capture inbox for OB1.

The product goal is simple:

- type a message to Telegram
- or send a voice note/audio clip to Telegram
- have OB1 ingest it automatically as memory

This PRD explicitly assumes:

- Telegram integration is bot-based
- OB1 already has a separate local dictation/transcription service
- Telegram voice/audio should be transcribed by the existing dictation stack
- TDLib and user-account automation are out of scope

The architectural split is:

- `telegram-bridge` owns Telegram Bot API intake
- `dictation` owns audio transcription and cleanup
- `OB1` owns canonical memory ingest and retrieval

## Problem

OB1 already has:

- direct local capture
- document and email ingestion
- a verified dictation producer and OB1 dictation ingest design

What it does not yet have is a low-friction mobile inbox.

The desired user behavior is:

- capture an idea from a phone without opening a specialized app
- use either typed text or a voice note
- trust that the note lands in the brain automatically

Telegram is a good candidate because:

- it is already a daily-use mobile interface
- it supports both text and voice notes
- it has a stable Bot API

But the implementation boundary matters:

- Telegram Bot API does not provide a ready-made transcript for bot-received voice notes
- bots receive file references and must download the audio
- Telegram's native transcription API is for user accounts, not bots

So the right v1 is not "ask Telegram to transcribe it".
The right v1 is "use Telegram for intake, and use our own dictation service for transcription".

## Research-Backed Findings

From the official Telegram documentation:

- the Bot API is an HTTP-based interface for bots
- bots receive typed messages as `message.text`
- bots receive voice notes as `voice` objects with file identifiers and metadata
- bots download media by calling `getFile` and then fetching the returned file path
- on the default Telegram-hosted Bot API, bot downloads are limited to 20 MB
- a self-hosted local Bot API server removes that file download limit and can return absolute local file paths
- Telegram has a native voice transcription API in MTProto
- the `messages.transcribeAudio` method is explicitly user-only, not bot-usable

Design consequence:

- v1 must not depend on Telegram-native transcription
- v1 should use the standard Bot API plus our existing dictation service

## Goals

- Add a mobile capture inbox through Telegram
- Support both:
  - typed text capture
  - voice/audio capture
- Reuse the existing dictation service for Telegram voice/audio
- Preserve Telegram provenance and idempotency
- Keep the design compatible with the current OB1 local runtime and dictation seam
- Make the resulting memory searchable and grounded

## Non-Goals

- TDLib or user-account automation
- reading Telegram Saved Messages directly
- depending on Telegram-native transcription
- video-note support in v1
- broad group-chat ingestion in v1
- using Telegram as a canonical storage system

## Product Position

Telegram is only an inbox surface.

It is not:

- the system of record
- the transcription engine
- the memory store

Canonical responsibilities remain:

- Telegram: transport and intake UX
- dictation: audio transcription and cleanup
- PostgreSQL / OB1: canonical storage and retrieval

## Core Product Decision

### Intake Mode

Use a dedicated Telegram bot in direct private chat mode.

Do not start with:

- group chat collection
- broad mention/reply logic
- connected business bots
- personal-account automation

Reason:

- direct bot chat is the simplest supported bot path
- it avoids group privacy-mode complexity in v1
- it is easier to explain and operate

### Capture Split

Typed text and audio follow different canonical paths.

Typed text:

- Telegram bot receives message text
- bridge writes the message into OB1 as a source row
- bridge may also create distilled Telegram thoughts

Voice note or audio clip:

- Telegram bot receives a file reference
- bridge downloads the audio file
- bridge submits audio plus Telegram metadata to `dictation`
- dictation produces the canonical artifact
- OB1 consumes the dictation artifact through the normal dictation ingest path

Reason:

- typed text does not need transcription
- audio already has a validated producer/consumer path through dictation
- this preserves the dictation seam instead of duplicating it in the Telegram bridge

## System Boundary

`telegram-bridge` is a separate capture adapter.

Ownership split:

- `telegram-bridge` owns:
  - Bot API polling or webhook handling
  - Telegram message validation
  - dedupe of Telegram updates
  - file download for voice/audio messages
  - submission of audio to `dictation`
  - direct typed-text ingest into OB1
- `dictation` owns:
  - audio transcription
  - transcript cleanup
  - artifact packaging
  - outbox publication
- `OB1` owns:
  - canonical memory rows
  - thought distillation
  - retrieval
  - grounded answering

This boundary is deliberate.

## Recommended v1 Architecture

### Runtime Shape

Recommended components:

- `telegram-bridge`
- existing `dictation`
- existing OB1 local runtime

Recommended delivery mode for the bridge:

- long polling first

Reason:

- no extra inbound public endpoint is required
- simpler local operation
- easier to run behind the current private-network stack

Webhook support can be added later if needed.

### Bot Scope

Default v1 scope:

- one direct private chat with the bot
- all non-command text messages are capture candidates
- supported media:
  - `voice`
  - `audio`

Ignored in v1:

- `video_note`
- media albums
- forwarded multi-message reconstruction

## Canonical Flows

### Flow A: Typed Text

1. User sends a text message to the Telegram bot.
2. `telegram-bridge` receives the update.
3. The bridge validates that it is a direct-chat, non-command text capture.
4. The bridge writes one OB1 source row with Telegram provenance.
5. The bridge optionally distills up to 3 `telegram_thought` rows.
6. The bot replies with a short success acknowledgment.

### Flow B: Voice Note Or Audio Clip

1. User sends a Telegram voice note or audio clip to the bot.
2. `telegram-bridge` receives the update with file metadata.
3. The bridge resolves the file through `getFile` and downloads the audio bytes.
4. The bridge submits the audio plus Telegram provenance metadata to `dictation`.
5. `dictation` transcribes and cleans the note and writes the canonical artifact.
6. OB1 consumes that artifact through the normal dictation ingest path.
7. The bot replies with an acknowledgment once submission succeeds.

## Functional Requirements

### FR1: Typed Text Ingest

Each accepted Telegram text message must create one source row in `thoughts` with:

- `content` = the original message text
- `metadata.source = "telegram"`
- `metadata.type = "telegram_message"`
- `metadata.retrieval_role = "source"`
- Telegram provenance stored in `metadata.user_metadata`

Optional v1 distilled rows:

- `metadata.source = "telegram"`
- `metadata.type = "telegram_thought"`
- `metadata.retrieval_role = "distilled"`

### FR2: Audio Handoff To Dictation

Telegram audio messages must not be transcribed inside the bridge.

The bridge must:

- download the Telegram file
- preserve Telegram provenance
- submit the audio to `dictation`

The bridge must not:

- invent its own transcript
- bypass dictation and write pseudo-dictation rows directly

### FR3: Telegram Provenance

Minimum Telegram metadata to preserve when available:

- `telegram_update_id`
- `telegram_chat_id`
- `telegram_chat_type`
- `telegram_message_id`
- `telegram_user_id`
- `telegram_username`
- `telegram_message_date`
- `telegram_file_id`
- `telegram_file_unique_id`
- `telegram_media_type`

### FR4: Idempotency

The bridge must be safely retryable.

Minimum dedupe identities:

Typed text:

- `telegram:<chat_id>:<message_id>`

Audio:

- `telegram:<chat_id>:<message_id>:<file_unique_id-or-file_id>`

Retries must not create duplicate OB1 source rows or duplicate dictation submissions.

### FR5: Bot Download Limits

The v1 product must be explicit about Bot API media limits.

Default Bot API mode:

- support files within Telegram's default bot download limit

Optional later operational mode:

- self-host a local Bot API server if larger audio files become necessary

Do not silently truncate or partially process oversized media.

### FR6: Direct-Chat-Only v1

The bridge must default to direct private chat intake only.

Do not ingest arbitrary group traffic in v1.

If group support is later added, it must be explicit and separately evaluated.

### FR7: Acknowledgment Contract

The bot should acknowledge:

- text accepted
- audio accepted for transcription
- unsupported message type
- oversized or rejected media

Acknowledgments must be short and operational, not conversationally noisy.

## Data Contract

### Typed Telegram Source Row

Minimum metadata:

- `source = "telegram"`
- `type = "telegram_message"`
- `retrieval_role = "source"`
- `title = "Telegram message"` or a short derived title
- `user_metadata.telegram_*` provenance fields

### Distilled Telegram Thought Row

Minimum metadata:

- `source = "telegram"`
- `type = "telegram_thought"`
- `retrieval_role = "distilled"`
- `user_metadata.telegram_message_key`
- `user_metadata.telegram_chat_id`

### Telegram-To-Dictation Handoff

The handoff payload to `dictation` must include:

- audio bytes or canonical file path
- original Telegram filename when available
- Telegram message identity
- capture channel marker such as `capture_channel = "telegram"`
- optional text caption when present

The resulting dictation artifact must preserve that origin in frontmatter or metadata.

## Security And Privacy

- Telegram bot token must stay in local private config only
- audio downloads must be treated as private input material
- the bridge must not send Telegram content to external transcription services
- the bridge must not persist downloaded audio longer than needed for successful handoff
- the bot should not expose memory query tools in the same surface in v1

## Evaluation

Minimum product checks:

- typed text sent to the bot becomes retrievable in OB1
- voice note sent to the bot becomes a dictation artifact and then OB1 memory
- duplicate delivery of the same Telegram update does not create duplicate memory
- unsupported media is rejected explicitly
- provenance is visible on stored rows

Minimum manual QA questions:

- what did I send to Telegram about the DAC PSU?
- what note did I dictate from Telegram today?
- what Telegram captures came from voice rather than typed text?

## Rollout Plan

### Phase 1

- build `telegram-bridge`
- support direct-chat text capture
- support voice-note handoff to `dictation`
- support idempotent retries

### Phase 2

- add support for `audio` files beyond Telegram voice notes
- add optional captions as transcription context
- add better operational status and metrics

### Phase 3

- evaluate whether group-scoped capture is worth the complexity
- evaluate whether a local Bot API server is needed for large-audio workflows

## Risks

- Telegram Bot API file-size limits may be too restrictive for long recordings
- mixing typed capture and dictated capture in one inbox could create user ambiguity
- aggressive auto-distillation of short Telegram texts may create low-value thoughts
- group support could easily over-collect irrelevant chat traffic

## Open Questions

- Should short Telegram text messages always be distilled, or only stored as source unless they exceed a threshold?
- Should the bridge reply with the final cleaned dictation text, or only with receipt status?
- Should captions on voice notes be prepended as context for dictation cleanup?

## Recommendation

Ship a direct-message Telegram bot inbox first.

Use:

- direct OB1 ingest for typed text
- dictation handoff for Telegram voice/audio

Do not use TDLib.
Do not depend on Telegram-native transcription.
Do not start with groups.
