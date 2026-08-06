-- 021_thought_writer_attribution.sql
-- Writer attribution on thoughts. Today the table records WHAT was written and
-- into which brain, but nothing about WHO wrote it: after a bad or hostile write
-- there is no query that answers "which principal produced these rows", and on a
-- brain shared by three agents (020) that question is the whole containment
-- procedure. Without it the only response to one compromised agent is to distrust
-- every row in the brain.
--
-- NULLABLE, AND LEGACY ROWS ARE NEVER RETRO-ATTRIBUTED. Every row written before
-- this migration has an unknown writer. It is tempting to backfill from the
-- brain's sole key or from metadata, but an attribution column is evidence: a
-- guess recorded in the same shape as a fact is indistinguishable from a fact
-- later, and would let a wrong name be used to justify a containment decision.
-- NULL means "unknown", which is the truth, and it stays NULL forever. Readers
-- must treat NULL as unknown, not as trusted.
--
-- ON DELETE RESTRICT on both references, deliberately:
--   * CASCADE would be actively dangerous — deleting a key row would delete the
--     content it wrote, so anyone able to drop their own key could erase the
--     evidence of what they did, which is the exact opposite of the point.
--   * SET NULL would quietly launder attributed rows back to "unknown" on the
--     same event, losing the history while keeping the content.
--   * RESTRICT keeps the record intact and refuses the delete. Attribution must
--     survive REVOCATION, and revocation is is_active = false — a flag flip that
--     RESTRICT does not touch. A key or principal row that authored history is
--     retired, not deleted; if the row genuinely must go, that is a deliberate
--     operator decision that has to confront the attributed rows first.
-- This also matches the house treatment of thoughts as the durable side:
-- thoughts.brain_id is already `on delete restrict` (005).

alter table thoughts
  add column if not exists written_by_principal_id uuid references brain_principals(id) on delete restrict,
  add column if not exists written_by_key_id uuid references brain_access_keys(id) on delete restrict;

-- The containment query is "what did this principal write in this brain", so the
-- brain leads and the principal follows.
create index if not exists thoughts_brain_written_by_principal_idx
  on thoughts (brain_id, written_by_principal_id);
