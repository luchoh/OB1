# PRD: Agent Estate + Brain Selection — Implementation Roadmap (v4)

Date: 2026-06-02
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`,
           CONTEXT `CONTEXT.md`,
           reviews v1, v2, v3
Supersedes: v1, v2, v3

## Why v4

v3 fixed v2's findings but introduced new ones. Five new fixes here,
each tied to a specific code path:

1. **Stored `is_admin` keys stay household-scoped.** v3 made admin
   keys global cross-estate superusers, which broke D3's "estate
   membership is the meaningful boundary" guarantee. Today
   (`auth.mjs:290-310`) admin keys can only see brains within their
   own household; v4 keeps that.
2. **Human-token sessions stay single-brain.** v3 silently rewired
   them to multi-brain default reads. The repo's existing
   multitenancy PRD (`docs/17:250,548`) says human MCP sessions are
   single-brain per connector/session. v4 preserves that.
3. **Enrichment / backfill scripts use a stored-key path with
   explicit `brain` selection.** Today they query rows from any brain
   via asyncpg (brain-scoped on read) but write via
   `/admin/thought/metadata` which resolves the row by
   `(id, effectiveBrainId)` — a non-default brain returns "thought
   not found". v4 makes these scripts use a stored key (operator key
   from D3) and pass `brain=...` explicitly on every patch.
4. **Smoke harness has one explicit contract.** v3 said both "smoke
   reads `OB1_LEGACY_ADMIN_KEY`" AND "smoke also passes with
   `MCP_ACCESS_KEY=<repo-key>`." That's not possible from one shell
   without dual-mode handling. v4 picks one.
5. **Phase 3 acceptance points at the right matrix.** v3 said repo
   principal keys are not brain-bound, then validated them with the
   brain-bound matrix. v4 validates against the correct
   non-brain-bound, multi-membership matrix.

Plus one secondary fix: v3's D8 said slug resolution operates over
`listAccessibleBrainIds()` exactly, then said a slug could resolve
and still 403. Both claims cannot be true. v4 makes them consistent.

## Vocabulary recap

Defined in `CONTEXT.md`. Quick reference:

- **Auth source** — one of:
  - `human_token` (Keycloak JWT, single-brain per session per
    `docs/17`).
  - `service_key` (stored row in `brain_access_keys`; can be
    `is_admin=true|false`; can have `brain_id` set or null).
  - `legacy_admin_key` (the bare `config.accessKey`; principal-less,
    `isAdmin=true`, single-brain).
- **Household** — schema name for what we will call **estate** in
  prose (rename deferred).
- **Brain-bound key** — `service_key` with `brain_id != null`.
  Restricted to that single brain regardless of principal's wider
  memberships.
- **Operator stored key** — a non-admin, non-brain-bound `service_key`
  for principal `luchoh` plus an `estate_memberships(luchoh,
  agent-estate, role='admin')` row. Used for cross-estate operator
  visibility.

## Goals

- Per-repo agent isolation with cross-repo recall via the common
  brain.
- Operator visibility into agent brains via estate membership on a
  stored key.
- Zero regressions on legacy-admin callers AND on human-token
  sessions.
- Enrichment / backfill scripts work correctly against any brain in
  the agent estate, not just the principal's default.
- Every write surface that becomes cross-brain capable has an
  explicit authorization rule and acceptance test.

## Non-goals

- Renaming `households` → `estates`.
- Edit / delete capabilities on thoughts beyond `/admin/thought/metadata`.
- Multi-brain graph queries.
- Federated identity for agents (Keycloak binding for agent
  principals).
- Changes to the Telegram bridge wrapper in `system-config` (cross-
  repo follow-up).

## Design decisions

### D1. Estate membership is allow-only (unchanged)

`estate_memberships` has no `is_deny`. Brain-level deny is the only
deny.

### D2. Canonical brain selector + ambiguity rule

Selector precedence and conflict rules:

- At most one of {route, query string, header} may be present. Two
  disagreeing → 400.
- If a route/query/header brain is set AND a tool-arg brain is set,
  they must resolve to the **same UUID**. Disagreement → 400.
  Detected inside the tool handler in Phase 2c.
- Slug ambiguity → 409 with both candidate UUIDs in the body.

UUIDs accepted everywhere a slug is. UUIDs disambiguate.

### D3. Operator path: stored-key principal `luchoh` + estate-admin

Operator cross-estate visibility lands via:

- Existing principal `luchoh` in `local-household`.
- New stored access key for `luchoh`: `is_admin=false`,
  `brain_id=null`, no Supabase / agent-host coupling.
- `estate_memberships(luchoh, agent-estate, role='admin')`.

Operator's home env (e.g., `~/.config/ob1/operator.env`) sets
`MCP_ACCESS_KEY=<this stored key>`. Direnv inside a repo overrides
with the repo principal key.

This path flows through the same access-check helper as agents.
Audit attribution (when ADR-27 lands) records `principal_id =
luchoh.id`. Distinct from legacy admin (`principal_id = null`).

### D4. Phase scope

**Multi-brain capable after this PRD:**
- MCP tools: `capture_thought`, `search_thoughts`, `list_thoughts`,
  `stats`, `ask_brain`.
- HTTP: `/ingest/thought`, `/ask`, `/admin/thought/similar`.

**Treated as deliberate write-surface expansion:**
- `/admin/thought/metadata` — see D7. Authorization is opt-in by
  role, not a free side-effect of read access.
- The legacy-admin branch of `/admin/thought/metadata` gains an
  **explicit `brain` selector** (D7 + Finding 3 fix). This is the
  only contract change to the legacy branch.

**Out of scope (admin-only, single-brain):**
- All `/graph/*` endpoints. `ensureGraphAdmin()` (`server.mjs:773`)
  unchanged. No `brain` parameter added.

### D5. Multi-brain reads carry brain origin (unchanged from v2)

Every multi-brain read row gains `brain_id` and `brain_slug`. `stats`
gets a multi-brain shape with per-brain counts; legacy single-brain
shape preserved when `scope="single"`.

### D6. Access-check helper — five branches (Findings 1, 2 fix)

```
function checkBrainAccess({ accessContext, brainId, requireEdit }):
  1. legacy_admin_key
       brainId == effectiveBrainId  → ALLOW
       else                          → DENY
       (single-brain by definition; preserves auth.mjs:336-364)

  2. service_key, is_admin=true
       brain.household_id == accessContext.householdId  → ALLOW
       else                                              → DENY
       (preserves auth.mjs:290-310: admin scoping is per-household,
        not global. Cross-estate admin requires the operator path D3.)

  3. service_key, brain-bound (key.brain_id != null)
       brainId == key.brain_id  → ALLOW
       else                      → DENY
       (preserves auth.mjs:299-310 contract.)

  4. service_key, not brain-bound, not admin
     OR human_token (per Finding 2: same access set, but read-time
       defaulting differs — see D9):
       brain-level allow on (principal, brain) and not deny  → ALLOW
       brain-level deny  on (principal, brain)               → DENY
       estate-level allow on (principal, brain.household_id) → ALLOW
       otherwise                                              → DENY
```

`requireEdit=true` further restricts case 4: see D7.

`listAccessibleBrainIds({ accessContext })`:

- `legacy_admin_key`: `[effectiveBrainId]`.
- `service_key, is_admin`: every brain **in the principal's household**
  (NOT every brain. Finding 1 fix.).
- `service_key, brain-bound`: `[key.brain_id]`.
- `service_key`/`human_token`, non-brain-bound: union of brain-allow
  rows + brains in estates with `estate_memberships` (allow), minus
  brain-deny rows.

### D7. `/admin/thought/metadata` authorization — role-based

The endpoint already takes a thought_id. v4 adds:

- An explicit, optional `brain` selector on the request body (slug or
  UUID). If set, it constrains the WHERE clause. **For
  legacy_admin_key, this is required when patching anything other
  than the legacy-admin default brain (Finding 3 fix).** For other
  branches, it's optional; if omitted, the WHERE clause widens to
  `listEditableBrainIds()`.
- A new helper `listEditableBrainIds({ accessContext })`:
  - `legacy_admin_key`: `[brain or effectiveBrainId]`.
  - `service_key, is_admin`: every brain in principal's household.
  - `service_key, brain-bound`: `[key.brain_id]`.
  - `service_key`/`human_token`, non-brain-bound:
    - Brains where the principal has `brain_memberships.role IN
      ('owner', 'editor')`, OR
    - Brains in estates where the principal has
      `estate_memberships.role = 'admin'` (NOT plain `'member'`).

Repo principals get `role='editor'` on `agent-common` so they can
patch their own captures there. The operator gets estate-admin on
`agent-estate` so they can patch any thought in any agent brain.

### D8. Slug resolution uses listAccessibleBrainIds() exactly (secondary fix)

Slug→UUID lookup for non-legacy callers operates over
`listAccessibleBrainIds()` exactly. There is no second narrower set.

If the slug resolves to a brain in the accessible set: return the
UUID. The access check then runs on the UUID and may return 403 or
ALLOW based on the `requireEdit` flag — that's `checkBrainAccess`,
not slug resolution.

So:

- Slug resolution: 404 if not in accessible set, 409 if multi-match,
  UUID if single match.
- Access check: ALLOW or DENY based on read vs write semantics (D6,
  D7).

A slug NEVER resolves to a brain the caller cannot read. (v3 said
that and contradicted itself; v4 says it cleanly.)

For legacy admin: slug resolution stays global
(`auth.mjs:336-364`).

### D9. Human-token sessions stay single-brain (Finding 2 fix)

`docs/17:250,548` is canon: human MCP sessions are single-brain per
connector/session. v4 preserves that:

- Human-token request flow is unchanged for routing: an explicit
  brain (route/query/header) sets the session's effective brain.
  Without one, the session uses the principal's default brain
  (`auth.mjs:217-220` semantics).
- Human-token sessions DO NOT get multi-brain default reads. A
  `search_thoughts` with no `brain` argument scopes to the session's
  effective brain only.
- Human-token CAN explicitly target other brains via the
  `brain` argument, subject to the same access-check helper. So a
  human session WITH a brain arg goes multi-brain on a per-call
  basis. Without one, single-brain.

This means the access-check helper is shared (D6 case 4), but the
**default behavior when no brain is specified differs**:

- `service_key`, non-brain-bound: defaults to `listAccessibleBrainIds()`
  on read (multi-brain).
- `human_token`: defaults to session effective brain on read
  (single-brain). Default brain on write.

Phase 2c implements the bifurcation explicitly.

### D10. Env split (unchanged from v3)

Three env vars, three roles:

- `MCP_ACCESS_KEY` — stored key for the active context: repo
  principal inside a repo, operator stored key in operator's home
  env.
- `OB1_LEGACY_ADMIN_KEY` — bare `config.accessKey` for infrastructure
  scripts. Only set in environments that need legacy admin
  (provisioning, smoke, schema migrations).
- (Existing) human-token Authorization header — unchanged.

### D11. No estate-rename in this work (unchanged)

### D12. Smoke harness contract — explicit (Finding 4 fix)

The smoke harness operates as **legacy-admin only**:

- `scripts/smoke-open-brain-running-service.sh` reads
  `OB1_LEGACY_ADMIN_KEY` (NOT `MCP_ACCESS_KEY`).
- Errors with a clear message if `OB1_LEGACY_ADMIN_KEY` is missing.
- The acceptance test is "smoke harness with legacy admin passes."
- We do **not** dual-mode the harness. If we want a
  service-key smoke test, that's a **separate** harness
  (`scripts/smoke-open-brain-service-key.sh`) introduced when the
  need arises. Not part of this PRD.

### D13. Repo principal acceptance — non-brain-bound matrix (Finding 5 fix)

Phase 3 acceptance validates the repo principal stored key against
the **non-brain-bound, multi-membership** matrix from D6 case 4 +
D7. Specifically:

- Capture with no `brain` → lands in repo brain (default).
- Capture with `brain="agent-common"` → lands there.
- Capture with `brain="<unrelated-brain>"` → 403.
- Search with no `brain` → spans repo brain + common brain (the
  principal's two memberships).
- `/admin/thought/metadata` on a thought in `agent-common`:
  - 200 if repo principal has `role='editor'` on common brain.
  - 403 if downgraded to `role='member'`.

Brain-bound matrix is for brain-bound keys (D6 case 3) — not used
here.

## Phasing

### Phase 1 — Schema (unchanged from v3)

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

**Acceptance:** unchanged from v3.

### Phase 2a — Access-check + edit-check helpers (D6, D7)

Test matrix (each combination is a CI test):

| auth branch                                          | helper                  | result |
|------------------------------------------------------|-------------------------|--------|
| legacy_admin_key, target = effectiveBrainId          | check                   | ALLOW |
| legacy_admin_key, target ≠ effectiveBrainId          | check                   | DENY  |
| service_key, is_admin, brain in principal household  | check                   | ALLOW |
| service_key, is_admin, brain in OTHER household      | check                   | DENY (Finding 1) |
| service_key, is_admin                                | listAccessible          | every brain in **principal's household** |
| service_key, brain-bound, target == key.brain_id     | check                   | ALLOW |
| service_key, brain-bound, target ≠ key.brain_id      | check                   | DENY  |
| service_key, brain-bound                             | listAccessible          | `[key.brain_id]` |
| service_key, no membership, no estate                | check                   | DENY  |
| service_key, brain-allow                             | check                   | ALLOW |
| service_key, brain-allow + role='member'             | check(requireEdit)      | DENY  |
| service_key, brain-allow + role='editor'             | check(requireEdit)      | ALLOW |
| service_key, estate-membership member                | check                   | ALLOW |
| service_key, estate-membership member                | check(requireEdit)      | DENY  |
| service_key, estate-membership admin                 | check(requireEdit)      | ALLOW |
| service_key, estate-allow + brain-deny               | check                   | DENY  |
| service_key, brain-bound + estate-allow on different brain | check               | DENY (case 3 wins) |
| human_token, brain-allow                             | check                   | ALLOW |
| human_token, no membership                           | check                   | DENY  |

`listEditableBrainIds` has its own row-equivalents.

**Acceptance:**
- ☐ Test matrix above passes in CI.
- ☐ Smoke regression (legacy-admin) unchanged.

### Phase 2b — Selector unification (D2, D8)

In `resolveAccessContext`:

- Detect simultaneous route+query, route+header, query+header → 400.
- Cache resolved session brain on `accessContext.sessionBrain` (UUID
  + slug, optional).

Slug→UUID:

- Legacy admin: global lookup, unchanged.
- Other branches: `listAccessibleBrainIds()` → 404 if not present,
  409 if multi-match.

**Acceptance:**
- ☐ `?brain=ob1` + `x-brain-slug=agent-common` → 400.
- ☐ Stored-key principal with estate-only access to estate B can
  resolve `brain=<estate-B-slug>` and reads succeed (Finding 2 from
  v2 review still relevant; same fix).
- ☐ Two estates with same slug accessible to one principal → 409
  with both UUIDs.
- ☐ Brain-bound key with mismatched slug → 404.
- ☐ Slug resolves to a brain caller cannot edit (only read) → 200
  on read, 403 on `/admin/thought/metadata` (NOT slug failure).

### Phase 2c — Tool & HTTP surfaces

**Capture path** (`capture_thought`, `/ingest/thought`):

- Optional `brain` body field.
- Tool-arg vs session-brain disagreement → 400.
- `checkBrainAccess({requireEdit: false})` then write.
- No `brain` specified:
  - `legacy_admin_key`: existing default.
  - `service_key, is_admin`: principal default brain (in principal's
    household).
  - `service_key, brain-bound`: `key.brain_id`.
  - `service_key, non-brain-bound`: `principal.default_brain_id` or
    400 if null.
  - `human_token`: session effective brain (D9).

**Read path** (`search_thoughts`, `list_thoughts`, `ask_brain`,
`/ask`, `/admin/thought/similar`):

- Optional `brain`.
- If set: scope after access check.
- If not set:
  - `legacy_admin_key`: `[effectiveBrainId]`.
  - `service_key, is_admin`: principal's accessible brains within
    household.
  - `service_key, brain-bound`: `[key.brain_id]`.
  - `service_key, non-brain-bound`: `listAccessibleBrainIds()`.
  - `human_token`: `[session effective brain]` (D9 — single-brain
    default).
- Multi-brain scope → fan out, merge, tag every row with
  `brain_id`/`brain_slug`.

**`stats`:** D5 multi-brain shape applied per scope.

**`/admin/thought/metadata`** (D7):

- Optional `brain` body field.
- WHERE clause: `id = $1 AND brain_id = ANY($2)` where:
  - `$2` is `[effectiveBrainId]` if `brain` is unset and auth source
    is `legacy_admin_key`. (To patch a non-default brain on legacy
    admin, the script MUST pass `brain=<slug>`. v3's silent failure
    is gone.)
  - `$2` is `listEditableBrainIds()` if auth source is anything else
    and `brain` is unset.
  - `$2` is `[brain.id]` if `brain` is set and `checkBrainAccess(...
    requireEdit)` allows.
- Row not found → 404 with explicit message naming the brain
  considered.
- Access denied for brain → 403.

**`/graph/*`:** unchanged. Admin-only.

**Acceptance — legacy_admin_key:**
- ☐ Smoke harness (D12) passes.
- ☐ Telegram bridge captures land where they did before.
- ☐ Existing admin metadata patch on default brain → 200 unchanged.
- ☐ Admin metadata patch on non-default brain WITHOUT `brain` → 404
  (clear message, was silent failure before).
- ☐ Admin metadata patch on non-default brain WITH `brain=<slug>` →
  200.

**Acceptance — service_key, brain-bound:**
- ☐ Capture with no `brain` → `key.brain_id`.
- ☐ Capture with `brain=<other>` → 403.
- ☐ Search no `brain` → only `key.brain_id`.

**Acceptance — service_key, non-brain-bound (REPO PRINCIPAL — Finding 5):**
- ☐ Capture with no `brain` → repo brain (principal default).
- ☐ Capture with `brain="agent-common"` → common brain.
- ☐ Capture with `brain="<unrelated>"` → 403.
- ☐ Search with no `brain` spans repo + common; rows tagged.
- ☐ Search with `brain="ob1"` → repo only.
- ☐ `/admin/thought/metadata` on common-brain thought:
  - role='member': 403.
  - role='editor': 200.
  - role='owner': 200.
  - estate-admin (operator path): 200.

**Acceptance — service_key, is_admin (cross-household NOT crossed):**
- ☐ Capture with `brain=<brain-in-principal-household>` → 200.
- ☐ Capture with `brain=<brain-in-OTHER-household>` → 403 (Finding 1).
- ☐ `listAccessible` returns only brains within the principal's
  household.

**Acceptance — human_token (Finding 2):**
- ☐ Search with no `brain` → session effective brain only.
- ☐ Search with `brain="agent-common"` (where principal has membership)
  → that brain's results.
- ☐ Search with `brain="<unrelated>"` → 403.
- ☐ Capture with no `brain` → session effective brain.

**Acceptance — selector disagreement:**
- ☐ `POST /mcp/brains/ob1` + tool-arg `brain="agent-common"` → 400.

### Phase 3 — Provisioning CLI (Finding 5 fix in acceptance)

`scripts/agent_estate/provision.py`:

- `provision-estate-and-common` (one-shot): create agent estate +
  common brain.
- `provision-repo --slug <slug>`: create repo principal + repo brain
  + memberships:
  - `brain_memberships(repo-principal, repo-brain, role='owner')`
  - `brain_memberships(repo-principal, common-brain, role='editor')`
    (D7 — editor allows patch on common brain).
  - Mint a `service_key` access key for the repo principal:
    `is_admin=false`, `brain_id=null` (non-brain-bound — Finding 5).
  - Print plaintext key once.
- `provision-operator-membership` (one-shot): mint operator stored
  key for `luchoh` (`is_admin=false`, `brain_id=null`) +
  `estate_memberships(luchoh, agent-estate, role='admin')`.
- `rotate-key --slug <slug>`: revoke + re-mint.

**Acceptance — repo principal validates against non-brain-bound matrix:**
- ☐ `listAccessibleBrainIds(repo-principal)` returns `{repo-brain,
  common-brain}`.
- ☐ Repo principal capture with no `brain` lands in repo brain.
- ☐ Repo principal capture with `brain="agent-common"` succeeds.
- ☐ Repo principal `/admin/thought/metadata` on common-brain thought
  → 200 (role='editor').
- ☐ Re-running provision is idempotent.

**Acceptance — operator path (D3):**
- ☐ `listAccessibleBrainIds(luchoh)` includes both `luchoh` brain AND
  every brain in agent estate (via estate-membership).
- ☐ Operator stored key reads across estates work.
- ☐ Operator stored key `/admin/thought/metadata` on any agent-brain
  thought succeeds (estate-admin role).

### Phase 4 — Per-repo `.envrc` (D10)

In each onboarded repo:

- `.envrc` exports `MCP_ACCESS_KEY=<repo-principal stored key>`.
- `OPEN_BRAIN_BASE_URL=http://127.0.0.1:8788`.
- The actual key value lives in a gitignored file (e.g.,
  `.ob1-mcp-access-key`).

In operator's home env:

- `~/.config/ob1/operator.env` exports `MCP_ACCESS_KEY=<operator
  stored key>`.

In environments that need legacy admin:

- `OB1_LEGACY_ADMIN_KEY` exported separately.

**Acceptance:**
- ☐ Inside `/Users/luchoh/Dev/OB1` shell, `MCP_ACCESS_KEY` resolves
  to the OB1 repo principal's stored key.
- ☐ Capture from inside the OB1 shell with no `brain` → `ob1` brain.
- ☐ Outside any repo shell (operator env), `MCP_ACCESS_KEY` resolves
  to the operator key.
- ☐ Smoke harness with `OB1_LEGACY_ADMIN_KEY` set passes (D12).

### Phase 5 — Routing skill (unchanged)

`skills/agent-brain-routing/SKILL.md`. Same routing rule as v2/v3.
System-config Nix deploy via the `live-retrieval` pattern (doc 26).

### Phase 6 — Migrate writers (Finding 3 fix)

This phase has real work, not just env renames.

**Env-var renames (mechanical):**
- `scripts/smoke-open-brain-running-service.sh`: read
  `OB1_LEGACY_ADMIN_KEY` only (D12).
- `recipes/dictation-import/`, `recipes/document-import/` ingest
  scripts: read `OB1_LEGACY_ADMIN_KEY` for legacy-admin operations,
  or migrate to operator stored key (preferred).

**Auth migration for enrichment scripts (Finding 3 — required, not
optional):**

`scripts/thought_enrichment/*` currently:
- Reads via asyncpg (brain-scoped from `--brain-id`).
- Writes via `/admin/thought/metadata` with no `brain` selector.

This is broken for any non-default brain. Two options; pick one:

**(a) Migrate to operator stored key + explicit `brain` arg.**
- Scripts read `MCP_ACCESS_KEY=<operator stored key>` (operator's
  home env, set up in Phase 4).
- Scripts pass `brain=<UUID>` (the same `--brain-id` they already
  scope reads by) on every patch call.
- Operator key has estate-admin on agent-estate AND owner on
  `luchoh` brain → can patch any thought in any agent brain or the
  human brain.
- Patch succeeds against any brain the operator can edit.

**(b) Keep legacy-admin, add `brain=` to admin metadata patch.**
- Scripts read `OB1_LEGACY_ADMIN_KEY`.
- `lib/db.py:patch` always passes `brain=<UUID>` to
  `/admin/thought/metadata`.
- Server-side legacy-admin branch honors the `brain` body field
  (D7 + Finding 3 fix).

v4 picks **(a)**. Reasons:
- Audit attribution (when ADR-27 lands) gets a real `principal_id =
  luchoh.id` instead of legacy-admin's null.
- Operator key flows through the same access-check helper as
  agents — one consistent test path.
- Legacy admin stops being load-bearing for enrichment (still
  load-bearing for smoke + provisioning).

`scripts/thought_enrichment/lib/db.py:patch` — pass `brain=<UUID>` on
every call. The brain UUID is the script's `--brain-id` argument,
already in scope.

**Other writers (no change required):**
- Telegram bridge — unchanged. Wrapper still sets `MCP_ACCESS_KEY` to
  legacy admin until a separate system-config handoff lands.
- FastAPI document/dictation/email ingest — uses legacy admin via the
  bridge convention. No change.
- Autodream-brain-sync skill — uses MCP from the AI client; key comes
  from client config. May be repo-key (if AI client runs in a repo)
  or operator key (outside any repo). No code change.

**Acceptance:**
- ☐ Smoke harness with `OB1_LEGACY_ADMIN_KEY` passes (D12 contract).
- ☐ `scripts/thought_enrichment/enrich.py --status --brain-id <prod-luchoh>` works against operator stored key.
- ☐ `scripts/thought_enrichment/enrich.py --apply --brain-id <prod-luchoh>` patches succeed (every patch carries `brain=<UUID>`).
- ☐ `scripts/thought_enrichment/enrich.py --apply --brain-id <agent-common>` patches succeed (operator has estate-admin on agent-estate).
- ☐ Without operator stored key set, scripts error clearly with
  "MCP_ACCESS_KEY is missing or not authorized for brain X."

## Risks and mitigations

- **Operator stored-key compromise.** This key has estate-admin
  rights across agent estate. If leaked, an attacker can patch any
  agent thought. Mitigation: same protection model as the legacy
  admin key today (mode 0400, agenix-managed where deployed). v4
  doesn't make this worse than today's bootstrap-admin posture.
- **Brain-bound stored keys.** D6 case 3 enforces narrowness;
  Phase 2a tests cover this. Without those tests, would be a real
  regression.
- **Human-token sessions silently going multi-brain.** D9 + Phase 2c
  bifurcate the default. Without the bifurcation, the
  `docs/17:250,548` contract breaks.
- **Enrichment migration to operator key.** Scripts now require
  operator key, not legacy admin. Mitigation: Phase 6's clear error
  message names the env var. Any environment running the enrichment
  scripts pre-migration must set `MCP_ACCESS_KEY` to the operator
  stored key.
- **`/admin/thought/metadata` is now a real edit surface.** D7 limits
  it. Audit log lands separately (ADR-27).
- **Slug ambiguity surfaces under multiple-estate access.**
  Synthetic-test in Phase 2b acceptance.
- **Cross-household admin scoping (D6 case 2).** Confirmed against
  `auth.mjs:290-310`. Today's behavior preserved exactly.

## Out of scope, tracked separately

- Renaming `households` → `estates`.
- Brain-qualified graph projections + multi-brain graph queries.
- `update_thought_mcp` / `delete_thought_mcp` MCP tools.
- Thought-audit log (ADR-27).
- Telegram bridge wrapper env split (system-config follow-up).
- Recurring backup design (task #14).
- A separate service-key smoke harness (D12 — when the need
  appears).
- Human-token federation for agent principals.

## Open questions

- D7 chose role-based edit gating over a per-row `editable` predicate
  on `brain_memberships`. Reversible if a future case calls for it.
- Should the legacy admin key be deprecated entirely after Phase 6,
  given enrichment moves off it? Smoke + provisioning still use it.
  Defer to a future ADR.
- D9 bifurcates default-brain-on-no-arg between `service_key` and
  `human_token`. Is that a permanent contract or a transition state
  toward "human sessions also go multi-brain by explicit opt-in"?
  Defer to a future ADR after operator usage data accumulates.
