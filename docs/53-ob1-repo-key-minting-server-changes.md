# 53 — OB1 server changes for repo-key minting (system-config harness-keys design)

**Audience:** OB1 implementing agents. **Companion (client side):**
`~/Dev/system-config/docs/2026-08-05-ob1-harness-keys-design.md` (+ ADRs 0004–0009 there).
**Status:** design accepted, not yet implemented. Everything below was source-verified against
`local/open-brain-mcp/src` at design time — re-confirm line numbers before editing.

## Why

system-config is moving its interactive harnesses (claude-code, codex, pi) off the single shared
`MCP_ACCESS_KEY` (which resolves to **global admin** via `auth.mjs` `key===config.accessKey`) onto
per-repo `cloud_bound` keys + a pi-only `local_trusted` common key. OB1 needs a way to **mint
per-repo brains + repo keys** under a least-privilege capability, plus a **rotate/revoke** path.
This is additive; **do NOT retire or change the existing admin secret** — that is explicitly out of
scope.

## What stays TRUE (verified, do not "fix")

- Auth split: `key===config.accessKey` → `resolveLegacyAdminContext` (global admin); else
  `resolveStoredAccessKeyContext(sha256(key))` → `brain_access_keys` join `brain_principals` +
  memberships + policy. `config.accessKey = env MCP_ACCESS_KEY` (required boot var — never unset).
- Egress default is `observe`. OB1 is WG-gated (`ob1.lincoln.luchoh.net → 10.10.10.100`).
- Membership isolation already prevents a `cloud_bound` repo key from reaching the `private_local`
  common brain (matches the inline comment near `auth.mjs:576-577`). Flipping `egressEnforce` is
  optional defense-in-depth, to be done only AFTER the (out-of-scope) legacy path is retired.

## Capability model

One new boolean capability `can_mint_repo_keys` on `brain_access_keys`. A key holding it can create
`egress_class='repo'` brains + `cloud_bound` repo keys **and nothing else** — it is `is_admin=false`,
brain-less, and orthogonal to the read/write/delete/purge policy. It is held only by an
**operator-supplied minter key stored hash-only** (no plaintext on disk anywhere).

## Changes

### 1. Migration `019_repo_key_minting.sql`
- `alter table brain_access_keys add column if not exists can_mint_repo_keys boolean not null default false;`
- Seed ONE secret-free principal: `brain_principals(slug='system:minter',
  principal_type='minter', default_brain_id=null, household_id=<earliest person principal's
  household>)` with `on conflict (household_id, slug) do nothing`.

### 2. `src/auth.mjs`
- **MUST-FIX:** `hashAccessKey` is a bare unexported `function` at `auth.mjs:57`. **Add `export`**
  (both new files import it) — or inline `crypto.createHash('sha256')`.
- `resolveStoredAccessKeyContext` SELECT (~:422): add `, k.can_mint_repo_keys`.
- Where it builds the context (~:449-457): pass `canMintRepoKeys: Boolean(row.can_mint_repo_keys)`
  and `requireUsableBrain: !row.can_mint_repo_keys` (the flip lets the brain-less minter past the
  `requireUsableBrain && !effectiveBrainId` 403 at ~:307-308).
- `buildPrincipalContext` (~:249-273): accept `canMintRepoKeys=false`, stamp it on the `caller`
  object (rides in `_policy.caller`). Every other path — human token, **legacy admin** — leaves it
  `false`, so the admin secret can never mint via the tool.

### 3. New `src/repo-key-minting.mjs` — two handlers
Both gate first: `if (accessContext?._policy?.caller?.canMintRepoKeys !== true) throw new
HttpError(403, ...)`. Each runs a real transaction via `pool.connect()` (BEGIN/COMMIT/ROLLBACK).

- `handleMintRepoKey({repo_slug, display_name?})` — **create-only.** Validate DNS-safe slug
  (`/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/`); namespace `slug = 'repo:'+repo_slug`; `SELECT ... FOR
  UPDATE` in the minter's household; **abort 409** if the slug resolves to a non-repo or
  `is_default_shared` brain, **or** if the repo brain already has an ACTIVE key (→ tell caller to
  rotate). Else create: `brains(kind='repo', egress_class='repo', is_default_shared=false)`,
  per-repo `brain_principals(principal_type='repo_service')` + `brain_memberships(role='editor')`,
  fresh 256-bit key, `brain_access_keys(is_admin=false, read_egress_class=null → cloud_bound,
  can_mint_repo_keys=false, credential_type='repo_key', key_hash=sha256(plaintext),
  brain_id=<repoBrainId>)`. Return plaintext ONCE. All of `is_admin/egress_class/kind/can_mint` are
  literal constants — never from args.
- `handleRotateRepoKey({repo_slug})` — **revoke+replace** (fixes the create-only deadlock).
  Validate slug; `SELECT` the existing `repo:`+slug brain `FOR UPDATE` (404 none; 409 if
  `is_default_shared` or `egress_class<>'repo'` — never touches the common brain); same txn
  `UPDATE brain_access_keys SET is_active=false WHERE brain_id=$repoBrainId AND is_active=true`,
  then INSERT one replacement key for the existing per-repo principal. Return plaintext ONCE.

**NOT-NULL completeness (verified against migration 005):** every INSERT must supply
`brains.{display_name, kind, household_id, slug}`, `brain_memberships.role`,
`brain_principals.{display_name, principal_type, household_id, slug}`,
`brain_access_keys.{label, credential_type, key_hash, brain_id}`. Missing
`brain_access_keys.brain_id` in particular makes rotate's guard and `WHERE` match nothing.

### 4. `src/server.mjs`
Register `mint_repo_key` and `rotate_repo_key` (server currently exposes 9 tools; these are net-new)
using the existing `try / jsonToolResult / errorToolResult` idiom, closing over `accessContext`.

### 5. `scripts/mint-authority-init.mjs`
No-echo stdin read of the raw minter key; one txn deactivates any active key of `system:minter` and
INSERTs `brain_access_keys(principal_id=<minter>, brain_id=null, key_hash=hashAccessKey(raw),
label='repo-key minter', credential_type='minter', is_admin=false, can_mint_repo_keys=true,
is_active=true)`. Idempotent (re-run rotates the minter key itself). Operator runs it once; the raw
key goes into the operator's password manager.

## Client-side gate (informational)

The `mint_repo_key` / `rotate_repo_key` tools are deliberately **never** added to the harness
allowlist (`mcp__ob1__*` prompts), and system-config adds a build-time assertion rejecting any
`mcp__ob1__` entry in `globalAllow`. Operator-in-the-loop is the authorization; the server-side
`canMintRepoKeys` capability is the real control.

## Residuals owned on the OB1 side

- The minter key's entry leg (operator keystrokes into `mint-authority-init.mjs` / the broker)
  crosses a host tty — irreducible for hand-typed entry.
- `credential_type` / `principal_type` are free-text (no enum enforcement); single-household seed
  assumption.
- The legacy admin secret can still write `brain_access_keys` rows via SQL/admin CRUD — out of
  scope; ensure the admin path never gains `can_mint_repo_keys` implicitly.
