-- 012_thought_delete_authz_audit.sql
-- M3 of the thought-deletion spec (docs/32-thought-delete-decision.md, D4/D5/D7/D9).
-- Scope: the authorization + audit schema that the soft-delete / restore HTTP
-- handlers depend on. Three concerns, all additive, idempotent, re-runnable:
--   a. role CHECK constraints on brain_memberships / estate_memberships (D4.1).
--   b. thought_audit table (D5) — append-only attribution trail.
--   c. append-only enforcement on thought_audit via a BEFORE UPDATE OR DELETE
--      trigger that RAISEs (portable + role-independent: the dev app connects as
--      the postgres superuser, so a GRANT/REVOKE approach would be bypassed).
--
-- Additive, idempotent, and safe to re-run.
--
-- PROD APPLY NOTE: before applying the role CHECK constraints to prod 'ob1',
-- verify the existing role values there — `select distinct role from
-- brain_memberships;` and `... from estate_memberships;` must be a subset of the
-- allowed sets below, or the ADD CONSTRAINT will fail. Dev 'ob1_dev' currently
-- has only brain role 'owner' and zero estate rows, so it is safe. The is_deny
-- columns are unrelated to these CHECKs.

-- ============================================================
-- a. role CHECK constraints (D4.1)
--    ADD CONSTRAINT has no IF NOT EXISTS form, so guard with drop-then-add to
--    stay re-runnable. brain role canonical set: owner/editor/viewer. estate
--    role canonical set: admin/member.
-- ============================================================

alter table brain_memberships
  drop constraint if exists brain_memberships_role_chk;
alter table brain_memberships
  add constraint brain_memberships_role_chk
  check (role in ('owner', 'editor', 'viewer'));

alter table estate_memberships
  drop constraint if exists estate_memberships_role_chk;
alter table estate_memberships
  add constraint estate_memberships_role_chk
  check (role in ('admin', 'member'));

-- ============================================================
-- b. thought_audit table (D5)
--    thought_id is DELIBERATELY NOT a FK to thoughts: a purge (M5) hard-deletes
--    the thought row, and the audit trail must outlive its own subject.
--    actor is NOT NULL even for legacy-admin (where principal_id is null) so the
--    highest-privilege caller is always attributable.
-- ============================================================

create table if not exists thought_audit (
  id          uuid primary key default gen_random_uuid(),
  thought_id  uuid not null,
  brain_id    uuid,
  actor       jsonb not null,
  action      text not null check (action in ('delete', 'restore', 'purge')),
  at          timestamptz not null default now(),
  old_state   jsonb
);

create index if not exists thought_audit_thought_id_idx
  on thought_audit (thought_id);

create index if not exists thought_audit_brain_id_at_idx
  on thought_audit (brain_id, at);

-- ============================================================
-- c. append-only enforcement (D5)
--    A BEFORE UPDATE OR DELETE trigger that RAISEs. This is portable and
--    role-independent (works even when the connecting role is a superuser, which
--    a GRANT/REVOKE scheme would not constrain). The principals that D4 allows to
--    delete must NOT be able to erase the evidence of that delete.
-- ============================================================

create or replace function thought_audit_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'thought_audit is append-only: % is not permitted', tg_op;
end;
$$;

drop trigger if exists thought_audit_append_only_trg on thought_audit;
create trigger thought_audit_append_only_trg
  before update or delete on thought_audit
  for each row
  execute function thought_audit_append_only();
