# ADR: Thought Audit Log — Build the Log Before Editing Capability

Date: 2026-06-02
Status: Accepted
Decision-makers: luchoh
Companion: PRD `25-upstream-port-roadmap.md` §2.1, survey doc `24-upstream-port-survey.md`
Supersedes: nothing

## Status

Accepted. To be implemented as the next Tier 2 item.

## Context

OB1 currently has **no edit, no delete, and no history** for stored
thoughts. The codebase has only one write path that meaningfully mutates
existing rows: `upsertThought` in `local/open-brain-mcp/src/server.mjs`,
which uses `dedupe_key` to merge re-captures into existing rows. There
is also an admin-only `/admin/thought/metadata` HTTP endpoint that
patches `metadata` jsonb (not exposed as an MCP tool, used rarely),
and the Telegram review flow's "Edit" button — but Edit operates only
on the in-session review-state JSON file *before* a thought is
committed, never on stored rows.

We have multiple writers: the Telegram bridge, the Node MCP server's
`capture_thought` tool, the FastAPI document/dictation ingest path,
and (per recent work on the autodream-brain-sync skill) Claude Code
sessions writing through MCP. Today, when a thought lands in the
brain, the only signal of *who wrote it and when something changed* is
the convention of stamping `metadata.source` — informally, not
enforced.

The roadmap (verbal commitment from the owner, June 2026) is that we
**will eventually edit thoughts**. Possible upcoming editors include:

- An MCP `update_thought` tool exposed to agents.
- A Telegram "Edit recorded" path for thoughts already committed
  (today only pre-commit edits work).
- A future dashboard or CLI for manual curation.
- Backfill / enrichment scripts that mutate `type`, `metadata.topics`,
  `metadata.people`, `sensitivity_tier`, etc. on existing rows
  (e.g. the planned thought-enrichment port from PRD §2.3).

Once any of these exist, "what changed in this thought" becomes a
question we cannot answer retroactively if we have not been logging
all along. There is no Postgres equivalent of `git log` for a row
unless we explicitly keep one.

Upstream `NateBJones-Projects/OB1` ships `schemas/thought-audit` for
exactly this reason. Their assessment in our survey:

> Vanilla Postgres (UUID PK, JSONB diff, three indexes, CHECK
> constraint). Genuinely additive — no triggers, no FK, no
> Supabase-specific extensions. Port blockers are cosmetic: drop the
> `ENABLE ROW LEVEL SECURITY` line and the `GRANT ... TO
> service_role`. Add a `brain_id UUID NOT NULL` for our multi-tenant
> model, plus an index on `(brain_id, created_at DESC)`. High value
> because we already have multi-writer traffic with no provenance
> trail; the append-only delete-recovery property is exactly what a
> personal brain needs.

The cost surface, broken down:

- **Schema cost:** ~30 minutes — a single migration adding one table,
  three indexes, one CHECK constraint, no triggers, no FKs.
- **Writer wiring cost:** ~half a day — every place that does
  INSERT / UPDATE / DELETE on `thoughts` must emit a corresponding
  audit row. Today that is exactly two call sites: `upsertThought`
  (the MCP / Telegram / FastAPI ingest funnel) and
  `updateThoughtMetadata` (the admin endpoint).
- **Storage cost:** small. Each audit row is ~1KB worst case (JSONB
  diff plus indexed columns); at our current write rate (~6,747 rows
  in 2.5 months) we are looking at <100MB/yr even with diff bodies.
- **Retention cost:** open. We are choosing not to define a retention
  policy now; the table is designed to grow. If it becomes large later,
  we add a partitioning or pruning policy then.

## Decision

**Adopt `schemas/thought-audit` from upstream as a Postgres migration
in this repo, paired with writer wiring at every existing write site,
*before* introducing any user-facing edit/delete capability.**

Specifically:

1. Land the audit table as the next Tier 2 implementation
   (PRD §2.1).
2. Wire `upsertThought` in `local/open-brain-mcp/src/server.mjs` to
   emit an audit row on every INSERT and on every on-conflict UPDATE,
   distinguishing the two via the `action` column.
3. Wire `updateThoughtMetadata` (the admin patch path) to emit an
   audit row on every metadata UPDATE.
4. The Telegram bridge does **not** need its own wiring — it writes
   exclusively through the MCP / FastAPI ingest path that funnels
   through `upsertThought`, so wiring `upsertThought` once covers it.
5. Add `brain_id` to the table per universal porting fix #5 (multi-
   tenancy in the data layer; PRD §"Universal porting steps").
6. Strip Supabase RLS / role grants per universal fixes #1–#3.
7. Adopt the `metadata.author_session_id` convention from upstream:
   every writer stamps a session identifier into thought metadata, and
   the audit row copies that field on each write. Conventions:
   - Telegram bridge: `telegram_bridge:<chat_id>:<message_id>`
   - MCP `capture_thought` tool: `mcp:<connection_id>` (or whatever
     the SDK exposes; if nothing identifying is available, fall back
     to a UUID per process boot)
   - FastAPI ingest: `fastapi:<request_id>`
   - Autodream-brain-sync skill: `claude_code:<session_uuid>`
8. Future edit / delete capabilities (e.g. `update_thought` MCP tool,
   `delete_thought` MCP tool, dashboard curation) MUST emit audit
   rows. This is now part of the contract for adding any new write
   surface to `thoughts`.

We are explicitly **not**:

- Building edit / delete capabilities in this work item. The audit
  table is infrastructure for a future commitment, not a current
  feature.
- Defining a retention policy. The table grows unbounded; revisit when
  it crosses ~10M rows or ~10GB, whichever first.
- Implementing "revert to row N" or any form of replay-from-log. The
  data is in the right shape if we want to add this later, but it is
  not part of this work.
- Adding row-level encryption or sensitivity-aware redaction of `diff`
  bodies. If a sensitive row's content was in the audit `diff`, it
  stays in `diff`. (Future ADR if this becomes a privacy issue.)

## Schema sketch

```sql
create table if not exists thought_audit (
  id uuid primary key default gen_random_uuid(),
  brain_id uuid not null,
  thought_id uuid not null,
  action text not null,
  diff jsonb not null default '{}'::jsonb,
  author_session_id text,
  created_at timestamptz not null default now(),
  constraint thought_audit_action_check
    check (action in ('capture', 'update', 'delete'))
);

create index if not exists thought_audit_thought_id_created_at_desc
  on thought_audit (thought_id, created_at desc);

create index if not exists thought_audit_brain_id_created_at_desc
  on thought_audit (brain_id, created_at desc);

create index if not exists thought_audit_author_session_id
  on thought_audit (author_session_id)
  where author_session_id is not null;
```

Notes:

- No FK to `thoughts(id)`. **Intentional.** The audit row must
  outlive a hard `DELETE FROM thoughts`. With a FK + CASCADE, deleting
  a thought would erase its history. Without a FK + RESTRICT,
  deleting a thought would fail. Without any FK, deleting a thought
  leaves the audit history intact, which is the desired property.
- `diff` defaults to `{}` so an empty payload is valid and the column
  is non-null-tractable.
- `created_at` is set server-side. We do not let writers supply their
  own timestamps; the log is monotonic per row.

## Consequences

### Positive

- **Provenance.** Once writers are wired, every existing row will
  have a clear "who wrote this and when" trail going forward (rows
  written before the migration are not retroactively logged — they
  appear in the table only when they next change).
- **Delete-recovery.** When we add deletion, the last-known content
  is preserved in the audit `diff`. We can build a "what was thought
  X?" lookup against the log even after the row is gone from
  `thoughts`.
- **Multi-writer accountability.** When a thought has wrong type or
  unexpected content, we can answer "which writer produced this?"
  Currently we cannot.
- **Editor sanity.** Once we add `update_thought`, we get an automatic
  history view: "show me how this thought has evolved." No further
  schema work needed.

### Negative

- **Write amplification.** Every write to `thoughts` now produces a
  second write to `thought_audit`. At our scale this is negligible
  (<2x cost on writes that are already cheap), but it is real and we
  should keep an eye on the storage growth rate.
- **Speculative infrastructure.** If editing never materializes, the
  audit log is a write log of captures only — useful, but smaller
  payoff than promised.
- **Convention burden.** Every new writer added to the system must
  remember to emit an audit row, and to stamp `author_session_id`.
  This is enforceable today only by code review (or by funneling all
  writes through a single helper like `upsertThought`, which we
  partially do).

### Mitigation

- We will document the writer contract once, in this ADR (above) and
  in `WORKING_AGREEMENT.md` if we decide it is load-bearing enough.
- For future edit/delete work, we treat "emits audit row" as a
  blocking review criterion, not a courtesy.

## Alternatives considered

### A. Defer until editing exists

Wait to land the audit log until the first editor (e.g. an MCP
`update_thought` tool) is in flight. **Rejected** because:

- We lose the captures-already-happening from now until then.
- Once the editor exists, we'll be tempted to ship it without the log
  for "just one release," and that release becomes the gap in
  history.
- The schema is so small that landing it ahead is cheaper than the
  coordination cost of landing them together.

### B. Schema-only, no writer wiring

Land the migration but defer the writer-wiring work. **Rejected**
because: the table sits empty until writers populate it, and the
writer wiring is the work that proves the design holds end-to-end.
Splitting the two means a second handoff later for ~half a day of
work that we could do once now. The schema-only commit on its own
provides essentially zero value.

### C. Use a Postgres trigger to populate the audit table automatically

Have an `AFTER INSERT/UPDATE/DELETE` trigger on `thoughts` populate
`thought_audit` itself. **Rejected** because:

- The trigger does not have access to `author_session_id` unless we
  pass it through `metadata` first, which means writers still need to
  stamp metadata — same convention burden, plus a trigger.
- Triggers couple our app's behavior to DDL state in a way that is
  surprising during migrations; if a trigger were ever broken or
  disabled, all writes would silently lose audit coverage and we
  would not notice.
- Explicit writer wiring is more legible to a reader of the codebase.

We may revisit this decision if we ever add a writer that we cannot
modify (e.g. a third-party tool writing directly to the DB).

### D. Use CDC (logical replication, e.g. wal2json) to capture all changes off the WAL

**Rejected** for now: more infrastructure than the problem warrants,
and equally lacks `author_session_id` without metadata stamping.
Reasonable to revisit if we ever need cross-system replication.

### E. Adopt upstream `integrations/update-thought-mcp` and `delete-thought-mcp` as well

**Deferred.** Survey doc 24 placed both in the "Skip — Supabase-shaped
runtime" tier. We will eventually need our own equivalents (MCP tools
for edit/delete), but they are out of scope for this work item. This
ADR sets the precondition that whenever we do build them, they must
emit audit rows.

## Implementation plan (handoff to Tier 2.1)

1. ☐ Create migration `009_thought_audit.sql` per the schema sketch
   above. Apply universal porting fixes (#1, #2, #3) — i.e. drop any
   upstream RLS / role grant / NOTIFY pgrst lines, add `brain_id`,
   create table + 3 indexes + CHECK.
2. ☐ Apply via `ob1-migrate` to `ob1_dev`. Verify table structure and
   indexes via `\d+ thought_audit`.
3. ☐ Modify `upsertThought` in `local/open-brain-mcp/src/server.mjs`
   to emit an audit row inside the same transaction. Distinguish
   `action='capture'` (INSERT path) from `action='update'`
   (on-conflict path) using the `xmax` trick or a returning clause.
4. ☐ Modify `updateThoughtMetadata` in the same file to emit an audit
   row with `action='update'`.
5. ☐ Stamp `author_session_id` from `accessContext` (or a request-
   scoped identifier) on every audit insert. Source-row stamping in
   the bridge / FastAPI / autodream is a follow-up that can land
   incrementally as each writer is touched.
6. ☐ Smoke-test on `ob1_dev`:
   - Capture a new thought via MCP — verify one audit row with
     `action='capture'`.
   - Re-capture with the same `dedupe_key` — verify one more audit
     row with `action='update'` and a meaningful `diff`.
   - Patch metadata via `/admin/thought/metadata` — verify one audit
     row with `action='update'`.
7. ☐ Commit + push.
8. ☐ **Out of scope, tracked separately:** stamping
   `author_session_id` consistently across all writer entry points
   (Telegram bridge, FastAPI ingest, autodream). Future task.

## Open questions

None blocking the implementation. The retention policy and the
convention enforcement question are flagged in §Consequences and can
be revisited after first user.
