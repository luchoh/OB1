-- 016_egress_boundary_columns.sql
-- The cloud-egress boundary schema (docs/45 Rev 8, FROZEN). Adds the columns the
-- §6.15 effective-egress policy function consumes, plus the two DB-enforced
-- invariants that prose cannot enforce. PESSIMISTIC + STAGED (Codex v8 F4):
-- new columns are nullable / fail-closed-by-default; existing rows are NEVER
-- silently marked trusted or never-exposed.
--
-- SCOPE (deliberately narrow — one verifiable unit):
--   1. sensitivity_tier: constrain to the frozen enum {standard, restricted}.
--      ('personal' was dropped for v1 by owner decision, docs/45 §17.2.)
--   2. brains.egress_class: the brain-level authorization input (§6.13). Default
--      and backfill the MOST restrictive class (private_local); a known-public
--      brain is reclassified UP later through the protected transition path.
--   3. thoughts.{origin_egress_class, source_trust_class, review_state}: the
--      per-row trust/quarantine axes (§6.11). Nullable: NULL = unknown, which the
--      policy treats as most-restrictive (fail-closed). Existing rows stay NULL —
--      "never silently trusted."
--   4. TRIGGER monotonic origin taint: cloud_origin can never wash to
--      local_trusted (§6.11 F2/F5).
--   5. TRIGGER no-restricted-outside-private_local: a restricted row may live
--      ONLY in a private_local/quarantine_review brain (§5/§9 the v1 invariant).
--
-- DEFERRED to later slices (not added here): max_egress_reached (needs the
-- exposure-event taxonomy, Codex v8 F2); thought_audit action extension; the
-- sink registry. A column without defined write-semantics is not added.

-- ============================================================
-- 1. sensitivity_tier — constrain to the frozen enum
-- ============================================================
-- 006 added it as free-form text default 'standard'. Make it a real boundary.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'thoughts_sensitivity_tier_check'
  ) then
    -- A prior build's metadata-patch route accepted sensitivity_tier='personal'
    -- (z.enum standard|personal|restricted). 'personal' was dropped for v1
    -- (docs/45 §17.2). Map any legacy 'personal' row to 'restricted' (the
    -- most-restrictive equivalent) BEFORE validating the CHECK — otherwise the
    -- full-table validation aborts the whole migration. No-op where none exist.
    update thoughts set sensitivity_tier = 'restricted' where sensitivity_tier = 'personal';
    alter table thoughts
      add constraint thoughts_sensitivity_tier_check
      check (sensitivity_tier in ('standard', 'restricted'));
  end if;
end $$;

-- ============================================================
-- 2. brains.egress_class — the brain-level authorization input (§6.13)
-- ============================================================
-- Fail-closed default: a new brain is private_local until deliberately opened.
alter table brains
  add column if not exists egress_class text not null default 'private_local';

-- Backfill existing brains pessimistically (no-op for fresh column defaults,
-- explicit for clarity): unknown provenance => private_local.
update brains set egress_class = 'private_local' where egress_class is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'brains_egress_class_check'
  ) then
    alter table brains
      add constraint brains_egress_class_check
      check (egress_class in ('public', 'repo', 'private_local', 'quarantine_review'));
  end if;
end $$;

-- ============================================================
-- 3. thoughts trust/quarantine axes — nullable = unknown = fail-closed (§6.11)
-- ============================================================
alter table thoughts
  add column if not exists origin_egress_class text,
  add column if not exists source_trust_class text,
  add column if not exists review_state text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'thoughts_origin_egress_class_check') then
    alter table thoughts add constraint thoughts_origin_egress_class_check
      check (origin_egress_class is null or origin_egress_class in ('local_trusted', 'cloud_origin'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'thoughts_source_trust_class_check') then
    alter table thoughts add constraint thoughts_source_trust_class_check
      check (source_trust_class is null or source_trust_class in ('trusted', 'untrusted'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'thoughts_review_state_check') then
    alter table thoughts add constraint thoughts_review_state_check
      check (review_state is null or review_state in ('none', 'unreviewed', 'reviewed'));
  end if;
end $$;

-- ============================================================
-- 4. Monotonic origin taint — cloud_origin can NEVER wash to local_trusted
-- ============================================================
-- §6.11 F2/F5: taint is the worst-ever contributor, DB-enforced (not app
-- discipline). A later honest local promotion/backfill must not launder a
-- cloud-authored row back to trusted-local.
create or replace function enforce_monotonic_origin_taint()
returns trigger
language plpgsql
as $$
begin
  if old.origin_egress_class = 'cloud_origin'
     and new.origin_egress_class is distinct from 'cloud_origin' then
    raise exception
      'monotonic origin taint: cloud_origin cannot be washed to % (thought %)',
      new.origin_egress_class, new.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists thoughts_monotonic_origin_taint on thoughts;
create trigger thoughts_monotonic_origin_taint
  before update on thoughts
  for each row
  execute function enforce_monotonic_origin_taint();

-- ============================================================
-- 5. No restricted row outside a private_local / quarantine_review brain
-- ============================================================
-- §5/§9 the v1 invariant: while the shared-brain row clamp (Layer B) is v2,
-- restricted content may ONLY live in a Layer-A-isolated brain. Enforced at the
-- row edge so a brain that is (or becomes) cloud-accessible cannot hold one.
create or replace function enforce_restricted_brain_isolation()
returns trigger
language plpgsql
as $$
declare
  brain_class text;
begin
  if new.sensitivity_tier = 'restricted' then
    select egress_class into brain_class from brains where id = new.brain_id;
    if brain_class is null or brain_class not in ('private_local', 'quarantine_review') then
      raise exception
        'restricted thought may live only in a private_local/quarantine_review brain (brain % is %, thought %)',
        new.brain_id, coalesce(brain_class, 'unknown'), new.id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists thoughts_restricted_brain_isolation on thoughts;
create trigger thoughts_restricted_brain_isolation
  before insert or update on thoughts
  for each row
  execute function enforce_restricted_brain_isolation();
