# PRD: Telegram Capture, Dictation Object Intake, And MinIO Distribution

Date: 2026-03-21
Status: Proposed
Owner: Platform / Capture Pipelines / Sysadmin

## Summary

Enable a Telegram bot inbox for OB1 with the following capture flow:

- typed Telegram messages ingest directly into OB1
- Telegram voice/audio is uploaded to MinIO first
- `dictation` transcribes from the MinIO object reference
- canonical dictation artifacts are published to MinIO
- OB1 imports those canonical artifacts from MinIO

This PRD is the infrastructure and service contract needed to make [docs/14-telegram-capture-prd.md](/Users/luchoh/Dev/OB1/docs/14-telegram-capture-prd.md#L1) real.

## Problem

The OB1 repo now contains:

- a Telegram bridge implementation
- a MinIO-backed dictation artifact importer

But the surrounding infrastructure contract is still missing.

In particular, the production path now depends on:

- one new Telegram bridge worker
- one new dictation importer worker
- a MinIO raw-audio bucket
- a MinIO canonical-artifact bucket
- a dictation service endpoint that can accept object references instead of raw uploads

Without these pieces, typed Telegram capture can work locally, but Telegram voice/audio cannot complete the full path into OB1 memory.

## Goals

- Deploy Telegram capture as a direct-message bot workflow
- Keep Telegram voice/audio on the existing dictation path, not a second transcription path
- Use MinIO as the cross-service handoff for raw audio and canonical dictation artifacts
- Preserve canonical identity and provenance across Telegram, dictation, MinIO, and OB1
- Keep the services operationally simple: background workers, not new public APIs beyond dictation

## Non-Goals

- TDLib or user-account Telegram automation
- Telegram webhooks in v1
- group-chat capture in v1
- making MinIO the canonical metadata store
- adding a new network-facing OB1 service

## Required Components

### 1. Telegram Bridge Worker

Service responsibility:

- poll the Telegram Bot API
- accept direct private-chat messages only
- ingest typed text directly into OB1
- upload Telegram voice/audio to MinIO raw storage
- submit object references to dictation

This worker is a background job.

It should not:

- register in Consul
- expose a public HTTP endpoint
- perform transcription itself

### 2. Dictation Service Object Intake

Required new dictation capability:

- `POST /v1/dictation/notes/from-object`

This endpoint must accept:

- storage backend
- bucket
- object key
- content type
- original filename
- `cleanup_mode`
- capture channel metadata
- Telegram provenance block

Behavior:

- fetch the audio object from MinIO
- run the normal dictation transcription/cleanup pipeline
- emit the same canonical markdown artifact shape already used by dictation

### 3. Canonical Artifact Publication To MinIO

The Telegram/MinIO path requires canonical dictation artifacts to appear in MinIO.

For this deployment, the accepted v1 path is:

- `dictation` writes the canonical markdown artifact to MinIO directly after successful processing

Required bucket:

- `dictation-artifacts`

Required key layout:

- `canonical/YYYY/MM/DD/<artifact_id>.md`

Operational note:

- this keeps the bucket/key contract stable
- a later standalone `dictation-sync` service may replace the direct dictation-side write without changing consumers

### 4. Dictation Import Worker

Service responsibility:

- poll the canonical artifact bucket in MinIO
- import unseen artifacts into OB1 as:
  - one `dictation_note`
  - up to 3 `dictation_thought` rows

This worker is also a background job.

It should not:

- register in Consul
- mutate artifact contents
- depend on direct filesystem access to the dictation producer host

## MinIO Contract

### Buckets

Required buckets:

- `telegram-raw-audio`
- `dictation-artifacts`

### Key Layouts

Raw Telegram audio:

- `telegram/YYYY/MM/DD/<chat_id>/<message_id>-<file_unique_id>.<ext>`

Canonical dictation artifacts:

- `canonical/YYYY/MM/DD/<artifact_id>.md`

### Access Pattern

Recommended least-privilege access:

- Telegram bridge:
  - read/write `telegram-raw-audio`
- dictation:
  - read `telegram-raw-audio`
  - write `dictation-artifacts`
- dictation importer:
  - read `dictation-artifacts`

### Identity Rule

Object location is transport, not canonical identity.

Canonical identity remains:

- `audio_sha256` when present
- else `artifact_id`

## Service Topology

### Existing Services Kept

- `open-brain-local`
- `dictation`
- `MinIO`

### New Background Services

- `telegram-capture-bridge`
- `dictation-import-watch`

### New Public API Surface

Only one new public internal API is required:

- `POST /v1/dictation/notes/from-object`

No new public OB1 endpoint is required.

## Verification

Minimum acceptance flow:

1. Send a typed Telegram message to the bot.
2. Confirm it lands in OB1 as:
   - `telegram_message`
   - `telegram_thought` rows
3. Send a Telegram voice note to the bot.
4. Confirm raw audio appears in `telegram-raw-audio`.
5. Confirm dictation fetches the object and produces a canonical artifact.
6. Confirm the canonical artifact appears in `dictation-artifacts`.
7. Confirm the dictation importer writes:
   - one `dictation_note`
   - distilled `dictation_thought` rows
8. Confirm `ask_brain` can answer from both capture paths.

## Risks

- if dictation does not publish canonical artifacts to MinIO, the new importer path cannot complete
- if MinIO credentials are over-broad, Telegram raw audio becomes unnecessarily exposed
- if more than one bridge instance runs, Telegram long-poll offsets can conflict
- if more than one dictation importer runs against the same bucket without shared state, duplicate imports become more likely

## Recommendation

Deploy the two new workers and add the MinIO-based object intake/output contract to dictation.

That is the smallest operational slice that makes Telegram text and Telegram voice both reach OB1 cleanly.
