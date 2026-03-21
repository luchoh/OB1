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
  - `graph_neighbors`
  - `source_lineage`
  - `why_connected`
  - `expand_context`

## Prerequisites

- Node.js 20+
- PostgreSQL reachable with the `ob1` database
- `pgvector` enabled in that database
- `ob1-embedding` healthy at `EMBEDDING_BASE_URL`
- `mlx-server` healthy at `LLM_BASE_URL`
- optional local `neo4j` / `neo4j-enterprise` graph service
- `.env.open-brain-local` populated from [`.env.open-brain-local.example`](/Users/luchoh/Dev/OB1/.env.open-brain-local.example)

## Install

```bash
direnv allow
devenv shell
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
devenv up open_brain_local
```

Default bind:

- `http://localhost:8787/`
- `http://localhost:8787/health`
- `http://localhost:8787/mcp`
- `http://localhost:8787/ingest/thought`
- `http://localhost:8787/ask`
- `http://localhost:8787/admin/thought/metadata`
- `http://localhost:8787/graph/neighbors`
- `http://localhost:8787/graph/source-lineage`
- `http://localhost:8787/graph/why-connected`
- `http://localhost:8787/graph/expand-context`

If you need a one-shot non-`devenv` launch and the user explicitly asks for it, the wrapper is still:

```bash
./scripts/run-open-brain-local.sh
```
- `http://localhost:8787/admin/thought/metadata`

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

## Graph Projection

Phase-1 Neo4j integration is provenance-first:

- PostgreSQL stays canonical
- Neo4j is a derived projection
- writes do not block on graph updates
- a background projector can sync rows asynchronously when graph support is enabled

Enable graph integration with the Neo4j env block in [`.env.open-brain-local.example`](/Users/luchoh/Dev/OB1/.env.open-brain-local.example).
When explicit service URLs or `NEO4J_URI` are set, they override Consul discovery and Consul only fills missing values.

Manual projection:

```bash
OPEN_BRAIN_GRAPH_ENABLED=true \
NEO4J_URI=bolt://localhost:7687 \
./scripts/project-open-brain-graph.sh --database ob1-graph-stage --all --verbose
```

The runtime also exposes:

- `POST /graph/neighbors`
- `POST /graph/source-lineage`
- `POST /graph/why-connected`
- `POST /graph/expand-context`

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
  "match_count": 6,
  "graph_assisted": true,
  "graph_max_hops": 2,
  "graph_neighbor_limit": 6
}
```

`graph_assisted=true` keeps PostgreSQL vector search as the seed retrieval step and then expands the evidence set with related `Thought` rows from Neo4j before grounded answer synthesis.

`ask_brain` also uses deterministic question-intent detection for preference/decision, comparison, and unresolved-status questions. When claim metadata is present on evidence rows, it is used only as a ranking and synthesis hint; the original text and citations remain the truth anchor.

## Metadata-Only Admin Update

The metadata backfill route is:

```bash
POST /admin/thought/metadata
```

Request body:

```json
{
  "thought_id": "00000000-0000-0000-0000-000000000000",
  "metadata_patch": {
    "user_metadata": {
      "claim_kind": "decision",
      "epistemic_status": "decided"
    }
  }
}
```

This route merges metadata without changing:
- `content`
- `embedding`
- `embedding_model`
- `embedding_dimension`

It exists specifically for metadata-only backfills such as claim typing.

## Graph A/B Eval

To compare vector-only versus graph-assisted answering on a fixed question set:

```bash
node scripts/eval-open-brain-ask-ab.mjs \
  --base-url http://localhost:8787 \
  --output /tmp/ob1-ask-graph-ab.json
```

Default cases live in [ask-brain-graph-ab-cases.json](/Users/luchoh/Dev/OB1/local/open-brain-mcp/evals/ask-brain-graph-ab-cases.json).

## Graph Read APIs

The graph layer now exposes four read-only inspection surfaces:

- `graph_neighbors`
- `source_lineage`
- `why_connected`
- `expand_context`

`why_connected` explains the shortest path between two thoughts or graph nodes.

`expand_context` returns graph-related `Thought` rows from a seed thought using the same graph ranking policy used by graph-assisted retrieval, but without invoking answer synthesis.

## Notes

- The service loads the repo root `.env` first and then `.env.open-brain-local` so app-specific values win.
- `LLM_ENABLE_THINKING=false` is the intended default for structured local LLM calls.
- Structured extraction uses Qwen tool calling rather than `response_format`.
- The canonical embedding contract is `1536` dimensions, owned by `ob1-embedding`.
- Importers should supply `dedupe_key` for idempotent writes when identical text can appear in different sources.
- Importers can set `extract_metadata=false` when they already have structured metadata and only need embeddings plus storage.
- By default, `search_thoughts` prefers distilled memory rows and falls back to raw source rows. Callers can still force raw/source searches with an explicit metadata filter.
- `ask_brain` uses the same retrieval path, then forces a grounded answer with explicit citations or an insufficient-evidence response.
- when `OPEN_BRAIN_GRAPH_ENABLED=true`, the runtime can project provenance into Neo4j and expose read-only graph inspection tools
- The schema migration is idempotent at the SQL object level, and the migration runner records applied filenames in `open_brain_schema_migrations`.
- The real runtime env file is `.env.open-brain-local` and should remain untracked.
- Managed-service handoff details are in [docs/09-open-brain-local-service-handoff.md](/Users/luchoh/Dev/OB1/docs/09-open-brain-local-service-handoff.md#L1).
