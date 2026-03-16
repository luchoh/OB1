# PRD: OB1 Local Dictation Ingest

Date: 2026-03-15
Status: Draft v1
Owner: Platform / Capture Pipelines

## Summary

OB1 now has a verified local dictation producer on the M3 Ultra:

- audio transcription via local WhisperKit
- transcript cleanup via local Qwen
- output written as markdown notes to a local outbox

That is a good capture path, but it is not yet an OB1 memory path. This PRD defines the missing product slice: automatically ingest dictation artifacts into OB1 as searchable, grounded memory with provenance, idempotency, and private-network-only operation.

The architectural boundary is explicit:

- dictation is a separate producer service
- dictation-sync may distribute canonical artifacts without changing them
- OB1 is a consumer of dictation artifacts
- the dictation producer may later serve other consumers besides OB1

The design goal is simple:

- speak into the local dictation stack
- get a cleaned note written to the canonical outbox
- have OB1 ingest it automatically from either:
  - direct outbox access
  - or a distributed artifact source
- make it retrievable both as source material and as distilled memory

## Problem

The current dictation rollout stops at the filesystem.

Verified current state from:

- [docs/20260315-131243-ob1-local-dictation-rollout.md](/Users/luchoh/Dev/OB1/docs/20260315-131243-ob1-local-dictation-rollout.md#L1)
- [docs/20260315-160453-179-dictation-live-contract-verification-for-ob1.md](/Users/luchoh/Dev/OB1/docs/20260315-160453-179-dictation-live-contract-verification-for-ob1.md#L1)
- [docs/20260315-164106-790-dictation-remote-submission-update-for-ob1.md](/Users/luchoh/Dev/OB1/docs/20260315-164106-790-dictation-remote-submission-update-for-ob1.md#L1)

- local dictation is healthy
- transcription and cleanup are local-only on the producer host
- notes are written to an outbox directory
- direct OB1 ingest is not configured

That means dictation is useful as a note-taking tool, but it is not yet part of the brain. The current gap is not speech recognition. The gap is ingestion contract and operational flow.

## Goals

- Turn local dictation notes into OB1 memory automatically
- Preserve provenance from source audio/transcript through final OB1 rows
- Keep the path private-network-only and compatible with the current local OB1 runtime
- Make the ingest idempotent and safe to retry
- Support multi-host consumption without requiring direct filesystem access to the producer host
- Store both:
  - the source dictation note
  - distilled thought rows derived from it

## Non-Goals

- Real-time streaming ingest directly from microphone to OB1
- Replacing the existing dictation producer
- Designing a general meeting-transcript workflow in v1
- Long-form transcript evaluation or brainstorming in v1
  - that can later use [recipes/panning-for-gold](/Users/luchoh/Dev/OB1/recipes/panning-for-gold/README.md#L1)
- Audio retention as a hard dependency in v1

## Product Definition

### Product Name

OB1 Local Dictation Ingest

### Core Promise

A dictation artifact produced by the local dictation service becomes searchable OB1 memory without manual forwarding or copy/paste.

### User Story

As a user, I want to dictate a note locally and trust that it will show up in OB1 automatically, with the cleaned text available for retrieval and the raw transcript still traceable, even when OB1 is running on a different host.

## Current Verified State

From [docs/20260315-131243-ob1-local-dictation-rollout.md](/Users/luchoh/Dev/OB1/docs/20260315-131243-ob1-local-dictation-rollout.md#L1):

- dictation service is healthy on the M3 Ultra
- WhisperKit uses `openai/large-v3`
- cleanup uses local `qwen3.5-35b`
- cleanup latency was fixed by disabling thinking mode
- notes are written to `/Volumes/llama-models/dictation/outbox`
- frontmatter is valid YAML
- canonical service name is `dictation`
- the producer serves a local API on `127.0.0.1:8888`
- the producer is also remotely submittable on the private network through Traefik
- Consul registration is live
- the authenticated internal route is `https://dictation.lincoln.luchoh.net`
- typed metadata uses `null` for non-applicable fields
- producer emits `artifact_id`
- `cleanup_mode` values are `llm` and `none`
- `cleaned_text_hash` is verified against the saved body for new artifacts

Implication:

- the producer exists
- the output file exists
- the missing piece is the importer/watcher plus the stable ingest contract
- older artifacts created before the final hash fix may still have a `cleaned_text_hash` mismatch

Multi-host distribution note:

- the canonical producer seam is still the local outbox on `m3ultrastudio`
- a separate system PRD now proposes `dictation-sync` plus MinIO for cross-host distribution
- this PRD treats MinIO-backed distribution as the preferred multi-host consumer path once available

## v1 Product Decision

Use an artifact watcher/importer.

Do not couple the dictation service directly to the OB1 ingest endpoint in v1.

Reason:

- the outbox is already the validated seam
- it gives replay, retry, and auditability
- it keeps speech capture independent from OB1 availability
- it is easier to operate than a tightly coupled synchronous push path

Consumer mode decision:

- simple/local mode: consume directly from the canonical outbox when OB1 has direct access
- preferred multi-host mode: consume from MinIO after `dictation-sync` distributes byte-identical artifacts

## System Boundary

The dictation stack is not part of the OB1 runtime.

Ownership split:

- `dictation` owns:
  - audio intake
  - transcription
  - cleanup
  - packaging the canonical markdown artifact
  - publishing that artifact to the outbox
- `dictation-sync` may own:
  - distribution of canonical artifacts to shared storage
  - retry/backoff for distribution
  - distribution state
- `OB1` owns:
  - watching/subscribing to the dictation artifact source
  - validating artifact structure
  - ingesting source rows
  - creating derived memory rows
  - retrieval and grounded answering

This boundary is deliberate.

Reason:

- the dictation service can be reused by other consumers
- OB1 stays focused on memory, not speech infrastructure
- the artifact seam gives replay, auditability, and multi-consumer compatibility

## Canonical Flow

1. User records dictation through the local dictation stack.
2. The dictation stack writes a markdown note with YAML frontmatter into the canonical outbox.
3. One of two consumer paths is used:
   - direct mode: OB1 watches the canonical outbox
   - distributed mode: `dictation-sync` uploads the exact artifact bytes to MinIO and OB1 watches the distributed artifact source
4. The OB1 importer parses the artifact and validates the frontmatter contract.
5. The importer ingests one source row into OB1.
6. The importer distills up to 3 durable `dictation_thought` rows from the cleaned note.
7. On success, importer state records the artifact as processed.
8. On failure, the artifact stays retriable and is not silently dropped.

## Functional Requirements

### FR1: Stable Dictation Note Contract

The producer must write markdown files with:

- valid YAML frontmatter
- cleaned transcript body as markdown content
- required provenance fields

Required v1 frontmatter:

- `artifact_id`
- `title`
- `created_at`
- `source`
- `source_host`
- `language`
- `tags`
- `raw_transcript`
- `whisper_model`
- `cleanup_model`
- `cleanup_mode`
- `cleanup_applied`
- `cleanup_thinking_disabled`
- `audio_duration_seconds`
- `cleaned_text_hash`
- `audio_sha256`
- `audio_filename`
- `dictation_service_version`

Typed metadata rule:

- non-applicable typed fields use `null`
- do not use fake string placeholders such as `"none"`

Cleanup mode rule:

- `cleanup_mode = llm` means the markdown body is cleaned note text and `raw_transcript` preserves the speech record
- `cleanup_mode = none` means the markdown body is the raw transcript and a consumer may do its own logical pass later

### FR2: Source Row Ingest

Each dictation file must create one source row in `thoughts` with:

- `content` = cleaned dictation text
- `metadata.source = "dictation"`
- `metadata.type = "dictation_note"`
- `metadata.retrieval_role = "source"`
- all frontmatter stored in `metadata.user_metadata`

The importer must preserve the canonical producer identity fields:

- `artifact_id`
- `audio_sha256`
- original artifact source URI or file path

### FR3: Distilled Memory Ingest

Each dictation file should also create up to 3 distilled rows with:

- `metadata.source = "dictation"`
- `metadata.type = "dictation_thought"`
- `metadata.retrieval_role = "distilled"`
- stable linkage back to the source dictation row

Distillation should use the same local LLM contract already used by email/document import:

- local inference path
- thinking disabled
- tool-calling for structured extraction

### FR4: Idempotency

The importer must be safely retryable.

Canonical v1 dedupe key order:

1. `dictation:${audio_sha256}` when `audio_sha256` exists
2. otherwise `dictation:${artifact_id}`
3. otherwise `dictation:${source_host}:${created_at}:${cleaned_text_hash}`

Derived thought rows must also use stable dedupe keys derived from the source note dedupe key.

If MinIO-backed distribution is used, object location must not become the primary identity. Object path is transport, not identity.

### FR5: Search and Answer Behavior

Imported dictation content must work with the existing local OB1 behavior:

- `search_thoughts` can retrieve source and distilled rows
- default search remains distilled-first
- `ask_brain` can answer from distilled dictation rows and cite them
- unsupported questions must still return insufficient-evidence responses

### FR6: Failure Handling

The importer must not silently drop files.

Required behavior:

- malformed frontmatter: mark failure and keep retriable
- ingest endpoint unavailable: retry later
- distillation failure: keep the source row, record the distillation error, retry derived rows later only if explicitly designed
- duplicate file replay: update/merge through the existing dedupe path, do not create duplicates

### FR7: Private-Network Operation

The whole path must remain private-network-only at runtime:

- local dictation producer
- local cleanup model
- local OB1 ingest endpoint
- local embeddings
- local PostgreSQL

Allowed network shape:

- authenticated remote submission to the `dictation` producer on the private network is acceptable
- artifact consumption still happens through the canonical artifact seam

No internet egress should be required for steady-state operation.

### FR8: Consumer-Friendly Artifact Contract

The dictation output must be stable enough that multiple consumers can read it without coupling to the dictation process internals.

That means:

- the markdown + frontmatter artifact is the public contract
- the outbox directory is the canonical producer seam
- OB1 must not depend on private in-process dictation state
- future consumers should be able to read the same artifact format

### FR9: Distribution-Source Compatibility

The OB1 importer must support at least these artifact sources:

- direct filesystem consumption from the canonical outbox
- distributed object consumption from MinIO when `dictation-sync` is deployed

The imported logical content must be identical regardless of which source path is used.

Rules:

- the markdown artifact remains the source of truth
- MinIO object metadata is advisory only
- object keys and transport paths must not replace frontmatter as canonical consumer data

## Data Contract

### Source Row Shape

Recommended metadata fields for `dictation_note`:

- `source = "dictation"`
- `type = "dictation_note"`
- `retrieval_role = "source"`
- `summary`
- `occurred_at = created_at`
- `user_metadata.artifact_id`
- `user_metadata.title`
- `user_metadata.language`
- `user_metadata.tags`
- `user_metadata.raw_transcript`
- `user_metadata.whisper_model`
- `user_metadata.cleanup_model`
- `user_metadata.cleanup_mode`
- `user_metadata.cleanup_applied`
- `user_metadata.cleanup_thinking_disabled`
- `user_metadata.source_host`
- `user_metadata.audio_duration_seconds`
- `user_metadata.audio_sha256`
- `user_metadata.audio_filename`
- `user_metadata.cleaned_text_hash`
- `user_metadata.dictation_file_path`
- `user_metadata.dictation_object_key`
- `user_metadata.dictation_storage_backend`

### Derived Row Shape

Recommended metadata fields for `dictation_thought`:

- `source = "dictation"`
- `type = "dictation_thought"`
- `retrieval_role = "distilled"`
- `user_metadata.source_dedupe_key`
- `user_metadata.dictation_file_path`
- `user_metadata.source_created_at`

## File Lifecycle

The outbox flow must be operationally explicit.

Recommended v1 directory model:

- `outbox/` for newly written notes
- `processed/` for successful imports
- `failed/` for files that exceeded retry policy or failed validation

Canonical producer outbox path:

- `/Volumes/llama-models/dictation/outbox`

Preferred multi-host distribution path:

- `dictation-sync` uploads canonical markdown artifacts to MinIO
- preferred bucket name: `dictation-artifacts`
- preferred object key layout: `canonical/YYYY/MM/DD/<artifact_id>.md`

If moving files is operationally awkward on the producer host, an acceptable v1 alternative is:

- keep files in place
- maintain a local importer sync log with status and timestamps

But the status must be explicit and observable. Silent best-effort behavior is not acceptable.

## Architecture

### Producer

Existing validated local dictation stack on the M3 Ultra:

- WhisperKit for transcription
- local Qwen cleanup model with thinking disabled
- markdown output to outbox
- producer service name `dictation`
- producer local API available at `127.0.0.1:8888`
- producer also accepts authenticated remote submission via Traefik at `https://dictation.lincoln.luchoh.net`
- producer port `8888`
- Consul registration is live

Producer responsibility ends at publishing the canonical artifact.

OB1 should not be embedded into the producer process.

### Distributor

Preferred multi-host distributor:

- `dictation-sync`

Distributor responsibilities:

- watch the canonical outbox
- upload byte-identical markdown artifacts to MinIO
- retry failed uploads
- keep distribution state separate from the producer outbox

Distributor non-responsibilities:

- do not alter artifact contents
- do not push directly into OB1
- do not define consumer ingest behavior

### Importer

New component to build:

- one-shot importer for an artifact source
- optional continuous watch/poll mode
- source adapters for:
  - direct outbox filesystem access
  - MinIO object listing/fetch

This importer is effectively OB1's subscription/consumer layer for dictation artifacts, regardless of whether those artifacts are read directly from the outbox or from MinIO.

The importer should live in this repo as a recipe or small standalone pipeline, similar to:

- [recipes/email-history-import](/Users/luchoh/Dev/OB1/recipes/email-history-import/README.md#L1)
- [recipes/document-import](/Users/luchoh/Dev/OB1/recipes/document-import/README.md#L1)

### Ingest Target

Use the existing local OB1 ingest contract:

- `POST /ingest/thought` on the local runtime
- access-key protected
- embeddings created by the existing local path
- metadata extraction optional on source rows, enabled for distilled rows only when needed

### Reuse Constraint

The dictation service should remain independently useful even if OB1 is down or absent.

That means:

- dictation still writes valid artifacts when no consumer is running
- OB1 can catch up later by replaying either:
  - the canonical outbox
  - or the distributed object store
- a second consumer can be added later without changing the producer contract

### Submission vs Distribution

Remote submission does not change the consumer model.

- Traefik and Consul make `dictation` reachable for authenticated submission from other hosts
- they do not distribute artifacts to consumers automatically
- OB1 still consumes artifacts through a separate consumer path

### Preferred Multi-Host Topology

For hosts that do not share direct access to the producer filesystem, the preferred topology is:

`dictation -> canonical outbox -> dictation-sync -> MinIO -> OB1 importer`

Direct outbox watching remains the simple fallback for single-host or shared-filesystem setups.

## Rollout Phases

### Phase 1: One-Shot Import

Build a manual importer that:

- scans one artifact source
- parses notes
- ingests source rows
- distills thought rows
- records sync state

This phase proves the data contract and dedupe behavior.

### Phase 2: Watcher

Add continuous watch mode so new dictation notes are imported automatically.

This is the point where the product promise becomes true in daily use.

### Phase 3: MinIO Distribution Support

Add support for MinIO-backed artifact consumption so OB1 can ingest dictation without direct access to the producer host filesystem.

This phase should include:

- MinIO source adapter
- object-key to artifact identity handling
- byte-for-byte fetch of canonical markdown artifacts
- importer state that does not depend on local filenames only

### Phase 4: Managed Service

Run the importer under service management on a host that can read the chosen artifact source:

- direct mode: mounted/local access to the canonical outbox
- distributed mode: network access to MinIO

This phase should include:

- startup env contract
- logs
- restart policy
- health signaling

### Phase 5: Optional Long-Form Distillation

For long or multi-topic dictations, optionally route the source note through a richer evaluation flow later.

Probable future direction:

- integrate with [recipes/panning-for-gold](/Users/luchoh/Dev/OB1/recipes/panning-for-gold/README.md#L1)

This is explicitly out of scope for v1.

## Acceptance Criteria

The PRD is considered implemented when all of the following are true:

1. A new canonical dictation artifact is imported into OB1 automatically from at least one supported source path.
2. The importer creates:
   - one `dictation_note` source row
   - zero to three `dictation_thought` distilled rows
3. Reprocessing the same file does not create duplicates.
4. `search_thoughts` can find the dictation content.
5. `ask_brain` can answer a question grounded in the dictation memory and cite the distilled row.
6. A malformed file does not disappear silently.
7. Failure/retry state is observable.
8. The path remains private-network-only at runtime.
9. The importer accepts the live `dictation` artifact contract, including `artifact_id`, `cleanup_mode`, and `null` semantics.
10. In MinIO mode, OB1 can ingest the same canonical artifact content without direct access to M3's local filesystem.

## Risks

### Risk 1: Weak File Contract

If the producer output schema is not stable, the importer becomes fragile.

Mitigation:

- define the frontmatter contract now
- reject malformed files explicitly

### Risk 2: Overstoring Raw Transcript in Metadata

Raw transcripts may become large.

Mitigation:

- keep v1 simple and local-first
- monitor row size and importer behavior
- move raw transcript to object/file storage later only if needed

### Risk 2b: Legacy Hash Mismatch On Older Artifacts

Older producer artifacts created before the final hash fix may have a stale `cleaned_text_hash`.

Mitigation:

- recompute the body hash locally on import
- treat older mismatches as legacy artifacts, not as proof of corruption
- use `artifact_id` and `audio_sha256` when present as stronger identity anchors

### Risk 3: Distillation Overreach

Voice notes can be messy, partial, or speculative.

Mitigation:

- preserve source row separately
- keep derived rows grounded and concise
- rely on the existing grounded answer path to avoid false certainty

### Risk 4: Service Coupling

If the importer is tightly coupled to the dictation service process, failures become harder to isolate.

Mitigation:

- keep the outbox seam
- make the importer independently restartable

### Risk 5: Divergence Between Outbox And Distributed Copy

If `dictation-sync` mutates artifacts or consumers start trusting object metadata over markdown contents, the system can drift.

Mitigation:

- treat the markdown bytes as canonical
- keep object metadata advisory only
- verify byte-for-byte identity where practical

## Explicit Rejections

### Direct synchronous push from dictation service to OB1

Rejected for v1.

Reason:

- it removes replay and auditability
- it couples speech capture to OB1 availability
- it makes operational failures harder to inspect

### Treat cleaned dictation note as already-distilled final memory

Rejected for v1.

Reason:

- the cleaned note is still source material
- OB1 should preserve source and derived rows separately
- this is the same pattern already validated for email and document ingest

## Recommended Next Implementation Step

Build a new recipe:

- `recipes/dictation-import/`

It should include:

- `import-dictation.py` or equivalent
- one-shot mode
- watch mode
- stable sync log
- README with env contract

That is the shortest path from validated dictation rollout to actual OB1 memory.
