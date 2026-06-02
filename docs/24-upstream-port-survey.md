# Upstream Port Survey: schemas/ and recipes/

Date: 2026-06-01
Status: Research; no porting decisions made
Owner: Retrieval / Knowledge Layer

Companion to: PRD `25-upstream-port-roadmap.md` (port plan and checklists)

## Why this document exists

This fork (`luchoh/OB1`, branch `master`) has fallen 364 commits behind upstream
(`NateBJones-Projects/OB1`, branch `main`). Upstream has invested heavily in
Supabase / Vercel / Edge-Function infrastructure that we cannot adopt — our
runtime is local Postgres + pgvector + DeepSeek-V4-Flash-nvfp4 (via mlx-server)
+ Qwen3-Embedding-8B-mxfp8, with FastAPI/Python ingest and a Node.js MCP
server. A whole-tree merge is not viable.

Instead, we surveyed every upstream `schemas/*` and platform-agnostic
`recipes/*` to identify what can be ported and at what cost. This document is
the raw evidence and triage from that survey, so future port decisions can be
made without re-reading upstream code from scratch.

The survey was produced by a parallel fan-out of 30 sub-agents (8 schemas,
22 recipes), each reading the relevant `README.md`, `metadata.json`, and main
script/SQL from `main` (which is fast-forwarded to `upstream/main`).
Cost: ~$5 in tokens; results captured below verbatim.

## Triage summary

Tier numbering matches the recommended adoption order in PRD-25.

### Tier 1 — Buy now (high value, low effort, no platform coupling)

| Item | Type | Effort | Value | One-line purpose |
|---|---|---|---|---|
| `schemas/workflow-status` | schema | trivial | high | Adds `status` + `status_updated_at` columns and a partial index for kanban-style task/idea workflow on `thoughts`. |
| `recipes/live-retrieval` | recipe | trivial | high | Pure Claude Code SKILL.md — auto-surfaces thoughts on topic shifts via existing MCP search/list tools. |
| `schemas/recency-boosted-match-thoughts` | schema | small | high | New `match_thoughts_recency` SQL function blending cosine similarity with exp time-decay. |

### Tier 2 — Buy soon (high value, manageable effort)

| Item | Type | Effort | Value | One-line purpose |
|---|---|---|---|---|
| `schemas/thought-audit` | schema | small | high | Append-only audit log of capture/update/delete on thoughts. Multi-writer accountability. |
| `recipes/weekly-digest` | recipe | small | high | Weekly Wins/Decisions/Open-loops digest from recent thoughts; LLM-driven; Telegram or stdout. |
| `recipes/thought-enrichment` + `recipes/source-filtering` | recipe | medium | high | Battle-tested LLM-driven backfill (type/topics/people/sentiment/importance + sensitivity tagging + state checkpointing). Solves our type-column NULL problem. |
| `schemas/provenance-chains` + `recipes/provenance-chains` | schema+recipe | small+medium | high | `derived_from` columns + `trace_provenance`/`find_derivatives` recursive walker. "Show me the atoms behind this digest." |
| `recipes/obsidian-vault-import` | recipe | small | high (conditional) | Obsidian vault parser with frontmatter, wikilinks, multi-strategy chunking. **Only valuable if we actually have an Obsidian vault.** |

### Tier 3 — Strategic (knowledge graph stack — multi-week commitment)

These pair into one capability: a typed knowledge graph layered on top of
thoughts. None deliver value alone; together they are the most architecturally
significant addition upstream offers.

| Item | Type | Effort | Value | Role |
|---|---|---|---|---|
| `schemas/entity-extraction` | schema | small | high | 5 tables: entities, edges, thought_entities, queue, consolidation_log + auto-queue trigger. |
| Python entity-extraction worker | new code | medium | high | Replaces upstream's Supabase Edge Function `integrations/entity-extraction-worker`. Calls DeepSeek to extract entities from queued thoughts. |
| `schemas/typed-reasoning-edges` | schema | small | high | `thought_edges` table with typed relations (supports/contradicts/evolved_into/supersedes/depends_on/related_to) + temporal validity. |
| `recipes/typed-edge-classifier` | recipe | medium | medium | Hybrid (today: Haiku + Opus) classifier walking candidate thought pairs. **Loses point of hybrid tiering on local DeepSeek-only stack — strip to single-model.** |
| `recipes/entity-wiki` | recipe | medium | high | Auto-generates per-entity markdown wiki pages by aggregating linked thoughts. Single-call LLM synthesis with thought-id citations. |
| `recipes/wiki-synthesis` (autobiography mode) | recipe | medium | medium | Year-bucketed autobiography from corpus. Email-thread mode requires Gmail importer; defer. |

### Tier 4 — Conditional buy (only if specific feature needed)

| Item | Type | Effort | Value | Trigger |
|---|---|---|---|---|
| `recipes/atomizer` (workflow A only) | recipe | small | high | If we ingest "memory packs" or long compound bodies. Workflow B (Gmail) needs entity graph first. |
| `schemas/agent-memory` | schema | small | high | If we start letting agents (Claude Code, Codex, etc.) write to the brain. Today they don't. |
| `recipes/editorial-policy` | recipe | medium | high | Synthesis drift / contradiction auditor. Policy doc reusable IP regardless. Useful but not urgent. |
| `schemas/readwise-books` | schema | small | medium | If we adopt Readwise importer. |

### Tier 5 — Skip

| Item | Why skip |
|---|---|
| `recipes/lint-sweep` | Heavily Supabase-wired; lift `views.sql` only, skip the Node harness. |
| `recipes/brain-smoke-test` | Supabase-shaped end-to-end harness; nearly full rewrite for our stack. Build our own when needed. |
| `recipes/wiki-compiler` | Thin wrapper around 4 other recipes; replace with 30-line shell script when those land. |
| `schemas/content-fingerprint-dedup` + `recipes/fingerprint-dedup-backfill` | We already have `content_hash` + `dedupe_key`. Steal the normalization regex only. |
| `recipes/repo-learning-coach` | Separate React+Express study app, 10 new tables, niche feature. |
| `recipes/local-ollama-embeddings` | Duplicates our existing Qwen3 embedding path. |
| `recipes/world-model-diagnostic-activation` | B2B consulting interview workflow; not personal-brain. |
| `recipes/work-operating-model-activation` | Sidecar tables for "USER.md/SOUL.md" exports; niche use case. |
| `recipes/research-to-decision-workflow` | VC/operator memo bundling. Not relevant to our domain. |
| `recipes/schema-aware-routing` | ~700-line net rewrite for low-tenancy benefit; crib the routing pattern instead. |

## Universal porting friction

Every Supabase-coupled item needs the same five fixes. Document once here so the
PRD checklists can reference instead of repeating:

1. **Strip Supabase role grants.** `GRANT ... TO authenticated, anon, service_role`
   and `REVOKE ... FROM authenticated, anon` — replace with our app role
   (`ob1`) or omit (table owner already has rights).
2. **Strip RLS.** `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` plus any
   `CREATE POLICY ... USING (auth.uid() = ...)` blocks. We don't run RLS;
   tenancy is enforced in the app layer via `brain_id`.
3. **Strip PostgREST notify.** `NOTIFY pgrst, 'reload schema';` — no-op for us.
4. **Replace PostgREST data access.** Recipe scripts call
   `${SUPABASE_URL}/rest/v1/<table>` with `apikey` + `Authorization: Bearer
   ${SERVICE_ROLE_KEY}`. Replace with direct PG (psycopg/asyncpg) or wire into
   our existing FastAPI ingest path.
5. **Add `brain_id` filtering.** Upstream is single-tenant; every SELECT,
   UPDATE, INSERT, RPC signature must accept and filter by `brain_id` or
   we leak across tenants.

LLM-call substitution is similarly uniform:

- **OpenRouter / Anthropic / OpenAI direct → mlx-server.** Endpoint is
  OpenAI-compatible: change base URL to `https://mlx.lincoln.luchoh.net/v1`,
  change model name to `DeepSeek-V4-Flash-nvfp4`, drop OpenRouter-specific
  `HTTP-Referer` / `X-Title` headers and Anthropic-specific `anthropic-version`
  / `x-api-key` headers. The JSON-mode / tool-use prompt pattern transfers.
- **OpenAI embeddings → Qwen3-Embedding-8B-mxfp8.** Endpoint
  `https://ob1-embedding.lincoln.luchoh.net/v1`, dim 1536. Match our existing
  `embedding_model` / `embedding_dimension` columns.
- **Hybrid Haiku-filter / Opus-classify patterns** lose their point on a
  single-model stack — collapse to single-model unless we add a smaller
  companion model.

## Per-item evidence

Each entry below is the raw assessment from the survey, preserved so we don't
re-investigate. Each notes the item's platform coupling (none/supabase/vercel/
openai-only/edge-function/mixed), effort to port (trivial/small/medium/large),
value for our local stack (low/medium/high), and concrete blockers.

### Schemas

#### `schemas/agent-memory`

- **Purpose:** Sidecar Postgres schema (8 tables) that adds governed agent
  memory on top of `thoughts`, with provenance, review workflow,
  instruction-vs-evidence use policy, recall traces, and audit events.
- **Coupling:** supabase. **Effort:** small. **Value:** high.
- **Dependencies:** core thoughts table; companion `integrations/agent-memory-api`
  (Edge Function — needs FastAPI rewrite).
- **Notes:** Schema body is plain Postgres. Strip 8 RLS/POLICY blocks, drop
  service_role grants, drop NOTIFY pgrst. Real schema-level mismatch is
  `workspace_id TEXT` vs our `brain_id UUID` — rename in 4 scoped tables and
  their indexes; same for `project_id` if we want it as UUID. `thought_id` FK
  to `public.thoughts(id)` drops in cleanly. No embedding column on
  `agent_memories` — design assumes recall reuses `thoughts.embedding` via
  `thought_id`. The governance model (`provenance_status`,
  `can_use_as_instruction` guarded by CHECK, `review_status` state machine,
  `recall_traces.used/ignored_reason`, `audit_events`) is exactly the trust
  layer needed before letting agents write to the brain.

#### `schemas/entity-extraction`

- **Purpose:** Adds 5 tables (entities, edges, thought_entities,
  entity_extraction_queue, consolidation_log) plus an auto-queue trigger so an
  external worker can extract entities/relationships from thoughts asynchronously.
- **Coupling:** supabase. **Effort:** small. **Value:** high.
- **Dependencies:** thoughts table with `content_fingerprint` column;
  `schemas/enhanced-thoughts` (recommended); `integrations/entity-extraction-worker`
  (the actual extractor — required to make the queue do anything).
- **Notes:** (1) Hard prerequisite on `thoughts.content_fingerprint` — we have
  `content_hash` instead; either add the column or rewrite the trigger to use
  `content_hash`. (2) Strip RLS/role grants/NOTIFY pgrst. (3) Add `brain_id`
  to entities/edges/thought_entities/queue and tighten unique constraints
  (e.g., `UNIQUE(brain_id, entity_type, normalized_name)`). (4) The trigger
  `SECURITY DEFINER` pattern is fine. The model — typed entities + evidence-
  bearing thought-entity links + confidence + async queue — is better-shaped
  than our current `ob-graph` 2-table approach.

#### `schemas/provenance-chains`

- **Purpose:** Adds `derived_from`/`derivation_method`/`derivation_layer`/
  `supersedes` columns plus four SQL helper functions on `public.thoughts` so
  derived/synthesized thoughts can cite their source atoms, and provenance/eval
  metadata can be merged race-free server-side.
- **Coupling:** supabase. **Effort:** small. **Value:** high.
- **Dependencies:** `recipes/provenance-chains` for the operational layer.
- **Notes:** Pure Postgres migration; only platform coupling is Supabase role
  grants and `NOTIFY pgrst`. After porting: (1) our `thoughts` table promotes
  `type`, `source_type`, `sensitivity_tier` to top-level columns, so swap
  `metadata->>'…'` reads inside `trace_provenance` and `find_derivatives` for
  direct column reads. (2) Add `brain_id` parameter to both helpers — as
  written they walk across tenants. (3) `id` is UUID — matches us. (4) GIN
  index on `derived_from` and recursive CTE walker are correctly shaped.
  `merge_thought_eval_metadata` only useful if we also port the eval recipe.

#### `schemas/recency-boosted-match-thoughts`

- **Purpose:** New `match_thoughts_recency` SQL function blending cosine
  similarity with `exp(-age_days/half_life_days)`; opt-in (recency_weight=0
  reproduces base behavior).
- **Coupling:** none. **Effort:** small. **Value:** high.
- **Dependencies:** thoughts table; pgvector; core `match_thoughts` (referenced
  but not called).
- **Notes:** Pure plpgsql + pgvector. Edits needed: (1) signature is hardcoded
  to `vector(1536)` — matches our embedding (Qwen3-Embedding-8B-mxfp8 emits
  1536), so no change. (2) Add `brain_id uuid` parameter and `WHERE t.brain_id
  = brain_id` predicate. (3) Filter by `embedding_model`/`embedding_dimension`
  to avoid mixing heterogeneous vectors. (4) Widen returned columns to include
  `type`, `source_type`, `importance`, `quality_score` so callers don't need a
  second query. (Survey notes 4096 dim — that's wrong; we run 1536 per
  `001_ob1_core.sql` and our embedding service confirms.)

#### `schemas/thought-audit`

- **Purpose:** Append-only audit table logging capture/update/delete on
  thoughts plus an `author_session_id` metadata convention for multi-writer
  provenance.
- **Coupling:** supabase. **Effort:** small. **Value:** high.
- **Dependencies:** thoughts table; optional `integrations/update-thought-mcp`,
  `integrations/delete-thought-mcp`.
- **Notes:** Vanilla Postgres (UUID PK, JSONB diff, three indexes, CHECK
  constraint). Drop RLS line and `GRANT ... TO service_role`. Add `brain_id
  UUID NOT NULL` and an index on `(brain_id, created_at DESC)`. Caller-side
  wiring is Supabase JS examples — replace with SQLAlchemy/asyncpg in the
  FastAPI capture path and a Node `pg` call in the MCP server. We already
  have multi-writer traffic (Claude Desktop, Codex, ChatGPT, ingest workers)
  with no provenance trail.

#### `schemas/typed-reasoning-edges`

- **Purpose:** `thought_edges` table for typed semantic relations between
  thoughts (supports/contradicts/evolved_into/supersedes/depends_on/related_to)
  plus temporal validity columns (valid_from/valid_until/decay_weight) on the
  existing entity edges table.
- **Coupling:** supabase. **Effort:** small. **Value:** high.
- **Dependencies:** `entity-extraction`; `typed-edge-classifier`.
- **Notes:** Drop `ALTER TABLE ... ENABLE RLS`, service_role policy/grants,
  REVOKE FROM authenticated/anon, NOTIFY pgrst. Replace `POST /rpc/thought_edges_upsert`
  with direct SQL call from FastAPI/Node MCP — function body is pure plpgsql.
  Two real porting issues: (1) verify `thoughts.id` is UUID (matches us). (2)
  No `brain_id` column on `thought_edges` — add one with a CHECK that both
  endpoints share the same brain, or rely on FK-cascade-from-thoughts.
  Depends on `entity-extraction` schema (DO block hard-fails otherwise) — if
  we skip entity-extraction, strip section 5 (temporal columns on `edges`)
  and the prereq check.

#### `schemas/workflow-status`

- **Purpose:** Adds nullable `status` and `status_updated_at` columns plus a
  partial index to `thoughts` for kanban-style task/idea workflow tracking.
- **Coupling:** none. **Effort:** trivial. **Value:** high.
- **Dependencies:** thoughts table; `thoughts.type` column (or `metadata->>'type'`).
- **Notes:** Pure Postgres DDL; no Supabase/Edge/OpenRouter/Vercel/Neon
  coupling. One concrete change for our fork: backfill uses
  `metadata->>'type' IN ('task','idea')`, but we just added a top-level `type`
  column on `thoughts` (migration 006), so rewrite predicate to
  `WHERE type IN ('task','idea')` for correctness and index-friendliness.
  Multi-tenant-safe (column is on existing `thoughts`, brain_id untouched).

#### `schemas/readwise-books`

- **Purpose:** Side-table cache of Readwise book-level metadata (title, author,
  cover, category, num_highlights) keyed by Readwise user_book_id, plus two
  RPCs for in-order highlight retrieval and counter increment.
- **Coupling:** supabase. **Effort:** small. **Value:** medium.
- **Dependencies:** `schemas/enhanced-thoughts`; `integrations/readwise-capture`;
  `recipes/readwise-import`.
- **Notes:** Plain Postgres; no Supabase-only types. Drop role grants, drop
  NOTIFY pgrst. Add `brain_id UUID NOT NULL` and make PK composite
  `(brain_id, book_id)` since Readwise `user_book_id` is per-Readwise-user not
  globally unique across our tenants. `get_book_highlights` filters
  `source_type='readwise'` which works with our schema. The increment RPC is
  trivial; could just be inlined into Python ingest. Dead weight without the
  importer.

### Recipes

#### `recipes/lint-sweep`

- **Purpose:** Read-only weekly brain quality audit producing a markdown report
  with three cost tiers: SQL hygiene checks, graph isolation checks, and LLM
  contradiction sampling — never mutates thoughts.
- **Coupling:** mixed. **Effort:** medium. **Value:** high.
- **Dependencies:** `content-fingerprint-dedup`; `fingerprint-dedup-backfill`;
  `entity-extraction` schema; `thought-enrichment` (for tag-based orphan
  detection).
- **Notes:** (1) DB access via Supabase PostgREST — replace with direct PG; the
  `Content-Range` exact-count probe needs swapping for `SELECT count(*)`. (2)
  Tier 3 calls OpenRouter Haiku — swap to DeepSeek-V4-Flash. (3) No multi-
  tenancy — thread `--brain-id` through all SQL/PostgREST calls. (4) `views.sql`
  is clean ANSI Postgres and applies as-is, but needs brain_id-aware variants.
  No Edge/Vercel/Neon. The triage value is genuinely high
  (orphans/over-tagged/low-signal/long-content/duplicates), but the Node
  implementation gives nothing our stack doesn't already have. **Recommend:
  port `views.sql` first as brain_id-scoped views, write a thin Python script
  using existing FastAPI/asyncpg layer + DeepSeek endpoint.**

#### `recipes/brain-smoke-test`

- **Purpose:** Node CLI that runs ~28-32 read-only/destructive health checks
  across MCP, REST, DB schema, auth, RLS surfaces of an Open Brain install.
- **Coupling:** supabase. **Effort:** large. **Value:** medium.
- **Dependencies:** open-brain-mcp Edge Function; PostgREST gateway;
  `match_thoughts` RPC; `upsert_thought` RPC; MCP_ACCESS_KEY.
- **Notes:** Hard-coupled to Supabase: required env are SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY; auth is PostgREST apikey + RLS;
  endpoints are `/rest/v1/<table>` and `/functions/v1/open-brain-mcp`. Entire
  Access Key / RLS categories (5 of 28 checks) are meaningless for us. DB
  schema check expects canonical columns plus `content_fingerprint` — our
  schema has `brain_id`, `dedupe_key`, `content_hash`, etc. RPCs
  `match_thoughts`/`upsert_thought` we don't have. **Effectively a rewrite of
  the harness skeleton; the value is the test catalog and skip-vs-fail
  discipline.**

#### `recipes/content-fingerprint-dedup`

- **Purpose:** Adds a SHA-256 normalized-content fingerprint column plus
  partial unique index and an `upsert_thought()` plpgsql function.
- **Coupling:** none. **Effort:** small. **Value:** low.
- **Dependencies:** thoughts table.
- **Notes:** Vanilla Postgres SQL. Real blocker is column overlap: we already
  have `content_hash` and `dedupe_key`. The recipe's contribution is mostly
  the normalization regex and the merge-metadata-on-conflict pattern — worth
  cribbing into our existing ingest path rather than adopting wholesale.

#### `recipes/fingerprint-dedup-backfill`

- **Purpose:** One-time backfill that computes SHA-256 content fingerprints
  (with light normalization) on legacy NULL rows and deletes duplicates.
- **Coupling:** supabase. **Effort:** small. **Value:** low.
- **Dependencies:** `content-fingerprint-dedup`.
- **Notes:** Hard-coupled to Supabase PostgREST. Targets a `content_fingerprint`
  column we don't have. Backfill for a feature we haven't adopted, not an
  ongoing capability. Lift the normalization regex only.

#### `recipes/atomizer`

- **Purpose:** Splits compound multi-topic text (memory packs, whole-body
  Gmail rows) into atomic single-topic thoughts via an LLM, plus Gmail-specific
  re-atomize/audit/correspondent-backfill tooling.
- **Coupling:** supabase. **Effort:** medium. **Value:** high.
- **Dependencies:** `email-history-import`; `entities` table;
  `thought_entities` table; `thought_edges` table; `upsert_thought` RPC.
- **Notes:** Two distinct workflows.
  - **Workflow A (`atomize-packs.mjs`):** nearly platform-free. Pure Node 18+
    walking local JSON pack files and calling an LLM. Only the OpenRouter
    HTTP call needs repointing at our DeepSeek endpoint. Default model
    `anthropic/claude-sonnet-4.5` should be replaced; prompt is provider-
    agnostic. **Port first.**
  - **Workflow B (Gmail tools):** heavily Supabase-coupled. Uses PostgREST,
    requires `entities`/`thought_entities` tables we don't have, requires
    `thought_edges` with `replies_to` relation, calls
    `public.upsert_thought(p_content, p_payload)` RPC we don't have. Also
    depends on `email-history-import` having produced rows with
    `[Email from X to Y | Subject: ...]` content prefix. **Defer until we land
    an entity graph and the email importer.**
- Multi-tenant `brain_id` is not threaded through any of these scripts.

#### `recipes/weekly-digest`

- **Purpose:** Scheduled weekly synthesis of recent thoughts ranked by
  importance, delivered as a sectioned digest (Wins/Decisions/Open loops/Themes)
  to Telegram, stdout, or a markdown file.
- **Coupling:** mixed. **Effort:** small. **Value:** high.
- **Dependencies:** `public.thoughts` with `sensitivity_tier` and `importance`
  columns (or `metadata.importance` fallback); Telegram Bot API (optional);
  Anthropic/OpenRouter LLM (must be swapped to DeepSeek).
- **Notes:** Coupling is shallow: PostgREST + service_role key + Anthropic.
  No Edge Functions, no Vercel, no Neon. Real blockers: (1) replace PostgREST
  fetch in `fetchThoughts` with direct PG (psycopg/pg) or small FastAPI
  endpoint — same SQL semantics map 1:1. (2) Replace Anthropic/OpenRouter with
  OpenAI-compatible call to mlx-server's DeepSeek endpoint (~30 lines).
  (3) Add `brain_id` scoping. Our schema already has `importance` and
  `sensitivity_tier` natively. Telegram delivery, chunking, model aliasing,
  dry-run, file output, importance ranking + widening fallback are all stack-
  agnostic and worth keeping verbatim.

#### `recipes/live-retrieval`

- **Purpose:** A Claude Code SKILL.md (no code, no SQL) that proactively calls
  `search_thoughts`/`list_thoughts` MCP tools on topic shifts and surfaces hits
  as brief in-line context notes.
- **Coupling:** none. **Effort:** trivial. **Value:** high.
- **Dependencies:** MCP tools `search_thoughts`, `list_thoughts` (we have
  both as `mcp__ob1__search_thoughts`, `mcp__ob1__list_thoughts`).
- **Notes:** Three files (README, metadata.json, SKILL.md), zero code.
  Drop into `~/.claude/skills/live-retrieval/SKILL.md`; only edit needed is
  updating example tool calls from `search_thoughts(...)` to our actual MCP
  names if Claude Code requires the namespaced form.

#### `recipes/obsidian-vault-import`

- **Purpose:** Walks an Obsidian vault, parses markdown + frontmatter +
  wikilinks, chunks notes (whole/heading-split/LLM-distill), embeds, and
  inserts thoughts with rich metadata.
- **Coupling:** mixed. **Effort:** small. **Value:** high (conditional).
- **Dependencies:** thoughts table (with optional `content_fingerprint`).
- **Notes:** Parsing/chunking/secret-scan is pure Python, stack-agnostic
  (~700 lines reusable). Coupling confined to ~3 functions:
  (1) `generate_embedding` → swap to local Qwen3 endpoint; (2) `llm_distill` →
  swap to DeepSeek; (3) `insert_thought` → replace PostgREST with asyncpg or
  wire into FastAPI ingest. Uses `content_fingerprint` for dedup; map to our
  `content_hash`. No `brain_id` awareness — trivial to add as a CLI flag.
  Metadata shape (source/title/folder/tags/date/wikilinks/frontmatter/section)
  maps cleanly. **Recommend:** keep parse/chunk/secret-scan as a library
  module, replace I/O boundaries with calls into our FastAPI ingest pipeline
  so it benefits from existing enrichment/quality_score/sensitivity_tier
  logic.

#### `recipes/wiki-compiler`

- **Purpose:** Node.js wrapper that orchestrates a multi-phase pipeline (entity
  extraction trigger, typed-edge classification, entity wiki page generation,
  topic synthesis, optional Gmail thread wikis) producing a regenerable
  `compiled-wiki/` directory plus a manifest.
- **Coupling:** supabase. **Effort:** small. **Value:** low.
- **Dependencies:** `entity-extraction-schema`; `entity-extraction-worker`;
  `typed-edge-classifier`; `typed-reasoning-edges`; `entity-wiki`;
  `wiki-synthesis`.
- **Notes:** Thin orchestrator (compile-wiki.mjs spawns four other recipe
  scripts via child_process and POSTs to an entity-extraction Edge Function).
  Trivially portable, but real cost is in the four downstream recipes it
  orchestrates. **Until those land, nothing for this wrapper to do.** Replace
  with a 30-line shell script when needed.

#### `recipes/wiki-synthesis`

- **Purpose:** Two Node CLIs that synthesize markdown "wiki" views from atomic
  thoughts — a year-bucketed autobiography, and a per-Gmail-thread summary
  written back as a `gmail_wiki` thought with `derived_from` edges.
- **Coupling:** supabase. **Effort:** medium. **Value:** medium.
- **Dependencies:** `email-history-import`; knowledge-graph schema
  (`thought_edges`).
- **Notes:** Blockers: (1) DB I/O via PostgREST + service_role — replumb to
  FastAPI or asyncpg. (2) Zero brain_id awareness. (3) Email-thread mode needs
  `thought_edges` with UNIQUE(from,to,relation) and `metadata.gmail.thread_id`
  from email importer — defer. LLM call is OpenAI-compatible — DeepSeek drops
  in via env vars. **Topic-mode autobiography is the valuable bit (~390 lines);
  rewriting in Python may be less work than maintaining a divergent Node script.**

#### `recipes/entity-wiki`

- **Purpose:** Auto-generates per-entity markdown wiki pages by aggregating
  every thought linked to an entity (via thought_entities + typed edges), then
  synthesizing a structured Summary/Key Facts/Timeline/Relationships/Open
  Questions page.
- **Coupling:** supabase. **Effort:** medium. **Value:** high.
- **Dependencies:** `schemas/entity-extraction`;
  `integrations/entity-extraction-worker`.
- **Notes:** 939-line Node script. Hard requirement on entity-extraction tables
  (`public.entities`, `public.thought_entities`, `public.edges`). Port:
  (1) replace PostgREST with asyncpg/SQLAlchemy scoped by brain_id; (2) swap
  default LLM_BASE_URL/MODEL to mlx-server + DeepSeek; (3) swap OpenAI
  text-embedding-3-small to Qwen3-Embedding-8B for `--semantic-expand` and
  `--output-mode=thought` paths; (4) the "thought" output mode needs to write
  through our FastAPI ingest path so dedupe_key/content_hash are populated
  correctly. Algorithm itself (group typed edges by relation, exclude
  `co_occurs_with`, cap snippets at 300 chars, ~25 linked + ~15 semantic,
  single LLM call producing structured markdown with inline thought-id
  citations) is well-thought-out.

#### `recipes/repo-learning-coach`

- **Purpose:** A local React+Express learning workspace for studying a
  codebase, backed by 10 Supabase tables for lessons/quizzes/progress, with a
  bridge that captures durable takeaways back into Open Brain's `thoughts`.
- **Coupling:** supabase. **Effort:** large. **Value:** low.
- **Dependencies:** thoughts table; `upsert_thought` RPC; `match_thoughts` RPC;
  OpenRouter embeddings.
- **Notes:** Heavy Supabase coupling throughout. Schema itself is portable
  (vanilla Postgres) but the entire 10-table learning schema is a heavy add
  for a niche feature. **Skip the port; the takeaway-capture pattern is ~30
  lines of metadata shaping that can be lifted into a separate small ingest
  helper if interesting.**

#### `recipes/provenance-chains`

- **Purpose:** Operational layer (backfill script, LLM-graded nightly quality
  eval, two MCP tool handlers) over the provenance-chains schema, so the
  brain can answer "show me why I believe X" and "what cites this thought?"
  via a directed derivation graph.
- **Coupling:** mixed. **Effort:** medium. **Value:** high.
- **Dependencies:** `schemas/provenance-chains`.
- **Notes:** Hard-coupled to Supabase PostgREST + service_role RLS
  (backfill.mjs PATCHes via REST and calls `merge_thought_provenance_metadata`
  RPC; mcp-tools.ts is a Deno Edge Function snippet). Blockers: (1) replace
  PostgREST PATCH/RPC with asyncpg/SQLAlchemy or small Node `pg` client;
  (2) drop `mcp-tools.ts` into our Node MCP server and replace `supabase.rpc`
  with `pg` client calls — function signatures are clean
  (`trace_provenance(uuid, int, int)`, `find_derivatives(uuid, int)`);
  (3) point `eval.mjs` at our DeepSeek mlx-server endpoint, or use
  `--grader stdin/queue` modes. No `brain_id` awareness. **Ship the schema +
  MCP tools first; defer eval.mjs.**

#### `recipes/typed-edge-classifier`

- **Purpose:** Hybrid Haiku-filter / Opus-classify pipeline that walks
  candidate thought pairs (sharing entities) and inserts typed reasoning
  edges into `thought_edges` with confidence and temporal bounds.
- **Coupling:** mixed. **Effort:** medium. **Value:** medium.
- **Dependencies:** `schemas/typed-reasoning-edges`; `schemas/entity-extraction`;
  `schemas/provenance-chains` (optional).
- **Notes:** (1) DB I/O all PostgREST against OPEN_BRAIN_URL with service_role
  key — replumb to asyncpg/SQLAlchemy. (2) LLM hardcoded to Anthropic API +
  OpenRouter with claude-haiku-4-5 / claude-opus-4-7 model names, custom
  `anthropic-version` headers, and a hand-maintained Anthropic PRICING table —
  swap to OpenAI-compatible client at mlx-server (DeepSeek for both legs;
  hybrid tiering loses its point on a single-model stack — consider
  `--no-hybrid` by default). (3) Depends on two schemas. (4) No brain_id
  awareness. (5) Cost-cap machinery is dead weight locally — strip or replace
  with token-budget cap. Prompt design, six-relation vocabulary,
  `classifier_version` tagging, idempotent upsert semantics, and supersedes-
  mirror reasoning are useful even though plumbing is heavy.

#### `recipes/local-ollama-embeddings`

- **Purpose:** CLI that generates embeddings via a local Ollama server and
  inserts thoughts into Supabase via PostgREST.
- **Coupling:** supabase. **Effort:** small. **Value:** low.
- **Dependencies:** none.
- **Notes:** Coupling shallow, but **we already serve Qwen3-Embedding-8B-mxfp8
  in our pipeline.** This is duplicative. Schema-fit is also off: it writes
  only content/embedding/jsonb metadata, ignoring brain_id/embedding_model/
  embedding_dimension/dedupe_key/content_hash/type/source_type/sensitivity_tier/
  importance/quality_score/enriched. The README's empirical similarity-gap
  comparison of nomic-embed-text vs mxbai-embed-large vs gte-qwen2-1.5b is
  useful reference data (does **not** include Qwen3-8B, so conclusions don't
  transfer to our embedding model).

#### `recipes/world-model-diagnostic-activation`

- **Purpose:** Prompt-and-skill workflow that interviews a user about their
  company's readiness for a "world model," persisting three durable thoughts
  via the base capture_thought/search_thoughts tools.
- **Coupling:** supabase. **Effort:** trivial. **Value:** low.
- **Dependencies:** `skills/world-model-diagnostic`; core `capture_thought`,
  `search_thoughts`.
- **Notes:** V1 ships zero new schema and zero new tools — just README + prompt
  driving the paired skill. metadata.json incorrectly lists Supabase as
  required; the V1 recipe never touches it. The included `schema-v2-draft.sql`
  is Supabase-coupled but explicitly draft. **B2B consulting-style company-
  readiness diagnostic — not a personal-knowledge or memory primitive.**

#### `recipes/work-operating-model-activation`

- **Purpose:** Conversation-first 45-minute interview workflow that elicits a
  user's operating rhythms, recurring decisions, dependencies, institutional
  knowledge, and friction into 5 structured Postgres tables and renders
  agent-ready exports (USER.md, SOUL.md, HEARTBEAT.md, operating-model.json,
  schedule-recommendations.json).
- **Coupling:** supabase. **Effort:** medium. **Value:** medium.
- **Dependencies:** `skills/work-operating-model`; `bring-your-own-context`
  (parent recipe); core `search_thoughts` + `capture_thought`.
- **Notes:** Schema is vanilla Postgres (5 tables + 2 plpgsql RPCs); strip RLS
  `USING (auth.uid() = user_id)` and service_role grants, swap `user_id UUID`
  to our `brain_id`. **Runtime blocker:** `index.ts` (862 lines) is a Deno
  Edge Function using `jsr:@supabase/functions-js`, `@hono/mcp`,
  `@supabase/supabase-js`, `Deno.env` — must be rewritten as a Node MCP server
  calling our PG pool directly. Tool surface is small (4 tools). Sidecar data
  model parallel to `thoughts` — **rank medium because the artifacts have real
  utility for an agent-context use case, not because the implementation is
  clever.**

#### `recipes/editorial-policy`

- **Purpose:** A 40-rule editorial constitution that synthesis prompts cite by
  number, plus a weekly LLM auditor that scans recent thoughts for drift,
  contradictions, staleness, and inflation and stores findings as
  `type=audit_report` thoughts.
- **Coupling:** mixed. **Effort:** medium. **Value:** high.
- **Dependencies:** thoughts table with metadata jsonb + type field; LLM
  endpoint; optional Slack webhook; scheduler; updated synthesis prompts that
  cite policy version.
- **Notes:** The valuable artifact is `editorial-policy.md` (40 rules) — pure
  prose, drops in as `docs/editorial-policy.md`. Schema is one CREATE FUNCTION
  RPC + one partial index — Postgres-portable. Auditor itself is a Deno/TS
  Supabase Edge Function. Rewrite as Python FastAPI route or standalone script
  using asyncpg + httpx pointed at DeepSeek. Replace pg_cron+pg_net with cron/
  systemd/APScheduler. Add `brain_id` filtering. **Prerequisite: updating our
  morning-briefing/weekly-summary prompts to cite `R{n}.{m}` rules — real human
  work, not code work.** Directly addresses synthesis drift; policy doc is
  reusable IP regardless.

#### `recipes/research-to-decision-workflow`

- **Purpose:** Prose-only "recipe" describing how to chain five skill packs
  (competitive-analysis, financial-model-review, deal-memo-drafting,
  research-synthesis, meeting-synthesis) into operator or investor decision
  workflows, with a workspace template and handoff checklist.
- **Coupling:** none. **Effort:** trivial. **Value:** low.
- **Dependencies:** five upstream skill packs.
- **Notes:** Zero platform coupling. Targets investor/operator memo workflows
  (deal memos, IC recommendations, financial model reviews) — **only useful if
  you actually adopt those five skills.**

#### `recipes/schema-aware-routing`

- **Purpose:** LLM-extracts metadata from raw text and fans the result out to
  multiple tables (thoughts, people, interactions, action_items) with fuzzy
  person resolution.
- **Coupling:** supabase. **Effort:** medium. **Value:** high.
- **Dependencies:** none (but assumes new tables we don't have).
- **Notes:** The pattern — LLM-extracted metadata drives multi-table routing
  with three-pass person resolution (exact → alias → fuzzy first-name →
  create), plus first-person-only action-item rule — is genuinely valuable and
  stack-agnostic. Concrete blockers: (1) hardcoded `@supabase/supabase-js` —
  replace with FastAPI/SQLAlchemy or asyncpg. (2) Schema assumes vector(1536)
  for OpenAI embeddings — must use Qwen3-Embedding-8B native dim and our
  existing thoughts columns. (3) `people`, `interactions`, `action_items`,
  `pending_confirmations` tables don't exist — need new migrations with
  brain_id and FKs into thoughts. (4) `extractMetadata`/`getEmbedding` are
  stubbed `throw` placeholders — trivial to wire to DeepSeek + Qwen.
  (5) `metadata.type` enum (task/observation/idea/reference/person_note) and
  `domain` enum collide with our newly-added `type` column — reconcile
  vocabularies. (6) `pending_confirmations` is a stub. **The routing logic,
  prompt, and conservative fuzzy-match heuristic are the keepers — all the
  plumbing gets rewritten.** ~300 lines of TS → ~400 lines of Python +
  1 migration.

#### `recipes/source-filtering`

- **Purpose:** Add a `source` filter parameter to MCP search/list/stats tools
  and provide a backfill script that fills missing LLM-extracted metadata
  (type, topics, people, sentiment) on legacy thoughts.
- **Coupling:** mixed. **Effort:** small. **Value:** medium.
- **Dependencies:** thoughts table; MCP tools; LLM metadata extraction (same
  prompt used by capture_thought).
- **Notes:** Two parts: (1) add `source` parameter to MCP tools — trivial,
  just adds `WHERE metadata->>'source' = $1`; we already store source under
  `thoughts.source_type` (better than `metadata->>'source'`) so even simpler.
  (2) `backfill-metadata.ts` is Deno + Supabase REST PATCH + OpenRouter
  gpt-4o-mini — full Python rewrite using SQLAlchemy + DeepSeek mlx-server
  (drop-in OpenAI-compatible base_url swap). The existing `type` column means
  we should write to the column, not just metadata. **Useful one-time
  migration tool for any legacy bulk-imported thoughts; the source-filter UX
  feature is so trivial it's barely a recipe.**

#### `recipes/thought-enrichment`

- **Purpose:** Retroactively classifies existing thoughts via LLM (type,
  summary, topics, tags, people, action_items, importance,
  detected_source_type) and tags sensitive content (PII/health/financial) via
  regex.
- **Coupling:** supabase. **Effort:** medium. **Value:** high.
- **Dependencies:** `schemas/enhanced-thoughts`.
- **Notes:** Three scripts (`enrich-thoughts.mjs`, `backfill-type.mjs`,
  `backfill-sensitivity.mjs`) all talk to Supabase via PostgREST. Port:
  (1) replace ~6-8 PostgREST fetch sites per script with direct PG. (2) Swap
  LLM provider — script already abstracts via `callOpenRouter`/`callAnthropic`,
  add a `callDeepSeek` path. (3) Add brain_id WHERE filter on every query.
  **Classification prompt, importance/confidence calibration, retry logic,
  state checkpointing (`data/enrichment-state.json`), retry-failed mode, and
  `sensitivity-patterns.json` are all stack-agnostic and high-value — keep
  verbatim.** Our thoughts table already has every required column. ~1
  focused day to port the three scripts to Python+asyncpg behind FastAPI or
  as standalone scripts hitting PG directly. **This is the real solution to
  the type-column-NULL problem we hit during migration 006.**

## Open questions for porting decisions

1. **Do we have an Obsidian vault?** Determines whether `obsidian-vault-import`
   is in or out.
2. **Will agents start writing to the brain?** Determines whether
   `agent-memory` is in or out.
3. **Do we want a knowledge graph?** Tier 3 is a multi-week commitment; the
   alternative is staying with the current vector-only retrieval.
4. **Do we use the CRM extension?** (Survey scope didn't include CRM updates.)
5. **Do we want Readwise import?** Determines `readwise-books`.
6. **Will we maintain the editorial-policy.md as a synthesis constitution?**
   The auditor is medium effort, the policy doc is no effort, the synthesis-
   prompt updates are real human work.
