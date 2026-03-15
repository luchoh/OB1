# Open Brain Local MCP

This is the runnable local core service for the Open Brain Local design.

## What It Does

- exposes a local MCP endpoint at `/mcp`
- authenticates with the same access key model used elsewhere in the repo
- writes and reads directly from PostgreSQL
- calls the local embedding and inference services on the LAN
- provides the four core tools:
  - `capture_thought`
  - `search_thoughts`
  - `list_thoughts`
  - `stats`
  - `ask_brain`

## Prerequisites

- Node.js 20+
- PostgreSQL reachable with the `ob1` database
- `pgvector` enabled in that database
- `ob1-embedding` healthy at `EMBEDDING_BASE_URL`
- `mlx-server` healthy at `LLM_BASE_URL`
- `.env.open-brain-local` populated from [`.env.open-brain-local.example`](/Users/luchoh/Dev/OB1/.env.open-brain-local.example)

## Install

```bash
cd local/open-brain-mcp
npm install
```

## Apply Migrations

From the repo root:

```bash
./scripts/apply-open-brain-local-migrations.sh
```

This applies the SQL files in [`local/open-brain-mcp/migrations`](/Users/luchoh/Dev/OB1/local/open-brain-mcp/migrations).

## Run

```bash
./scripts/run-open-brain-local.sh
```

Default bind:

- `http://localhost:8787/`
- `http://localhost:8787/health`
- `http://localhost:8787/mcp`
- `http://localhost:8787/ingest/thought`
- `http://localhost:8787/ask`

## Smoke Test

From the repo root:

```bash
./scripts/smoke-open-brain-local-mcp.sh
```

This verifies:
- upstream model services and PostgreSQL
- local migrations
- local MCP server boot
- MCP tool calls for capture, search, list, stats, and grounded answering

## Auth

The MCP and ingest endpoints accept:

- `?key=$MCP_ACCESS_KEY`
- `x-access-key: $MCP_ACCESS_KEY`
- `x-brain-key: $MCP_ACCESS_KEY`

## HTTP Ingest

The importer-friendly ingest route is:

```bash
POST /ingest/thought
```

Request body:

```json
{
  "content": "A thought to store",
  "metadata": {"source": "chatgpt"},
  "source": "chatgpt",
  "type": "chatgpt_conversation",
  "tags": ["chatgpt", "import"],
  "occurred_at": "2026-03-14",
  "dedupe_key": "chatgpt:1234:thought:0",
  "extract_metadata": false
}
```

## HTTP Grounded Answer

The grounded answer route is:

```bash
POST /ask
```

Request body:

```json
{
  "question": "What units and how large is the apartment on Rayko Aleksiev?",
  "match_threshold": 0.4,
  "match_count": 6
}
```

## Notes

- The service loads the repo root `.env` first and then `.env.open-brain-local` so app-specific values win.
- `LLM_ENABLE_THINKING=false` is the intended default for structured local LLM calls.
- Structured extraction uses Qwen tool calling rather than `response_format`.
- The canonical embedding contract is `1536` dimensions, owned by `ob1-embedding`.
- Importers should supply `dedupe_key` for idempotent writes when identical text can appear in different sources.
- Importers can set `extract_metadata=false` when they already have structured metadata and only need embeddings plus storage.
- By default, `search_thoughts` prefers distilled memory rows and falls back to raw source rows. Callers can still force raw/source searches with an explicit metadata filter.
- `ask_brain` uses the same retrieval path, then forces a grounded answer with explicit citations or an insufficient-evidence response.
- The schema migration is idempotent at the SQL object level, and the migration runner records applied filenames in `open_brain_schema_migrations`.
- The real runtime env file is `.env.open-brain-local` and should remain untracked.
- Managed-service handoff details are in [docs/09-open-brain-local-service-handoff.md](/Users/luchoh/Dev/OB1/docs/09-open-brain-local-service-handoff.md#L1).
