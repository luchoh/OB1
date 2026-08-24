-- 022_thought_content_revisions.sql
-- Content versioning: make an in-place overwrite of a thought RECOVERABLE.
--
-- WHY THIS EXISTS. `captureThought` upserts on (brain_id, dedupe_key) and its
-- DO UPDATE assigns `content = excluded.content` (thought-store.mjs:179). The
-- row keeps its `id` and `created_at`; only `updated_at` moves. Before this
-- migration there was NO record of the previous content anywhere:
-- `thought_audit.action` was constrained to delete/restore/purge (012:52), so an
-- EDIT was never audited, and `patchThoughtMetadata` emitted no audit row at
-- all. An overwrite was therefore both unrecoverable and undetectable.
-- That becomes load-bearing the moment a caged agent holds `editor` on the
-- operator's personal brain: the dedupe key defaults to sha256(content)
-- (thought-store.mjs:88-95), so any writer can address — and silently rewrite —
-- any row whose content it can read.
--
-- WHY A TRIGGER AND NOT A CTE IN THE STORE. The obvious design is a `prior` CTE
-- alongside the upsert, reading the row before overwriting it. It is WRONG under
-- concurrency and would produce a version history that quietly lies. All
-- sub-statements of a data-modifying CTE share ONE snapshot, but
-- INSERT ... ON CONFLICT DO UPDATE in READ COMMITTED may update a row version
-- created or modified by a concurrent transaction that the snapshot never saw.
-- Interleaving: T1's `prior` sees nothing (or version A); T2 inserts/updates the
-- same live dedupe key to B and commits; T1's upsert then overwrites B with C.
-- T1 would record "no prior" or A, while B is what was actually destroyed.
-- An AFTER UPDATE trigger sees the real OLD row it is replacing, always.
--
-- The trigger also leaves `captureThought`'s statement completely untouched, so
-- none of its guarantees can be broken by this change: the §6.10 tier guard
-- (:209), the shared-brain ownership backstop (:216-220), the monotone
-- origin/trust/review labels (:185-207), the zero-rows-means-NOT_FOUND
-- fail-closed shape, and the RETURNING projection its callers destructure.
--
-- WE REUSE `thought_audit` RATHER THAN ADDING A TABLE. It is already exactly the
-- right shape and already hardened: `old_state jsonb` for the prior row,
-- append-only via `thought_audit_append_only_trg` (012:80-88), and `thought_id`
-- deliberately NOT a foreign key so the trail outlives a purge of its own
-- subject (012:40-46). `old_state` is ALREADY action-dependent — delete/restore
-- store tombstone state, purge stores content and hashes — so a revision payload
-- is not a new shape for this column, just a fourth one.

-- ============================================================
-- a. allow the new action
-- ============================================================

alter table thought_audit drop constraint if exists thought_audit_action_check;

alter table thought_audit
  add constraint thought_audit_action_check
  check (action in ('delete', 'restore', 'purge', 'update'));

-- ============================================================
-- a2. a monotonic ordering key
--
-- `at` alone cannot order a history. It defaulted to now() — the TRANSACTION
-- timestamp — so two revisions of one thought in one transaction were byte
-- identical; the trigger below uses clock_timestamp() instead, which fixes that
-- but is still WALL CLOCK: values can tie at microsecond precision and can move
-- backwards under NTP adjustment. A version history whose order is approximate
-- is not a version history. `seq` is the total order; `at` stays for humans.
-- ============================================================

-- OPERATIONAL NOTE, because this is not a casual additive column: bigserial is
-- backed by a nextval() default, which is volatile, so this ALTER rewrites the
-- table under ACCESS EXCLUSIVE rather than taking the cheap
-- constant-default fast path. On prod's ~900 audit rows that is instantaneous,
-- but it is a lock on the audit table and belongs in a normal pinned release,
-- not a hand-run migration during traffic.
--
-- Historical delete/restore/purge rows also receive seq values. Those numbers
-- are assignment order, NOT the order those events happened; nothing reads them,
-- because the revision index below is partial on action = 'update'.
alter table thought_audit add column if not exists seq bigserial;

-- ONE index, on seq. An earlier draft also added (thought_id, at desc) with the
-- same partial predicate; every revision then paid to maintain two indexes
-- answering the same question, and the `at` ordering is the approximate one.
-- Every reader — including the tests — orders by seq.
create index if not exists thought_audit_revisions_seq_idx
  on thought_audit (thought_id, seq desc)
  where action = 'update';

-- ============================================================
-- b. the revision trigger
--
-- ACTOR. `thought_audit.actor` is NOT NULL, and a trigger cannot know the
-- caller. The application announces it per-transaction with
-- `set_config('ob1.actor', <json>, true)` — the `true` makes it transaction
-- scoped, which matters because the pool reuses connections and a session-scoped
-- value would leak the previous caller's identity onto the next writer's rows.
--
-- When the setting is absent or malformed the mutation is REFUSED — see the
-- fail-closed block in the function body for why. (An earlier draft recorded a
-- sentinel actor instead; that is gone, and this comment says so because dead
-- documentation describing the opposite behaviour is how a decision gets
-- quietly reversed six months later.)
-- ============================================================

create or replace function thought_record_revision()
returns trigger
language plpgsql
as $$
declare
  actor_raw  text := current_setting('ob1.actor', true);
  actor_json jsonb;
  reason     text;
begin
  begin
    actor_json := nullif(actor_raw, '')::jsonb;
  exception when others then
    actor_json := null;
    reason := 'invalid_json';
  end;

  -- Validate the FULL descriptor shape (access-policy.mjs makeActor:
  -- {auth_source, principal_id, is_admin}), not merely "is it an object".
  --
  -- `is distinct from`, NOT `<>`. A missing key yields SQL NULL from `->`, so
  -- `jsonb_typeof(null) <> 'string'` is NULL rather than true, the OR chain
  -- evaluates to NULL rather than true, and the branch never fires — `{}` sailed
  -- straight through when this was written with `<>`. The test for exactly that
  -- case is what caught it.
  if reason is null then
    reason := case
      when actor_raw is null then 'missing'
      when jsonb_typeof(actor_json) is distinct from 'object' then 'invalid_shape'
      when jsonb_typeof(actor_json -> 'auth_source') is distinct from 'string'
        or actor_json ->> 'auth_source' = '' then 'invalid_shape'
      -- NOT `not in ('string','null')`. A MISSING principal_id makes `->` return
      -- SQL NULL, jsonb_typeof(NULL) is NULL, and `NULL not in (...)` is NULL —
      -- the CASE arm is not taken and the malformed actor is accepted. That is
      -- the same three-valued-logic trap as the auth_source check above, and it
      -- was reintroduced here three lines below the fix for it. Both arms must be
      -- null-safe or fail-closed does not actually fail closed.
      when jsonb_typeof(actor_json -> 'principal_id') is distinct from 'string'
       and jsonb_typeof(actor_json -> 'principal_id') is distinct from 'null' then 'invalid_shape'
      when jsonb_typeof(actor_json -> 'is_admin') is distinct from 'boolean' then 'invalid_shape'
      else null
    end;
  end if;

  if reason is not null then
    -- FAIL CLOSED. An earlier revision of this migration recorded the change
    -- under an 'unattributed' sentinel instead, on the reasoning that losing the
    -- prior content is worse than losing the writer's name. Review rejected that
    -- twice and was right: the warning fires AFTER the write decision, so if
    -- logging is dropped or ignored you keep a permanent unattributed edit; the
    -- metadata route has no row-level writer attribution of its own, so an
    -- unwired path there yields recoverable state with no actor at all — half a
    -- forensic record; and "only two call sites today" argues for making the
    -- invariant strict now rather than leaving a bypass for the third one.
    -- A failed write is loud and fixed in minutes. An unattributed edit is
    -- permanent.
    --
    -- Deliberate maintenance writes are not blocked — they announce themselves
    -- the same way everything else does:
    --   select set_config('ob1.actor',
    --     '{"auth_source":"system_maintenance","principal_id":null,"is_admin":true}', true);
    --
    -- The message carries the thought id and a REASON CLASS only. It must never
    -- echo `actor_raw`: that value is caller-controlled, and the invalid case is
    -- precisely where it cannot be assumed non-secret — a token, personal data,
    -- newlines or terminal-control bytes would land in the Postgres log, and
    -- truncating it does not make log injection safe.
    raise exception
      'ob1: refusing to mutate thought % without a valid audit actor (reason: %); '
      'set ob1.actor for this transaction — see migration 022',
      old.id, reason
      using errcode = 'insufficient_privilege';
  end if;

  -- This is a VERSION PAYLOAD (schema 1), not a complete row image — say what it
  -- is so nobody restores from it assuming otherwise. Deliberately absent:
  -- `embedding` (1536 floats ≈ 6 KB per row, and fully derivable from the
  -- content we do keep — so restoring a revision requires re-embedding), and
  -- `id` / `brain_id`, which are columns on the audit row itself. `brain_id` and
  -- `created_at` on `thoughts` are not tracked and this payload does not pretend
  -- to. `brain_id` is NOT untouched, either: scripts/bootstrap-open-brain-
  -- household.sh:338-345 runs `update thoughts set brain_id = ... where brain_id
  -- is null`. It is a one-time bootstrap adoption of pre-multitenancy rows, it
  -- carries no actor, and because brain_id is outside the WHEN clause it does not
  -- fire this trigger at all. Named here as a known untracked mutation path
  -- rather than left as a false claim that none exists.
  -- `at` is set EXPLICITLY to clock_timestamp() rather than left to the column
  -- default of now(). now() is the TRANSACTION timestamp, so two revisions of
  -- the same thought inside one transaction would carry byte-identical `at`
  -- values and the history would be unorderable — which defeats the purpose of
  -- keeping one. clock_timestamp() advances within a transaction. Only revision
  -- rows are changed; delete/restore/purge keep the 012 default, since those are
  -- one-per-transaction lifecycle events where now() is the more honest value.
  insert into thought_audit (thought_id, brain_id, actor, action, at, old_state)
  values (
    old.id,
    old.brain_id,
    actor_json,
    'update',
    clock_timestamp(),
    jsonb_build_object(
      '_schema',                 1,
      'content',                 old.content,
      'content_hash',            old.content_hash,
      'dedupe_key',              old.dedupe_key,
      'metadata',                old.metadata,
      'type',                    old.type,
      'source_type',             old.source_type,
      'importance',              old.importance,
      'quality_score',           old.quality_score,
      'enriched',                old.enriched,
      'status',                  old.status,
      'status_updated_at',       old.status_updated_at,
      'sensitivity_tier',        old.sensitivity_tier,
      'origin_egress_class',     old.origin_egress_class,
      'source_trust_class',      old.source_trust_class,
      'review_state',            old.review_state,
      'written_by_principal_id', old.written_by_principal_id,
      'written_by_key_id',       old.written_by_key_id,
      'embedding_model',         old.embedding_model,
      'embedding_dimension',     old.embedding_dimension,
      'created_at',              old.created_at,
      'updated_at',              old.updated_at
    )
  );

  return null;  -- AFTER trigger; return value is ignored
end;
$$;

-- The WHEN clause is the no-op filter, evaluated by the executor before the
-- function is called at all.
--
-- `updated_at` is EXCLUDED on purpose: `thoughts_updated_at` (001:39-53) is a
-- BEFORE UPDATE trigger that stamps now() on every single update, so including
-- it would make every comparison unequal and version every no-op write. The
-- ingest daemons re-import idempotently and the enrichment scripts patch in
-- bulk; without this filter a single enrichment run would write a revision per
-- thought and the history would be almost entirely noise.
--
-- `deleted_at` is excluded because soft-delete and restore already emit their
-- own audit rows (thought-store.mjs:473, :522); a tombstone flip is a lifecycle
-- event, not a content revision, and must not produce both.
--
-- The embedding columns are excluded because a re-embed with identical content
-- is not a revision of anything a reader would want back.
drop trigger if exists thoughts_record_revision on thoughts;

create trigger thoughts_record_revision
  after update on thoughts
  for each row
-- written_by_* AND dedupe_key are INCLUDED, and their absence was a real hole.
-- The capture upsert reassigns attribution to the latest writer even when the
-- content is byte-identical (thought-store.mjs:222-225,
-- `written_by_principal_id = coalesce(excluded..., thoughts...)`). Omitting them
-- meant one principal could take ownership of another's row with no record —
-- precisely the takeover this whole feature exists to make recoverable. And
-- `dedupe_key` decides which row a future capture overwrites, so a change to it
-- is a change to the row's identity; it was already being stored in the payload,
-- which made excluding it from detection simply incoherent.
  when (
    row(
      old.content, old.metadata, old.type, old.source_type, old.importance,
      old.quality_score, old.enriched, old.status, old.sensitivity_tier,
      old.origin_egress_class, old.source_trust_class, old.review_state,
      old.written_by_principal_id, old.written_by_key_id, old.dedupe_key
    )
    is distinct from
    row(
      new.content, new.metadata, new.type, new.source_type, new.importance,
      new.quality_score, new.enriched, new.status, new.sensitivity_tier,
      new.origin_egress_class, new.source_trust_class, new.review_state,
      new.written_by_principal_id, new.written_by_key_id, new.dedupe_key
    )
  )
  execute function thought_record_revision();

-- The revision lookup index lives in section a2 alongside `seq`, since it is
-- the column that makes the ordering meaningful. Nothing further is needed here.
