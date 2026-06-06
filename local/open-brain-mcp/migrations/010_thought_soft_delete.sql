-- 010_thought_soft_delete.sql
-- M1 of the thought-deletion spec (docs/32-thought-delete-decision.md, D1 + D6).
-- Scope here is intentionally narrow: add the soft-delete column and make the
-- dedupe unique index partial so a tombstone no longer blocks re-capture.
-- Audit table / role CHECK / HNSW partial index are deferred to later milestones.
--
-- Additive, idempotent, and safe to re-run.
--
-- PROD APPLY NOTE: the DROP + plain CREATE UNIQUE INDEX below takes an
-- ACCESS EXCLUSIVE lock on `thoughts` for the rebuild (sub-second on dev's ~6.7k
-- rows, but a brief capture/read stall on the larger prod `ob1` table). Apply in a
-- low-traffic window, OR for prod run the index step out-of-band with
-- `create unique index concurrently` (outside a txn) and verify indisvalid.
-- The coupled server.mjs change (`on conflict ... where deleted_at is null`) MUST
-- ship together: a partial index without it makes every capture upsert throw.

-- D1: soft-delete marker. Null = live row; non-null = tombstone.
alter table thoughts
  add column if not exists deleted_at timestamptz;

-- D6: the dedupe unique index must only constrain LIVE rows so that a
-- re-capture of a soft-deleted key creates a new row (tombstone + live coexist).
-- `create unique index if not exists` is a no-op when the name already exists,
-- so the existing non-partial index (migration 005) must be dropped first and
-- re-created with the `where deleted_at is null` predicate.
drop index if exists thoughts_brain_dedupe_key_idx;

create unique index thoughts_brain_dedupe_key_idx
  on thoughts (brain_id, dedupe_key)
  where deleted_at is null;
