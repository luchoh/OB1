# Decision: thought deletion (delete / restore / purge)

Date: 2026-06-06
Status: HARDENED — rewritten after a critic+verifier agent pass that ground every
assumption against the code. Ready for a final human read before implementation.
Companion: ADR-0001, ADR-27 (thought-audit log — UNIMPLEMENTED), v24 PRD.

> Everything below marked **(net-new)** does not exist today and must be built;
> the original draft wrongly described several as "reuse existing behavior."

## Problem (corrected)

OB1 has no application-level delete. A complete removal touches three stores:
1. Postgres `thoughts` (the row)
2. Postgres `thought_graph_projection_state` — **but** its `thought_id` FK is
   `ON DELETE CASCADE` (004:2), so a hard delete of the `thoughts` row removes
   this row **automatically** in the same transaction.
3. Neo4j `(:Thought {canonical_id:'thought:<uuid>'})` node + its edges.

So a raw `delete from thoughts` (what the smoke scripts do) cascade-clears (2) and
**only orphans (3), the Neo4j node** — and worse, deleting the PG row first
destroys the only pointer (canonical_id/graph_database) needed to clean (3).

## Model

- **Soft-delete is the default.** Sets `thoughts.deleted_at`. Reversible. It is an
  operational *hide*, **not erasure** — content stays in `thoughts`, the vector
  index, and backups.
- **Purge** is the deliberate, admin-only **hard erasure** (GDPR), Neo4j-first.
- **Consistency is EVENTUAL.** Postgres is the source of truth; the Neo4j side
  converges via the projector loop (interval × batch). The **read-path SQL filter
  (D3), not the projector, is what prevents leaks** during the convergence window.

## Decisions

### D1. `thoughts.deleted_at timestamptz null` (net-new).
Soft-delete sets `deleted_at = now()` (and bumps `updated_at`). Restore clears it.

### D2. Projector deletion path is NET-NEW code (the draft was backwards).
Today: `fetchProjectionCandidates` (graph.mjs:332-376) drives `FROM thoughts LEFT
JOIN projection_state`; `projectThoughtRow` only `MERGE`s (graph.mjs:1494-1526);
**no `DETACH DELETE` exists anywhere**. The revision hash (graph.mjs:305-321)
includes `updated_at` but NOT `deleted_at`, and the `thoughts_updated_at` trigger
(001:50-53) bumps `updated_at` on the soft-delete — so a naive soft-delete makes
the row a candidate and the projector **re-MERGEs (refreshes) the node**. Required:
1. Add `deleted_at` to `projectionRevisionSql` inputs so delete/restore are
   detected deterministically (not via the fragile `updated_at` path).
2. Branch `projectThoughtRow`: if `deleted_at IS NOT NULL` →
   `MATCH (n:Thought {canonical_id:$cid}) DETACH DELETE n`, then **DELETE** the
   `projection_state` row (not a status flag — a lingering row keeps the candidate
   join alive). `DETACH DELETE` removes the Thought's edges but leaves shared
   neighbour nodes (Concept/Person) — acceptable, they're shared; state it.
3. A **separate** orphan sweep for hard-deleted rows (D8) — the `FROM thoughts`
   candidate query structurally cannot see a vanished row.
4. **Re-check before write:** the delete branch must `select deleted_at from
   thoughts where id=$1` immediately before `DETACH DELETE` and skip if NULL
   (guards the restore-vs-projector race).
5. **SLA:** Neo4j removal lags by `projectorIntervalSeconds × backlog` and can
   stall on a persistently-failing row. Optionally trigger an immediate targeted
   `projectThoughts({thoughtIds:[id]})` on delete to shrink the window. D3 (not
   this) is what makes reads safe during the lag.

### D3. Read-path filtering — complete inventory, SQL-level, fail-closed.
A soft-deleted row must be invisible to **every** read. The filter MUST be inside
each SQL function **before its `LIMIT`** (a JS post-filter silently shrinks results
below `match_count` and lets a tombstone occupy a slot). Preferred enforcement: a
`thoughts_live` view (`select * from thoughts where deleted_at is null`) that every
function/query reads from — but each must still be re-issued in a migration
(plpgsql copies SQL by value). **Complete must-filter set (verified):**

SQL RPCs (re-issue via migration):
- `match_thoughts` (005:145-182)
- `match_thoughts_recency` (008:29-101) — a *separate* function used when `recency_weight>0`
- `list_recent_thoughts` (005:206-208)
- `thoughts_stats` (005:213-228)
- `search_thoughts_text`, `brain_stats_aggregate`, `get_thought_connections`
  (006) — currently **dormant + also missing brain scoping**; filter or formally
  deprecate so a future caller can't reintroduce a leak.
- `graphProjectionStats` count (graph.mjs:1626) — decide if tombstones count.

Raw JS queries (edit directly):
- `brainStats` inline source/type/people counts (server.mjs:776, 786, 798)
- `updateThoughtMetadata` `… RETURNING` (server.mjs:650-669) — decide: patching a
  soft-deleted thought should 404.
- **`fetchThoughtRowsByIds` (retrieval.mjs:303-355) — #1 must-not-miss.** Both
  branches (~328, ~347). It re-hydrates content for graph-neighbor IDs and is
  reached by `ask_brain` graph-assisted (`expandThoughtsWithGraph`→
  `retrieveEvidenceRows`, server.mjs:476) and `expand_context`
  (`expandContextRows`, retrieval.mjs:1018). Callers pass `filter:{}`, so the
  metadata filter can't save it.

**ANN index:** also make the HNSW index partial `WHERE deleted_at IS NULL`
(rebuild `thoughts_embedding_hnsw_idx`, 001:37-38) so deleted rows leave the ANN
graph entirely — a `WHERE` filter runs *after* the ANN traversal and costs recall.

Acceptance must assert absence per-surface (search, recency-search, list, stats
**counts**, ask_brain graph-assisted, expand_context), not "one predicate covers all."

### D4. Authorization is NET-NEW (the draft's "mirror metadata" was unsafe).
`/admin/thought/metadata` does NO role/admin check (server.mjs:1190-1211) — the
`/admin/` prefix is cosmetic; any valid key passes. `role` is free-text with no
CHECK (005:57, 009:8-10 "recorded but NOT enforced"), and `resolveRequestBrain`
returns only `{brainId,brainSlug}` (auth.mjs:526) — no role reaches the handler.
Required:
1. Add a CHECK/enum on `brain_memberships.role` (and `estate_memberships.role`) and
   pin canonical strings (`owner`/`editor`/`viewer`; estate `admin`). (net-new)
2. A delete-authorization query keyed by `(principalId, resolvedBrainId)`:
   allow if brain role = `owner`, OR estate role = `admin`, OR `accessContext.isAdmin`.
   Deny editors/viewers. (net-new — there is no role check in the codebase today.)
3. There is **no creator column** on `thoughts`, so "creator-or-owner" is
   unbuildable without adding one — decide owner-only vs add `created_by`.
4. Scope by `id AND brain_id` with 404-if-absent — reuse the metadata predicate
   (server.mjs:652-674), which is the one part that *does* transfer.

### D5. Audit table is NET-NEW (ADR-27 unimplemented).
No audit table exists (`grep audit` → 0). Create `thought_audit`:
`(id uuid pk default gen_random_uuid(), thought_id uuid NOT NULL /* NOT a FK to
thoughts — else purge erases its own trail */, brain_id uuid, actor jsonb NOT NULL,
action text NOT NULL check (action in ('delete','restore','purge')), at timestamptz
not null default now(), old_state jsonb)`. Rules:
- Written in the **same transaction** as the soft-delete/restore (records *intent*
  at T; graph convergence is async and NOT reflected by this row).
- `actor` must be non-null even for legacy-admin (`principal_id` is NULL there,
  auth.mjs:445) — record `{auth_source, key_id?, principal_id?}` so the
  highest-privilege caller is attributable.
- `old_state` snapshots enough to support recovery (for purge: content+metadata).
- **Append-only:** revoke UPDATE/DELETE on `thought_audit` from the app role (or a
  blocking trigger) — otherwise the principals D4 constrains can erase the evidence.
- For **purge**, emit the audit row only after the Neo4j `DETACH DELETE` succeeds
  (or a second `purge_graph_complete` event) so erasure claims are truthful.

### D6. dedupe unique index → partial, with the matching capture change.
Current index is plain: `thoughts_brain_dedupe_key_idx (brain_id, dedupe_key)`
(005:136-137) → a tombstone blocks re-capture. Migration must `DROP INDEX` then
`CREATE UNIQUE INDEX … (brain_id, dedupe_key) WHERE deleted_at IS NULL`. **Coupled
app change (required or capture throws):** capture's `on conflict (brain_id,
dedupe_key) do update` (server.mjs:281-289) must become `on conflict (brain_id,
dedupe_key) WHERE deleted_at IS NULL do update` — a bare `ON CONFLICT` will not
match a partial index. **Resurrection rule (pick one, write it down):** a re-capture
of a soft-deleted key creates a **new** row (tombstone + live row coexist) — so all
delete/restore/purge key on **`thought_id`, never `dedupe_key`** (the projector's
`--dedupe-key` and D8 must handle multiple rows per key). Capture's `do update`
must NOT clear `deleted_at` (a delete that commits first stays deleted).

### D7. Surfaces, idempotency, purge ordering.
- `delete_thought(thought_id, brain?)` — soft-delete; HTTP only; idempotent
  (already-deleted → 200). Scoped `id AND brain_id`, 404 if not in chosen brain.
- `restore_thought(thought_id, brain?)` — clears `deleted_at`; **its own, stricter
  authorization** (operator/admin) and a loud audit row — restore re-exposes
  previously-suppressed content across every read surface and graph node.
- `purge_thought(thought_id, brain?)` — admin-only hard erasure. **Order: (1)
  compute `canonical_id` while the PG row exists, (2) `DETACH DELETE` Neo4j, (3)
  only then `DELETE FROM thoughts` (cascade clears projection_state).** If Neo4j is
  unreachable, **abort before the PG delete** so the pointer survives. Re-run must
  accept a `thought_id` whose PG row is already gone and DETACH-DELETE Neo4j
  unconditionally (so PG-first-orphans from past raw deletes are cleanable) — i.e.
  purge does NOT 404 when only graph residue remains.

### D8. Orphan reconcile — Neo4j-driven (the cascade destroys the PG pointer).
Because `projection_state` cascade-deletes with the thought, the worst orphans
(Neo4j node, no PG row, no projection_state) can only be found by **scanning Neo4j**:
enumerate `(:Thought)`, extract `thought_id` from `canonical_id`, `DETACH DELETE`
any whose id is absent from `thoughts` OR has `deleted_at` set. Batch/limit (full
graph scan). One-time pass clears past smoke-script debris; recurring pass surfaces drift.

### D9. Guardrails / blast radius (net-new policy).
- **Agents (MCP) get soft-delete only — never purge.** Do **not** register
  delete/restore/purge as MCP tools initially (buildMcpServer is unconditional;
  every agent key would get them). Operator/HTTP-only. Revisit MCP exposure later
  behind an explicit `isAdmin`/owner gate at tool registration.
- **Legacy-admin destructive policy:** the bare `MCP_ACCESS_KEY` is global,
  cross-household, `principal_id=null`. Either deny destructive ops to the bare
  legacy key (require a named stored `is_admin` key with a principal), or scope it;
  forbid purge from the bare key. Document the blast radius next to the guardrail.
- **Purge requires a confirmation arg** (e.g. expected `content_hash` or
  `dedupe_key`) so a wrong id fails closed.
- No bulk / delete-by-query (handler takes a single `thought_id`); add a per-principal
  rate limit on destructive ops.

## Concurrency rules (must be specified, not discovered)
- **capture vs soft-delete (same key):** capture's `do update` does NOT touch
  `deleted_at`; with the partial index a post-delete capture creates a new live
  row (tombstone persists). Define winner by the row lock on `(brain_id,dedupe_key)`.
- **restore vs projector delete pass:** projector re-checks `deleted_at` immediately
  before `DETACH DELETE` and skips if cleared (D2.4); `deleted_at` in the revision
  hash re-enqueues a re-projection after restore.
- **purge partial failure:** Neo4j-first + abort-before-PG (D7) makes it re-runnable.

## GDPR / side channels
Soft-delete ≠ erasure. True erasure = purge + a backups-retention policy.
Retrieval telemetry JSONL (observability.mjs:179/181/101) persists thought ids and
query previews append-only, outside the `deleted_at` guarantee — declare it in/out
of erasure scope and define a scrub/retention policy.

## Acceptance (per-surface, post-review)
1. Capture → soft-delete → the thought is absent from: `search` (incl.
   `recency_weight>0`), `list`, `stats` **counts**, `ask_brain` graph-assisted
   citations, and `expand_context` (the last two specifically exercise
   `fetchThoughtRowsByIds`). Its Neo4j node is gone within one projector interval.
2. An audit row exists (with a non-null actor even for legacy-admin); restore
   brings it back everywhere and is itself audited.
3. Re-capture with the same `dedupe_key` after soft-delete succeeds (new row id);
   capture does not throw on the partial index.
4. A non-owner/editor key is denied delete (403); `/admin/` prefix alone does not authorize.
5. Purge leaves zero residue in all three stores, is re-runnable even when only
   Neo4j residue remains, and Neo4j-first ordering survives a Neo4j outage without
   losing the pointer.

## Implementation phasing (suggested)
M1 schema (deleted_at + partial indexes + thought_audit + role CHECK) →
M2 read-path filter sweep (the D3 inventory) + tests →
M3 soft-delete/restore handlers + authz + audit →
M4 projector delete path + targeted projection →
M5 purge + D8 reconcile + the one-time orphan cleanup. Each lands with the same
implement → app.request verify → independent-verifier loop used for v24.
