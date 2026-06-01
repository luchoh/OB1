# PRD: OB1 Document Folder Feed

Date: 2026-04-15
Status: Implemented on feature branch
Owner: Runtime / Ingest / Knowledge Capture

## Summary

Add a simple local workflow where a folder of external documents feeds OB1.

The intended direction is:

- local files and folders
- Docling conversion into a durable local extraction bundle
- normalized Markdown materialized locally for inspection and reuse
- OB1 ingest from the saved extraction bundle, not by re-parsing Markdown
- OB1 source rows and optional distilled summaries created from Docling chunks
- PostgreSQL + `pgvector` remain canonical

This is explicitly not:

- OB1 exported into markdown
- markdown as a replacement database
- markdown as the only source of ingest truth
- a wiki-first memory architecture

## Problem

OB1 already has a working document importer, but the operator surface is still too low-level for repeated folder ingestion.

Today the repo can ingest documents through:

- [recipes/document-import/import-documents.py](/Users/luchoh/Dev/OB1/recipes/document-import/import-documents.py)
- the live Docling service
- the local OB1 ingest endpoint

That works, but it leaves gaps for the real operator workflow:

- importing a whole folder repeatedly
- skipping unchanged files on reruns
- having a stable local state artifact for batch ingest
- retaining normalized Markdown locally in a predictable tree
- retaining Docling extraction JSON locally so ingest can be reproduced without losing chunk metadata
- using a repo-level entrypoint instead of dropping into the recipe directory every time

## Goals

- Make folder-fed document ingest the normal operator flow.
- Keep external documents outside OB1 until ingest time.
- Always materialize normalized Markdown locally as a durable sidecar artifact.
- Retain the Docling extraction bundle that produced the Markdown and OB1 rows.
- Preserve OB1 as the canonical searchable store after ingest.
- Skip unchanged files on repeat runs before they hit Docling and OB1 again.
- Keep original-file retention optional.
- Keep the workflow local-first and compatible with the current managed local stack.

## Non-Goals

- Exporting OB1 into markdown
- Replacing PostgreSQL or `pgvector`
- Building a markdown wiki layer
- Treating edited Markdown as canonical without an explicit re-extraction/re-ingest decision
- Ingesting sidecar manifests, state files, or rescue artifacts as document content
- Automatic filesystem watching or daemonization in v1
- Automatic promotion of arbitrary local files without an explicit import command

## Product Shape

The intended operator flow is:

1. Put documents in a local folder.
2. Run a repo-level import command against that folder.
3. Convert and chunk each file through Docling.
4. Write a local extraction bundle for each source document.
5. Materialize normalized Markdown from the same extraction bundle.
6. Ingest chunks into OB1 from the saved extraction bundle.
7. Optionally ingest 0-3 whole-document distilled summary thoughts.
8. Record local import state so unchanged files can be skipped on the next run.

The sidecar corpus is durable and inspectable, but it is not the canonical memory store.
OB1 remains canonical after ingest.

Recommended sidecar layout:

- `content/` for normalized Markdown intended for humans and downstream tools
- `artifacts/` for Docling raw payloads, chunks, quality signals, and per-document metadata
- `state/` for manifests, failures, skip-state, rescue logs, and run reports

When an already-imported source path later has different bytes, the new sidecar artifacts use a hash suffix rather than overwriting the previous extraction bundle.

## Functional Requirements

### FR1: Repo-Level Entry Point

The repo must expose a normal operator script for document folder ingest.

The v1 entry point is:

- [import-open-brain-documents.sh](/Users/luchoh/Dev/OB1/scripts/import-open-brain-documents.sh)

It must:

- run from the repo root
- load `.env.open-brain-local` when present
- prefer the recipe virtualenv when available
- default to a local state file under runtime artifacts

### FR2: Folder Inputs

The importer must accept:

- one file
- multiple files
- one directory
- multiple directories
- recursive directory traversal when requested

### FR3: Stateful Reruns

The importer must support a local JSON state file that records per-file import results.

The state file is operator state only.
It is not canonical memory.

Minimum tracked fields:

- absolute resolved path
- filename
- document content hash
- file size
- file mtime
- status
- chunk count
- summary count
- error when the last run failed
- state update timestamp

### FR4: Skip Unchanged

When `--skip-unchanged` is enabled with a state file, the importer must skip a file when:

- the previous recorded status is `success`
- the current content hash matches the recorded content hash

Skipping must happen before Docling conversion.

### FR5: Canonical Ingest Direction

Imported documents must feed OB1 as:

- `document_chunk` source rows
- optional `document_summary` distilled rows

OB1 remains canonical after ingest.

### FR6: Idempotent Reprocessing

Even when a file is processed more than once, ingest must remain idempotent via stable dedupe keys derived from:

- document content hash
- chunk index or summary index

### FR7: Durable Local Extraction Bundle

For every successfully converted source document, the importer must write a local extraction bundle.

Minimum bundle fields:

- source path
- source filename
- source SHA256
- source MIME type
- source size and mtime
- normalized Markdown path
- normalized Markdown SHA256
- Docling raw/chunk artifact path
- Docling chunk count
- Docling chunker
- Docling pipeline used
- fallback status and quality signals
- extraction timestamp

The normalized Markdown is a review and interoperability artifact.
The Docling extraction JSON is the reproducible ingest artifact.

### FR8: Ingest From Saved Extraction Bundle

OB1 ingest must use the saved extraction bundle as the ingest input.

It must not depend on re-parsing normalized Markdown when Docling chunk metadata is available.

The ingest step must preserve:

- page numbers
- headings
- Docling doc item references
- extractor metadata
- extraction quality signals
- source and normalized artifact hashes

### FR9: Sidecar Ignore And Allowlist Rules

The importer must distinguish source inputs, normalized content, extraction artifacts, and operator state.

It must not accidentally ingest:

- manifests
- JSON sidecars
- run logs
- failed-file lists
- rescue metadata
- generated state files

When ingesting from a sidecar tree, content discovery must be based on an explicit allowlist or manifest, not a blind recursive walk.

### FR10: Object Store Retention Optional

Original files and converted markdown may be retained in MinIO when explicitly enabled.

This must remain optional and off by default.

## V1 Implementation

V1 is implemented as:

- importer state support in [import-documents.py](/Users/luchoh/Dev/OB1/recipes/document-import/import-documents.py)
- repo-level wrapper in [import-open-brain-documents.sh](/Users/luchoh/Dev/OB1/scripts/import-open-brain-documents.sh)
- updated recipe and operator docs

The extraction bundle slice adds:

- local sidecar artifact root
- normalized Markdown under `content/`
- Docling extraction JSON under `artifacts/`
- manifest-driven ingest from saved extraction bundles
- ignore rules for state and bookkeeping files

V1 does not include:

- live directory watching
- background queues
- a UI
- promotion review workflows

## CLI Contract

Low-level importer:

- `python import-documents.py PATH...`
- supports `--state-file`
- supports `--skip-unchanged` / `--no-skip-unchanged`
- supports `--artifact-root DIR`
- supports `--materialize-markdown` / `--no-materialize-markdown`
- supports `--ingest-from-bundle`

Repo-level wrapper:

- `./scripts/import-open-brain-documents.sh PATH...`

Wrapper defaults:

- state file: `local/open-brain-mcp/.runtime/document-import-state.json`
- artifact root: `local/open-brain-mcp/.runtime/document-import-artifacts`
- skip unchanged: enabled

## Security Constraints

- Do not upload documents anywhere except approved local services.
- Do not invent metadata, summaries, or fallback ingest values.
- Do not make markdown or filesystem artifacts canonical.
- Do not use edited Markdown as implicit ground truth for OB1 ingest.
- Do not ingest generated manifests or state files as source documents.
- Treat the state file as disposable operator state only.
- Keep original-document retention explicit, not implicit.
- Keep local sidecar artifacts inside a configured artifact root unless the operator passes an explicit path.

## Verification

Minimum verification for this slice:

- importer still syntax-checks
- state file round-trip works
- skip-unchanged logic only skips prior successful identical hashes
- normalized Markdown is written under `content/`
- extraction JSON is written under `artifacts/`
- OB1 ingest rows preserve source and normalized artifact hashes
- blind recursive import does not ingest manifests, JSON sidecars, or state files
- wrapper shell syntax is valid

Live verification remains environment-dependent because it needs:

- a passing Docling service
- the local OB1 ingest endpoint
- valid ingest auth

## Rollout

### Phase 1

- stateful folder importer
- repo-level wrapper
- docs aligned to folder-fed ingest

### Phase 2

- local extraction bundle sidecar
- normalized Markdown materialization
- manifest-driven ingest from saved extraction bundles
- report output for large imports
- clearer per-file summary of skipped/imported/failed files

### Phase 3

- optional watched-folder service, only if explicitly needed later

## Recommendation

Keep the architecture simple:

- folders and files are the external source
- Docling is the conversion step
- Markdown is the durable human-readable sidecar
- Docling extraction JSON is the durable ingest sidecar
- OB1 is the canonical memory system

Do not collapse OB1 into a markdown-based workspace.
