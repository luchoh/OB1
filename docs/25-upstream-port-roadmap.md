# PRD: Upstream Port Roadmap

Date: 2026-06-01
Status: Plan; awaiting decision on starting tier
Owner: Retrieval / Knowledge Layer

Companion to: research doc `24-upstream-port-survey.md`

## Summary

Port valuable, platform-portable additions from upstream
(`NateBJones-Projects/OB1`, branch `main`) into our fork's
`master` line, in roughly four tiers ordered by value-per-effort. We have
already completed Tier 0 (skills tree, lexical search migration). This PRD
specifies what is in scope for Tiers 1 — 3, what is out of scope (Tier 5,
deferred), and what remains conditional on user-specific signals (Tier 4).

The decision to port each item has been made by the survey in doc 24; this
PRD turns that into actionable checklists.

## Goals

- Adopt upstream improvements that survive the platform translation
  (Supabase → local PG, OpenRouter/Anthropic → DeepSeek-V4-Flash, OpenAI
  embeddings → Qwen3-Embedding-8B-mxfp8) without regressing our local-first
  invariants (multi-tenancy via `brain_id`, FastAPI/Python ingest, Node MCP
  server).
- Keep the porting cost honest: every item below has a concrete blocker
  inventory in doc 24.
- Land changes incrementally so each tier is independently revertable and
  separately deployable to production via the system-config Nix pin.

## Non-goals

- Adopting upstream's Supabase / Vercel / Edge Function runtime in any form.
- Porting upstream's dashboards (`dashboards/open-brain-dashboard*`).
- Porting upstream `integrations/` that require Supabase auth or PostgREST
  (`agent-memory-api`, `kubernetes-deployment`, `open-brain-rest`,
  `openclaw-agent-memory`, `readwise-capture`, `update-thought-mcp`,
  `entity-extraction-worker`). Where their **schemas** are valuable, we port
  the schema and write our own runtime.
- Adopting upstream's documentation rewrites verbatim. Our docs are specific
  to our local runtime; refresh comes after porting decisions are settled.

## Universal porting steps

Every Supabase-coupled item requires the same five mechanical fixes. These
are the "checkbox lines" in each per-item checklist below.

1. ☐ **Strip Supabase role grants.** Remove `GRANT ... TO authenticated, anon,
   service_role` and `REVOKE ... FROM authenticated, anon`. Replace with
   nothing (table owner has rights) or our app role (`ob1`).
2. ☐ **Strip RLS.** Remove `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and any
   `CREATE POLICY ... USING (auth.uid() = ...)` blocks.
3. ☐ **Strip PostgREST notify.** Remove `NOTIFY pgrst, 'reload schema';`.
4. ☐ **Replace PostgREST with direct PG.** Recipe scripts hitting
   `${SUPABASE_URL}/rest/v1/<table>` with apikey/service_role bearer →
   asyncpg/psycopg from Python or `pg` driver from Node, or call our existing
   FastAPI ingest path.
5. ☐ **Add `brain_id` filtering.** Every SELECT/UPDATE/INSERT/RPC must accept
   and scope by `brain_id`.

LLM-call substitution (universal):

- ☐ OpenRouter / Anthropic / OpenAI direct → `https://mlx.lincoln.luchoh.net/v1`
  with model `DeepSeek-V4-Flash-nvfp4`. Drop OpenRouter `HTTP-Referer`/
  `X-Title` and Anthropic `anthropic-version`/`x-api-key` headers. The
  JSON-mode/tool-use pattern transfers.
- ☐ OpenAI embeddings → `https://ob1-embedding.lincoln.luchoh.net/v1` with
  `Qwen3-Embedding-8B-mxfp8`, dim 1536.

## Tier 0 — Already done

| Item | Branch | Status |
|---|---|---|
| Skills tree (16 dirs) | `master` @ `6a595fc` | Imported wholesale from upstream `f16479e`. |
| Migration 006 (lexical search: `enhanced-thoughts` + `text-search-trgm` adapted) | `master` @ `fa9fee1` | Applied to `ob1_dev`. type/source_type/sensitivity_tier/importance/quality_score/enriched columns; tsvector + trgm GIN indexes; search_thoughts_text/brain_stats_aggregate/get_thought_connections RPCs (single-tenant; brain-scoped variants in migration 007). |
| `server.mjs` writes `metadata.type` to the new `type` column on insert/upsert | `master` @ `fa9fee1` | Coalesce-on-conflict merge. |
| Telegram text-thought captures opt into `extract_metadata` | `master` @ `fa9fee1` | Source row stays opt-out. |

**Open from Tier 0:**
- ☐ Backfill the 6,747 existing rows in `ob1_dev` so `type` is populated. The
  best tool for this is `recipes/thought-enrichment` (Tier 2) — defer until
  we port that recipe.
- ☐ Migration 007: brain-scoped variants of the three RPCs.

## Tier 1 — Buy now (high value, low effort)

Estimated total effort: **1 — 3 hours**, including verification.

### 1.1 `schemas/workflow-status` → migration 008 (or 007 if not yet allocated)

- ☐ Read `git show main:schemas/workflow-status/schema.sql`.
- ☐ Apply universal step 1 (drop service_role grants).
- ☐ Apply universal step 2 (drop RLS — there isn't any in this schema, but
  confirm).
- ☐ Apply universal step 3 (drop NOTIFY pgrst).
- ☐ Rewrite the backfill predicate from `metadata->>'type' IN ('task','idea')`
  to `WHERE type IN ('task','idea')` (we have the column now).
- ☐ Multi-tenancy is already safe (column is on existing `thoughts`).
- ☐ Apply via `ob1-migrate` to `ob1_dev`.
- ☐ Smoke test: `INSERT ... status='in_progress'; SELECT ... WHERE status IS
  NOT NULL`.
- ☐ Commit + push.

### 1.2 `recipes/live-retrieval` → drop-in skill

- ☐ `git show main:recipes/live-retrieval/SKILL.md` — copy to
  `skills/live-retrieval/SKILL.md` (already imported wholesale in Tier 0; this
  is a sanity check that it landed).
- ☐ Verify our MCP tool names (`mcp__ob1__search_thoughts`,
  `mcp__ob1__list_thoughts`) match the SKILL.md examples; edit if they don't.
- ☐ Smoke test: open a Claude Code conversation, mention a topic that should
  trigger live retrieval, observe MCP tool call.
- ☐ No code change; the import landed in Tier 0. This task is verification
  only.

### 1.3 `schemas/recency-boosted-match-thoughts` → migration 009

- ☐ Read `git show main:schemas/recency-boosted-match-thoughts/schema.sql`.
- ☐ Apply universal steps 1-3.
- ☐ Add `brain_id uuid` parameter to `match_thoughts_recency`; add
  `WHERE t.brain_id = brain_id` predicate.
- ☐ Add `embedding_model` and `embedding_dimension` filters to avoid mixing
  heterogeneous vectors.
- ☐ Widen returned column set to include `type`, `source_type`, `importance`,
  `quality_score` (so callers don't need a second query).
- ☐ Vector dim is `vector(1536)` — matches our Qwen3 output. No change needed.
- ☐ Apply via `ob1-migrate` to `ob1_dev`.
- ☐ Smoke test: call `match_thoughts_recency('test query', recency_weight=0.0)`
  and confirm result matches `match_thoughts`. Then `recency_weight=0.5` and
  observe newer rows ranked higher.
- ☐ Wire optional `recency_weight` parameter into our retrieval RPC layer
  (FastAPI or Node MCP — pick one). **Out of scope** for migration; tracked
  separately as a follow-up if we want it surfaced in the MCP API.
- ☐ Commit + push.

## Tier 2 — Buy soon (high value, manageable effort)

Order suggested below; each can be done independently.

### 2.1 `schemas/thought-audit` → migration 010

- ☐ Read `git show main:schemas/thought-audit/schema.sql`.
- ☐ Apply universal steps 1-3.
- ☐ Add `brain_id UUID NOT NULL` column to `thought_audit`.
- ☐ Add index on `(brain_id, created_at DESC)`.
- ☐ Caller wiring:
  - ☐ FastAPI capture path: write an audit row on every INSERT/UPDATE/DELETE to
    `thoughts` via SQLAlchemy/asyncpg.
  - ☐ Node MCP server (`server.mjs`): same, on `upsertThought` /
    `update_thought` / `delete_thought` if those exist.
  - ☐ Telegram bridge ingest: piggyback on the FastAPI path; no direct write.
- ☐ Apply migration; verify audit rows appear after a test capture.
- ☐ Smoke test: capture a thought, edit it via Telegram review, verify two
  audit rows.
- ☐ Commit + push.

### 2.2 `recipes/weekly-digest` → Python script + cron

- ☐ Read `git show main:recipes/weekly-digest/*` — identify entry script,
  prompt, Telegram delivery code.
- ☐ Rewrite as `scripts/weekly_digest.py` (or wherever Python scripts live):
  - ☐ Replace `fetchThoughts` PostgREST call with asyncpg query against
    `thoughts` filtered by `brain_id`, `created_at >= NOW() - 7 days`,
    `sensitivity_tier IS DISTINCT FROM 'restricted'`, ordered by `importance
    DESC, created_at DESC`.
  - ☐ Replace Anthropic/OpenRouter LLM call with OpenAI-compatible call to
    DeepSeek mlx-server.
  - ☐ Keep verbatim: chunking, model aliasing, `--dry-run`, file output,
    importance widening fallback, Telegram delivery.
  - ☐ Add `--brain-id` CLI flag; `--brain-id all` iterates per brain.
- ☐ Add cron / systemd-timer entry (or instructions for sysadmin handoff).
- ☐ Smoke test: `--dry-run --brain-id <test>` on `ob1_dev`; eyeball output.
- ☐ Smoke test: production target with `--telegram-chat <test>` for one
  Sunday.
- ☐ Commit + push (script only; cron entry goes through system-config).

### 2.3 `recipes/thought-enrichment` + `recipes/source-filtering` → backfill solution

This solves the type-column NULL problem from migration 006.

- ☐ Read all three upstream scripts:
  - `git show main:recipes/thought-enrichment/enrich-thoughts.mjs`
  - `git show main:recipes/thought-enrichment/backfill-type.mjs`
  - `git show main:recipes/thought-enrichment/backfill-sensitivity.mjs`
- ☐ Read `git show main:recipes/source-filtering/backfill-metadata.ts` and
  `git show main:recipes/thought-enrichment/lib/sensitivity-patterns.mjs` and
  `git show main:recipes/thought-enrichment/sensitivity-patterns.json`.
- ☐ Rewrite as a single Python script tree under
  `scripts/thought_enrichment/`:
  - ☐ `enrich.py` — main classifier (LLM-driven type/topics/people/
    action_items/importance/detected_source_type).
  - ☐ `backfill_type.py` — narrower: only fills the `type` column where NULL.
  - ☐ `backfill_sensitivity.py` — regex-based (PII/health/financial) sensitivity
    tagging.
  - ☐ `sensitivity_patterns.json` — copy verbatim from upstream.
- ☐ Apply universal step 4 (PostgREST → asyncpg).
- ☐ Apply LLM substitution (drop `callOpenRouter`/`callAnthropic`, add
  `callDeepSeek`).
- ☐ Apply universal step 5 (`brain_id` WHERE filter on every query).
- ☐ Keep verbatim: classification prompt, importance/confidence calibration,
  retry logic, state checkpointing (`data/enrichment-state.json`),
  retry-failed mode.
- ☐ Write to `thoughts.type` column AND `metadata.type` (mirror our current
  ingest path).
- ☐ Smoke test: `--dry-run --limit 20` on `ob1_dev`; eyeball ~20 random rows'
  proposed `type` values.
- ☐ If sane, run against the full 6,747-row `ob1_dev` corpus; verify `type`
  populated for >95%.
- ☐ Source filter: add `source` parameter to MCP `search_thoughts` /
  `list_thoughts` / `thought_stats` — but use our `source_type` column, not
  `metadata->>'source'`. **Trivial** — single WHERE clause addition. ☐ Done in
  `server.mjs`.
- ☐ Commit + push.

### 2.4 `schemas/provenance-chains` + `recipes/provenance-chains` → derivation graph

- ☐ Read `git show main:schemas/provenance-chains/schema.sql`.
- ☐ Apply universal steps 1-3.
- ☐ Add `brain_id` parameter to `trace_provenance` and `find_derivatives`;
  add `WHERE t.brain_id = p_brain_id` predicate to both. **Critical:** without
  this they walk across tenants.
- ☐ Swap `metadata->>'type'` and `metadata->>'sensitivity_tier'` reads inside
  the helpers for direct column reads (we have those columns now).
- ☐ Apply migration as `011_provenance_chains.sql`.
- ☐ Read `git show main:recipes/provenance-chains/backfill.mjs` and `mcp-tools.ts`
  and `eval.mjs`.
- ☐ Port `backfill.mjs` → `scripts/provenance/backfill.py` using asyncpg.
- ☐ Port `mcp-tools.ts` into our Node `server.mjs` as new MCP tools
  (`trace_provenance`, `find_derivatives`). Replace `supabase.rpc` with `pg`
  client calls; signatures are clean (`trace_provenance(uuid, int, int)`,
  `find_derivatives(uuid, int)`).
- ☐ Defer `eval.mjs` for now (LLM-graded nightly quality eval; needs DeepSeek
  swap and is medium effort).
- ☐ Smoke test: synthesize a thought from two atoms, verify
  `find_derivatives(atom_id)` returns it.
- ☐ Commit + push.

### 2.5 `recipes/obsidian-vault-import` → conditional

**Decision required:** do we have an Obsidian vault we want to ingest?

If yes:

- ☐ Read `git show main:recipes/obsidian-vault-import/*`.
- ☐ Lift parser/chunker/secret-scan as `scripts/imports/obsidian_vault/lib.py`
  (~700 lines, stack-agnostic).
- ☐ Replace `generate_embedding` → call our Qwen3 endpoint.
- ☐ Replace `llm_distill` → call DeepSeek mlx-server.
- ☐ Replace `insert_thought` PostgREST call → call our FastAPI ingest path so
  enrichment / quality_score / sensitivity_tier are populated through the
  normal pipeline.
- ☐ Map `content_fingerprint` → our `content_hash`.
- ☐ Add `--brain-id` CLI flag.
- ☐ Smoke test: import a 10-note vault, verify rows in `thoughts`, verify
  metadata shape (source/title/folder/tags/wikilinks/frontmatter/section).
- ☐ Commit + push.

If no: skip.

## Tier 3 — Strategic (knowledge graph stack)

This tier is a **multi-week commitment** and only worth starting if we
actively want a typed knowledge graph layer over the brain. Approximate order
of dependencies:

1. ☐ `schemas/entity-extraction` migration (apply universal fixes; add
   `brain_id` to all 5 tables; tighten unique constraints to
   `(brain_id, ...)`; rewrite the `content_fingerprint` trigger to use our
   `content_hash`).
2. ☐ Python entity-extraction worker (replaces upstream's Edge Function).
   Reads `entity_extraction_queue`, calls DeepSeek to extract entities, writes
   to `entities`, `thought_entities`, `edges`. Standalone process or FastAPI
   route triggered by the queue.
3. ☐ `schemas/typed-reasoning-edges` migration (apply universal fixes; add
   `brain_id` with CHECK that both endpoints share the same brain).
4. ☐ Port `recipes/typed-edge-classifier` to Python; collapse hybrid Haiku/Opus
   to single-DeepSeek; replace cost-cap with token-budget cap.
5. ☐ Port `recipes/entity-wiki` to Python (or Node, whichever fits our MCP
   layer better); rewrite I/O against our FastAPI ingest path.
6. ☐ Port `recipes/wiki-synthesis` topic-mode autobiography (defer email-thread
   mode until we have email importer).

Each item has its own checklist sub-prerequisites in doc 24.

## Tier 4 — Conditional (depends on user choice)

| Item | Decision criterion |
|---|---|
| `recipes/atomizer` (workflow A) | Do we ingest "memory packs" or long compound bodies? |
| `schemas/agent-memory` | Will agents (Claude Code/Codex/ChatGPT) start writing to the brain? |
| `recipes/editorial-policy` | Will we maintain the 40-rule synthesis constitution? |
| `schemas/readwise-books` + Readwise importer | Do we use Readwise? |
| Updates to existing `extensions/professional-crm` | Do we use the CRM extension? |

## Tier 5 — Skipped (with rationale)

Same list as in doc 24's triage summary; not repeating here. The skip rationale
for each is: implementation is heavily Supabase-wired and the value either
duplicates what we have or is too niche to justify a rewrite.

## Risks & rollback

- **Migrations are additive.** All Tier 1 — 3 schema changes are
  `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE
  FUNCTION` — safe to apply, hard to roll back individually but no destructive
  changes.
- **Breaking change risk: brain_id in RPC signatures.** If we expose ported
  RPCs (`trace_provenance`, `match_thoughts_recency`) to MCP clients before
  internal callers are updated, the signature changes will break callers. Hold
  RPC exposure until internal use sites are updated.
- **LLM substitution may surface prompt fragility.** Upstream prompts are
  tuned for Claude/GPT-4o-mini; DeepSeek-V4-Flash may produce slightly
  different JSON structures. All ports MUST include `--dry-run` mode before a
  bulk apply.
- **Production deployment.** All work lands on `master`; production is pinned
  in system-config by SHA. None of this reaches prod until system-config bumps
  the pin.

## Decision points

We need explicit answers to advance:

1. **Start Tier 1 today?** All three items are <3 hours total, low risk.
2. **Tier 2 priority order?** Suggested: 2.3 (thought-enrichment, solves
   type-NULL) → 2.1 (thought-audit) → 2.2 (weekly-digest) → 2.4 (provenance) →
   2.5 (Obsidian, conditional).
3. **Tier 3 yes/no?** Multi-week project. Discuss before starting.
4. **Tier 4 items: yes/no/defer per item?**
