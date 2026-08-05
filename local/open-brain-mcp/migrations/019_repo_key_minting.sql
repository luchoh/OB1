-- 019_repo_key_minting.sql
-- Least-privilege repo-key minting (docs/53; system-config harness-keys design).
--
-- system-config is moving its interactive harnesses (claude-code, codex, pi) off
-- the single shared MCP_ACCESS_KEY — which resolves to GLOBAL ADMIN via auth.mjs
-- `key === config.accessKey` — onto per-repo cloud_bound keys. This migration adds
-- the one capability that lets a non-admin key mint those, and nothing else.
--
-- ADDITIVE AND FAIL-CLOSED, deliberately:
--   * The column defaults to false, so every existing key — including the admin
--     path — is unchanged. The legacy admin secret must NEVER gain this
--     capability implicitly (docs/53 "Residuals"); it does not, because the
--     legacy path builds its caller inline and never reads this column.
--   * The seeded principal is SECRET-FREE. It holds no key. The operator mints
--     the actual minter key out-of-band with scripts/mint-authority-init.mjs,
--     which stores only sha256(key). No plaintext ever touches disk here.
--   * can_mint_repo_keys is orthogonal to is_admin and to the read/write/delete/
--     purge policy: a key holding it can create repo brains + repo keys and
--     NOTHING else. It is not authority over content.

-- ============================================================
-- 1. The capability column
-- ============================================================
alter table brain_access_keys
  add column if not exists can_mint_repo_keys boolean not null default false;

-- ============================================================
-- 2. The secret-free minting principal
-- ============================================================
-- Homed in the earliest person principal's household (the single-household seed
-- assumption is a stated residual of docs/53). default_brain_id stays NULL: the
-- minter is deliberately brain-less, which is why auth.mjs flips
-- requireUsableBrain off for a minting key.
--
-- If no person principal exists yet (un-bootstrapped DB) this inserts nothing and
-- mint-authority-init.mjs fails loudly rather than inventing a household.
insert into brain_principals (household_id, slug, display_name, principal_type, default_brain_id)
select p.household_id, 'system:minter', 'Repo-key minting authority', 'minter', null
from brain_principals p
where p.principal_type = 'person'
order by p.created_at asc
limit 1
on conflict (household_id, slug) do nothing;
