-- 018_brain_egress_downgrade_guard.sql
-- Brain-level declassification guard (docs/45 §6.13, review finding #12).
--
-- migration 016's enforce_restricted_brain_isolation trigger enforces
-- "a restricted thought may live ONLY in a private_local/quarantine_review
-- brain" — but it fires only on THOUGHT insert/update. It does NOT fire when a
-- BRAIN's egress_class changes, so flipping a brain from private_local to
-- public/repo while it still holds restricted thoughts would silently orphan
-- that restricted content into a cloud-readable brain (a one-column
-- declassification). This trigger closes that edge from the brain side.
--
-- The full §6.13 protected-transition path (local-trusted owner capability +
-- human confirmation + audit) is a later slice; this is the DB invariant that a
-- direct SQL / import / future-route downgrade cannot bypass.

create or replace function enforce_brain_egress_no_open_with_restricted()
returns trigger
language plpgsql
as $$
begin
  -- A brain may not become cloud-readable (public/repo) while it holds any live
  -- restricted thought. Fail-closed on the row side too: the isolation trigger
  -- keeps non-standard rows out of cloud-readable brains, so checking
  -- sensitivity_tier = 'restricted' is sufficient for the v1 enum.
  if new.egress_class in ('public', 'repo')
     and exists (
       select 1 from thoughts
       where brain_id = new.id
         and sensitivity_tier = 'restricted'
         and deleted_at is null
     ) then
    raise exception
      'cannot set brain % egress_class to % while it holds restricted thoughts (docs/45 §6.13 declassification guard)',
      new.id, new.egress_class
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists brains_egress_no_open_with_restricted on brains;
create trigger brains_egress_no_open_with_restricted
  before update on brains
  for each row
  when (new.egress_class is distinct from old.egress_class)
  execute function enforce_brain_egress_no_open_with_restricted();
