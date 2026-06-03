-- 009: agent-estate cross-estate access primitives (v24 Phase 1)
--
-- Adds estate-level memberships and a brain-level deny flag, per ADR-0001
-- (estate-level ALLOW broad grant + brain-level DENY override). No code reads
-- these yet, so this is safe to apply ahead of the resolver changes in Phase 2.
--
-- Notes:
--   * `role` is recorded but NOT enforced in this work (role enforcement is a
--     deferred, separately-decided item). It is unconstrained text, matching
--     brain_memberships.role, so no CHECK/enum is added here.
--   * estate_memberships.is_deny is reserved for parity only; ADR-0001 states
--     estate-level DENY does not exist (absence is denial). It stays for the
--     big-bang shape but is not consulted.
--   * `estate_id` column name is forward-looking; the FK targets households(id)
--     until the household->estate rename lands in a later migration.

create table if not exists estate_memberships (
  principal_id uuid not null references brain_principals(id) on delete cascade,
  estate_id    uuid not null references households(id) on delete cascade,
  role         text not null,
  is_deny      boolean not null default false,
  created_at   timestamptz not null default now(),
  primary key (principal_id, estate_id)
);

create index if not exists estate_memberships_estate_idx
  on estate_memberships (estate_id);

alter table brain_memberships
  add column if not exists is_deny boolean not null default false;
