# PRD: Agent Estate + Brain Selection — Implementation Roadmap (v3)

Date: 2026-06-02
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`,
           CONTEXT `CONTEXT.md`,
           review `docs/29-agent-estate-implementation-roadmap-review-v1.md`,
           review `docs/29-agent-estate-implementation-roadmap-review-v2.md`
Supersedes: v1 and v2

## Why v3

v2 narrowed the right things but missed five real bugs against the live
auth code. Each is fixed below, with the relevant code paths cited
inline:

1. **Brain-bound stored keys.** v2 widened privileges by ignoring
   `brain_access_keys.brain_id`. The current resolver
   (`auth.mjs:241-317`) enforces that a non-admin stored key set to one
   brain cannot reach any other. v3 carries that restriction through
   the new helper.
2. **Slug resolution vs accessible-set drift.** v2's slug lookup
   covered a different set of brains than the multi-brain default
   read. v3 makes them the same set.
3. **Operator path was hand-waved.** Goal: operator visibility into
   agent brains via estate membership. v2 said "operator searches with
   their existing key" but D3 also said legacy admin is single-brain.
   v3 picks one path and writes it down.
4. **Phase 4 vs Phase 6 contradiction.** Once `.envrc` flips
   `MCP_ACCESS_KEY` to a stored repo key, scripts that read
   `MCP_ACCESS_KEY` stop using legacy admin. v3 splits env vars so
   admin scripts keep their own.
5. **`/admin/thought/metadata` is a write surface, not a bug fix.**
   v2 quietly extended it for stored-key callers; v3 calls it what it
   is and adds explicit authorization rules.

## Vocabulary recap

Defined in `CONTEXT.md`. Quick reference for v3:

- **Estate** — top-level container (currently `households` table).
- **Repo principal** — `brain_principals` row with
  `principal_type='agent'`, slug = code repo name.
- **Repo brain** — brain owned by a repo principal in the agent estate.
- **Common brain** — single brain in the agent estate, shared via
  brain memberships across all repo principals.
- **Default brain** — `brain_principals.default_brain_id`.
- **Auth source** — one of:
  - `human_token` (Keycloak JWT bound to a `brain_principals` row via
    `principal_identity_bindings`).
  - `service_key` (a stored row in `brain_access_keys`; may be admin or
    not; may be brain-bound or not).
  - `legacy_admin_key` (the bare `config.accessKey`; principal-less,
    `isAdmin=true`).
- **Brain-bound key** — `service_key` with
  `brain_access_keys.brain_id != null`. Today's schema convention
  (`docs/17:387-407`) for normal agents.

## Goals

- Per-repo agent isolation with cross-repo recall via a common brain.
- Operator visibility into all agent brains via a clearly-named
  operator path.
- Zero regressions on existing legacy-admin callers.
- Explicit authorization decisions on every write surface that becomes
  cross-brain capable, not "incidental footgun fixes."

## Non-goals

- Renaming `households` → `estates`.
- Edit / delete capabilities on thoughts beyond the existing
  `/admin/thought/metadata` surface.
- Multi-brain graph queries.
- Federated identity for agents.

## Design decisions, post-v2-review

### D1. Estate membership has no deny rows (unchanged)

`estate_memberships` is allow-only. Brain-level deny is the only deny.

### D2. Canonical brain selector + ambiguity rule (unchanged)

Route / query / header / tool-arg, in that order of precedence with
disagreement → 400. Slug ambiguity across estates → 409 with both
UUIDs. Tool-arg vs session-brain disagreement is detected **inside the
tool handler** (Phase 2c, not Phase 3 — fixing v2's sequencing slip).

### D3. Operator path: stored-key principal `luchoh` with admin role on the agent estate

This is the v3 commitment that v2 ducked. The operator's cross-estate
visibility lands via a **stored key**, not legacy admin:

- The existing principal `luchoh` (in `local-household`) gets a new
  stored access key, tagged `is_admin=false`, no `brain_id` binding,
  with `estate_memberships(luchoh, agent-estate, role='admin')`.
- This stored key is what the operator uses for any cross-estate
  read or write.
- The operator's local CLI / dashboard / personal client uses this
  stored key (in `~/.config/ob1/operator.env` or equivalent) and
  passes it as `MCP_ACCESS_KEY`.
- Legacy admin remains as-is for **infrastructure scripts** only,
  never for operator interactive use. Renamed in env to clarify
  (Finding 4 fix).

Why stored-key over legacy admin for the operator path:
- Legacy admin is single-brain by D3-of-v2, by design — keeping it
  that way preserves the cheap "this script needs no membership
  reasoning" story for backfills/smoke.
- Stored-key with estate membership flows through the same
  access-check helper as agents. One path, exercised consistently.
- A future audit log (ADR-27) records the principal on every write.
  Legacy admin has no principal. Operator writes need attribution.

Why not human-token:
- The human-token branch (`auth.mjs:159-224`) requires Keycloak. Today
  the bridge runs without Keycloak. v3 does not introduce that
  dependency. Human-token remains a future option for browser-driven
  flows; it does not block this work.

### D4. Phase scope (revised against v2 Findings 1, 5)

**In scope (multi-brain capable after this PRD):**
- MCP tools: `capture_thought`, `search_thoughts`, `list_thoughts`,
  `stats`, `ask_brain`.
- HTTP: `/ingest/thought`, `/ask`, `/admin/thought/similar`.

**Treated as a deliberate write-surface expansion (Finding 5):**
- `/admin/thought/metadata` — see D7 below. Authorization is
  **opt-in per principal** via `brain_memberships.role` (`'owner'` or
  `'editor'`) or via `brain_access_keys.is_admin=true`. Not a free
  side-effect of estate membership.

**Out of scope (stay admin-only, single-brain):**
- All `/graph/*` endpoints. `ensureGraphAdmin()` (`server.mjs:773`)
  stays in place. No `brain` parameter added to graph tools.

### D5. Multi-brain reads carry brain origin (unchanged)

Every multi-brain read row gains `brain_id` and `brain_slug`. `stats`
gets a multi-brain shape with per-brain counts; legacy single-brain
shape preserved for legacy-admin callers.

### D6. Brain-bound stored keys honored (Finding 1 fix)

The access-check helper has FOUR ordered branches, not two:

```
function checkBrainAccess({ accessContext, brainId }):
  1. legacy_admin_key        → ALLOW (bypass; preserves today's behavior)
  2. service_key, is_admin   → ALLOW (admin keys can target any brain
                                       once principal is resolved)
  3. service_key, brain-bound (key.brain_id != null):
       if brainId == key.brain_id → ALLOW
       else                       → DENY  (preserves auth.mjs:299-310 contract)
  4. service_key OR human_token, not brain-bound:
       brain-level deny on (principal, brain)               → DENY
       brain-level allow on (principal, brain)              → ALLOW
       estate-level allow on (principal, brain.estate)      → ALLOW
       otherwise                                            → DENY
```

`listAccessibleBrainIds({ accessContext })` returns:

- `legacy_admin_key`: `[effectiveBrainId]`.
- `service_key, is_admin`: every brain (admin can see all). For
  performance, callers should still pass an explicit `brain` to scope
  reads.
- `service_key, brain-bound`: `[key.brain_id]`. **This is the fix for
  Finding 1.** Brain-bound keys keep their narrow scope even if the
  underlying principal has wider memberships.
- `service_key`/`human_token`, not brain-bound: union of brain-membership
  allows + estate-membership brains, minus brain-membership denies.

### D7. `/admin/thought/metadata` authorization rule (Finding 5 fix)

The endpoint becomes cross-brain capable, but not for everyone:

- **legacy_admin_key**: unchanged. WHERE remains
  `(id = $1, brain_id = effectiveBrainId)`. Single-brain by definition.
- **service_key, is_admin**: any thought in any brain.
- **service_key, brain-bound**: only thoughts whose `brain_id` matches
  the key's `brain_id`. Same restriction as today.
- **service_key, not brain-bound, not admin**: only thoughts in brains
  where the principal has either a `brain_memberships` row with
  `role IN ('owner','editor')` (NOT plain `'member'`) OR an
  `estate_memberships` row with `role='admin'` on the brain's estate.
  Plain estate membership of `role='member'` does NOT grant edit power.
- **human_token**: same as service_key non-brain-bound.

Rationale:
- Estate-level allow grants **read** access automatically. Edit power
  requires a more specific grant — either an `'editor'`/`'owner'`
  brain-level role, or estate-admin.
- A repo principal that only `member`-belongs to the agent estate can
  search the common brain but cannot patch its rows.
- The operator path (D3) gets edit power via
  `estate_memberships(luchoh, agent-estate, role='admin')`, which IS
  estate-admin → unlocks `/admin/thought/metadata` across the estate.

The acceptance section (Phase 2 below) tests both the allow and deny
arms for this surface explicitly.

### D8. Slug resolution uses the same set as accessible-brain reads (Finding 2 fix)

Slug→UUID resolution for stored-key/human-token callers searches
**`listAccessibleBrainIds()` exactly**. No second, narrower set.
Specifically:

- For brain-bound keys, slug must resolve to `key.brain_id` or 404.
- For non-brain-bound, slug resolves over `listAccessibleBrainIds()`;
  if zero matches → 404; if one → return UUID; if more than one → 409
  with both UUIDs in the body.

For legacy admin, slug resolution stays global (`auth.mjs:336-364`).

This is a behavioral change from `auth.mjs:241-317` for the
non-brain-bound case (today it searches by `household_id`). The
broader scope is intentional for cross-estate visibility; it's gated
by the access-check helper, so a slug that resolves to a brain you
can't access still returns 403, not data leakage.

### D9. Telemetry update (unchanged from v2)

`brain_scope`, `searched_brain_ids`, `result_brain_ids`. Single-brain
reads keep the old shape; multi-brain reads add the arrays.

### D10. Env split (Finding 4 fix)

The repo `.envrc` does NOT export `MCP_ACCESS_KEY` from the bare
`config.accessKey`. Instead:

- **Repo principal key** lives in `MCP_ACCESS_KEY` in the repo
  `.envrc`. Stored-key, agent principal, may or may not be brain-bound
  (we choose **not** brain-bound, so the agent can write to `agent-common`
  in addition to the repo brain — see D6).
- **Legacy admin key** for infrastructure scripts moves to a **new env
  var**: `OB1_LEGACY_ADMIN_KEY`. Scripts that need legacy admin
  semantics (smoke, enrichment, backfill) read this var explicitly
  rather than `MCP_ACCESS_KEY`. Phase 6 below updates the scripts in
  one commit.
- **Operator stored key** (D3) lives in `MCP_ACCESS_KEY` in the
  operator's home env (e.g., `~/.config/ob1/operator.env`), used outside
  any repo shell. Direnv ensures repo entry overrides this with the
  repo principal key.

This is the only acceptable resolution of v2 Finding 4. The
contradiction goes away because `MCP_ACCESS_KEY` is no longer the only
admin entry point.

### D11. No estate-rename in this work (unchanged)

`households` stays. New code uses `estateId` locally.

## Phasing

Independently deployable phases. Each acceptance row tests **all
relevant auth branches** (legacy admin, brain-bound service key,
non-brain-bound service key, human token if enabled).

### Phase 1 — Schema: cross-estate access primitives

Migration `009_estate_memberships.sql`:

```sql
create table if not exists estate_memberships (
  principal_id uuid not null references brain_principals(id) on delete cascade,
  household_id uuid not null references households(id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  primary key (principal_id, household_id)
);

create index if not exists estate_memberships_household_idx
  on estate_memberships (household_id);

alter table brain_memberships
  add column if not exists is_deny boolean not null default false;

create index if not exists brain_memberships_principal_active_idx
  on brain_memberships (principal_id, brain_id)
  where is_deny = false;
```

No code reads these columns yet. Safe to apply on dev and prod
independently.

**Acceptance:**
- ☐ `\d+ estate_memberships` confirms NO `is_deny` column.
- ☐ `\d+ brain_memberships` confirms new `is_deny` column.
- ☐ Smoke regression: legacy-admin smoke flow passes unchanged.

### Phase 2a — Access-check helper (D6, D7) + listAccessibleBrainIds

Implements the four-branch helper from D6 and the edit-authorization
helper from D7:

```js
async function checkBrainAccess({ accessContext, brainId, requireEdit = false }) { ... }
async function listAccessibleBrainIds({ accessContext }) { ... }
async function listEditableBrainIds({ accessContext }) { ... }   // for /admin/thought/metadata
```

These ship with no caller change. Test matrix (each combination is a
test):

| auth branch                          | helper                  | result |
|--------------------------------------|-------------------------|--------|
| legacy_admin_key                     | check(any brain)        | ALLOW (bypass) |
| legacy_admin_key                     | listAccessible          | `[effectiveBrainId]` |
| service_key, is_admin                | check(any brain)        | ALLOW |
| service_key, brain-bound, target=key.brain_id | check                  | ALLOW |
| service_key, brain-bound, target≠key.brain_id | check                  | DENY |
| service_key, brain-bound             | listAccessible          | `[key.brain_id]` (NOT principal's wider memberships) |
| service_key, no membership, no estate| check                   | DENY |
| service_key, brain-membership allow  | check                   | ALLOW |
| service_key, brain-membership allow  | check(requireEdit), role='member' | DENY |
| service_key, brain-membership allow  | check(requireEdit), role='editor' | ALLOW |
| service_key, estate-membership only  | check                   | ALLOW |
| service_key, estate-membership member | check(requireEdit)     | DENY |
| service_key, estate-membership admin | check(requireEdit)      | ALLOW |
| service_key, estate-allow + brain-deny | check                 | DENY |

**Acceptance:**
- ☐ Test matrix above passes in CI.
- ☐ Smoke regression unchanged.

### Phase 2b — Selector unification (D2, D8)

In `resolveAccessContext` (`auth.mjs`):

- Detect simultaneous route+query, route+header, query+header → 400.
- Cache the resolved session brain on `accessContext.sessionBrain`.

Slug→UUID resolution rewires per D8: lookup over the result of
`listAccessibleBrainIds` for non-legacy-admin callers; global for
legacy admin. 409 on multi-match.

**Acceptance:**
- ☐ `?brain=ob1` + `x-brain-slug=agent-common` → 400.
- ☐ Stored-key principal with estate-only access to estate B can
  resolve `brain=<estate-B-slug>` (Finding 2 case).
- ☐ Two estates with same slug → 409.
- ☐ Brain-bound key with mismatched slug → 404 (slug not in its single
  accessible brain).
- ☐ Legacy admin slug resolution global, unchanged.

### Phase 2c — Tool & HTTP surfaces

**`capture_thought`, `/ingest/thought`** (write):
- Optional `brain` body field.
- Tool-arg vs session-brain disagreement → 400 (resolved in this phase
  per v2 Finding sequencing fix).
- `checkBrainAccess({ requireEdit: false })` then write.
  (Capture is "create new"; existing-row edit policy from D7 doesn't
  apply.)
- No `brain` specified:
  - legacy_admin_key: existing default.
  - service_key, brain-bound: `key.brain_id`.
  - service_key, non-brain-bound: `principal.default_brain_id`. Null →
    400.

**`search_thoughts`, `list_thoughts`, `ask_brain`, `/ask`,
`/admin/thought/similar`** (read):
- Optional `brain`.
- If set: scope to that brain after access check.
- If not: scope to `listAccessibleBrainIds()`.
- Fan out per brain in parallel. Merge by similarity (search) or
  `created_at DESC` (list). Tag every row with `brain_id`/`brain_slug`.

**`stats`:**
- Multi-brain shape per D5.

**`/admin/thought/metadata`** (write surface; D7):
- `WHERE id = $1 AND brain_id = ANY($2)` where `$2 =
  listEditableBrainIds()`.
- Row not in that set → 403 with explicit message ("thought belongs to
  brain X; principal lacks editor/owner/admin role on it").
- Legacy admin path: WHERE remains `(id, effectiveBrainId)`. Unchanged.

**`/graph/*`:** unchanged. Admin-only.

**Acceptance — legacy_admin_key:**
- ☐ Smoke harness passes unchanged.
- ☐ Telegram bridge captures land where they did before.
- ☐ `scripts/thought_enrichment/*` succeed (after D10 env split: they
  read `OB1_LEGACY_ADMIN_KEY`).
- ☐ Admin metadata patch returns success on the same input as today.

**Acceptance — service_key, brain-bound (most-likely-regressed branch):**
- ☐ Capture with no `brain` lands in `key.brain_id`.
- ☐ Capture with `brain=<other slug>` → 403 (NOT silently widened).
- ☐ Search with no `brain` returns hits from `key.brain_id` only.
- ☐ Slug `<other-brain>` → 404 (not in single accessible brain).

**Acceptance — service_key, non-brain-bound, multi-membership:**
- ☐ Capture with `brain="ob1"` lands there.
- ☐ Capture with `brain="agent-common"` lands there.
- ☐ Capture with no `brain` lands in `principal.default_brain_id` (the
  repo brain).
- ☐ Search with no `brain` spans both brains; rows tagged.
- ☐ Search with `brain="ob1"` scopes to one brain.
- ☐ `/admin/thought/metadata` on a thought in `agent-common`:
  - role='member' on agent-common → 403.
  - role='editor' or 'owner' → 200.
  - estate-admin on agent-estate → 200.

**Acceptance — service_key, estate-only access:**
- ☐ Search with `brain=<estate-only-brain-slug>` resolves and runs
  (Finding 2 fix).
- ☐ Patch on a thought in that brain: 403 unless estate role='admin'
  or brain-level editor/owner.

**Acceptance — selector disagreement:**
- ☐ `POST /mcp/brains/ob1` + tool-arg `brain="agent-common"` → 400.

### Phase 3 — Provisioning CLI

`scripts/agent_estate/provision.py`. Idempotent. Creates:

- agent estate (singleton).
- common brain (singleton, in agent estate).
- per-repo principal + per-repo brain + memberships
  (`brain_memberships(repo-principal, repo-brain, role='owner')`,
  `brain_memberships(repo-principal, common-brain, role='editor')`).
- per-repo `service_key` access key — **not brain-bound** (so the repo
  agent can patch in common brain via D7 editor role).
- on first run: operator stored-key access key for principal `luchoh`
  + `estate_memberships(luchoh, agent-estate, role='admin')`.

Three subcommands:
- `provision-repo --slug ob1` (idempotent; errors if access key already
  exists, recommend `--rotate-key`).
- `provision-operator-membership` (one-shot; idempotent).
- `rotate-key --slug ob1` (revokes prior key, mints a new one).

**Acceptance:**
- ☐ Re-run idempotent.
- ☐ After first run, the operator stored key passes the access-check
  matrix for cross-estate read.
- ☐ Repo principal key passes the brain-bound-key matrix from Phase 2a
  (verifies the editor role on common-brain works for D7).

### Phase 4 — Per-repo `.envrc`

For OB1 first:

```
# OB1 .envrc additions
export MCP_ACCESS_KEY=$(cat .ob1-mcp-access-key)   # gitignored, repo principal stored key
export OPEN_BRAIN_BASE_URL=http://127.0.0.1:8788
```

The legacy admin key for infrastructure scripts moves to a separate
env var per D10:

```
# ~/.config/ob1/admin.env (sourced by scripts that need legacy-admin)
export OB1_LEGACY_ADMIN_KEY=...
```

**Acceptance:**
- ☐ Inside `/Users/luchoh/Dev/OB1` shell, `MCP_ACCESS_KEY` is the OB1
  repo principal's stored key.
- ☐ Capture from inside the OB1 shell with no `brain` lands in `ob1`
  brain.
- ☐ Capture with `brain="agent-common"` lands in common brain.
- ☐ Capture with `brain="some-other-tenant-brain"` → 403.

### Phase 5 — Routing skill (unchanged from v2)

`skills/agent-brain-routing/SKILL.md`. Same content. Same system-config
deploy pattern.

### Phase 6 — Migrate writers (Finding 4 fix)

This is real work, not a hand-wave. In one commit:

- `scripts/smoke-open-brain-running-service.sh`: read
  `OB1_LEGACY_ADMIN_KEY` instead of `MCP_ACCESS_KEY`.
- `scripts/thought_enrichment/enrich.py`,
  `scripts/thought_enrichment/backfill_sensitivity.py`,
  `scripts/thought_enrichment/lib/db.py`: read
  `OB1_LEGACY_ADMIN_KEY` instead of `MCP_ACCESS_KEY`.
- `scripts/backfill-chat-claim-typing.py`: same.
- Telegram bridge wrapper (`/nix/store/...-ob1-telegram-bridge-wrapper`):
  this lives in system-config. Not modified by this PRD; flagged as a
  follow-up handoff. Until that lands, the bridge keeps using whatever
  the wrapper sets, which today is the legacy admin key — so the bridge
  is unchanged.
- `recipes/dictation-import/`, `recipes/document-import/` ingest
  scripts: same env var split.
- `integrations/telegram-capture/telegram_bridge.py` itself: no env
  var change in this repo; the wrapper sets the var name. Until the
  wrapper changes, the bridge sees whatever name the wrapper sets.

**Acceptance:**
- ☐ Smoke harness with `OB1_LEGACY_ADMIN_KEY` set passes.
- ☐ Smoke harness with `MCP_ACCESS_KEY=<repo-key>` set: still passes,
  but via service_key path (no longer legacy admin).
- ☐ `scripts/thought_enrichment/enrich.py --status` works against
  `OB1_LEGACY_ADMIN_KEY`.
- ☐ Within an OB1 repo shell (Phase 4 active), running the enrichment
  script without setting `OB1_LEGACY_ADMIN_KEY` errors clearly with
  a message naming the new env var.

## Risks and mitigations (revised)

- **Brain-bound stored keys quietly widen.** Mitigation: D6 branch 3
  explicitly enforces the existing restriction; Phase 2a tests cover
  this case. Without those tests this would be a real
  privilege-expansion bug.
- **Edit-authorization granularity.** D7 introduces a role hierarchy
  (`member` < `editor` < `owner`/admin) for write surfaces, distinct
  from read access. Mitigation: tests cover both arms; provisioning
  CLI sets `role='editor'` (not `'member'`) for repo-principal
  membership on `common-brain` so agents can patch their own captures
  there.
- **Phase 6 env split is a coordinated change across many scripts.**
  Mitigation: ship the env split and the script updates in one PR.
  Leave Telegram bridge wrapper for system-config follow-up
  (documented).
- **Operator stored key handling.** Mitigation: D3's stored-key path
  is the dogfood path — same access-check helper as agents, audit log
  attribution works (when ADR-27 lands).
- **`/admin/thought/metadata` is now an "agent edit surface."**
  Mitigation: D7 limits it. The audit story is still tracked in
  ADR-27. v3 doesn't ship the audit log itself, but the writes are
  now governed by an explicit allowlist (editor/owner/estate-admin),
  not "everyone with read."
- **Multi-brain search latency.** Mitigation: parallel fanout, N is
  small, optimization deferred.
- **Slug ambiguity surfaces only after multiple estate memberships.**
  Mitigation: covered in Phase 2b acceptance with a synthetic case.

## Out of scope, tracked separately

- Renaming `households` → `estates`.
- Brain-qualified graph projections + multi-brain graph queries.
- `update_thought_mcp` and `delete_thought_mcp` MCP tools.
- Thought-audit log (ADR-27).
- Telegram bridge wrapper env split (system-config follow-up).
- Recurring backup design (task #14).

## Open questions

- D7 chose role-based edit gating instead of an `editable` predicate
  on `brain_memberships`. The choice is reversible — predicate would
  let us decouple read-role from write-role per row, at the cost of
  a more complex schema. Defer until a real use case appears.
- Should brain-bound stored keys be deprecated entirely once the
  access-check helper exists? They served a clarity purpose
  (`docs/17:387-407`) but D6 makes principal-level memberships
  expressive enough. Defer; not breaking anything today.
- D10 splits env vars; should we also rename `MCP_ACCESS_KEY` to
  something more specific (`OB1_PRINCIPAL_KEY`)? Cosmetic; defer.
