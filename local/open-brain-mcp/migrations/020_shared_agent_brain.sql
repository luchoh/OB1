-- 020_shared_agent_brain.sql
-- Marks the ONE brain per household that all three per-repo agents (claude,
-- codex, pi) share — the "common-public" brain. Without a marker there is no way
-- for a mint/rotate route to tell that brain apart from a repo brain, and the
-- caged pi agent needs a second membership onto it that no repo key grants.
--
-- WHY A NEW FLAG AND NOT is_default_shared:
-- is_default_shared already exists and looks like the obvious home for this, but
-- it carries a HARD-REFUSE role: repo-key-minting.mjs assertIsRepoBrain treats
-- `row.is_default_shared` as "this is the household's personal brain, never touch
-- it" and throws 409 before any mint or rotate. That guard is the thing stopping a
-- minting key from being pointed at the owner's personal brain by naming it, so it
-- must not be softened. Reusing the flag would therefore make the shared agent
-- brain permanently un-mintable and un-rotatable — every agent-key operation on it
-- would 409 — while simultaneously blurring a security-relevant predicate. Two
-- distinct facts ("is the household's personal default brain" vs "is the shared
-- agent brain") get two distinct columns.
--
-- SCHEMA ONLY — NO BRAIN IS CREATED HERE, DELIBERATELY. Creating the
-- common-public brain requires choosing a household, and a migration runs
-- unattended with no way to ask which estate was meant. 019 was rewritten in this
-- repo for exactly that reason: its earlier draft seeded a principal into "the
-- earliest person principal's household", which on a multi-household estate is the
-- wrong household and fails silently rather than loudly. Brain creation is an
-- operator step (a hand-run script that detects the household, prints it, and
-- refuses when ambiguous), not a migration step.
--
-- ADDITIVE AND FAIL-CLOSED: the column defaults to false, so every existing brain
-- keeps its current meaning and no brain becomes shared by accident.

alter table brains
  add column if not exists is_shared_agent_brain boolean not null default false;

-- At most one shared agent brain per household. Partial (where the flag is true)
-- so the constraint says nothing about the many false rows — a plain unique on
-- (household_id, is_shared_agent_brain) would also cap a household at one
-- non-shared brain, which is absurd.
create unique index if not exists brains_one_shared_agent_brain_per_household_idx
  on brains (household_id)
  where is_shared_agent_brain;
