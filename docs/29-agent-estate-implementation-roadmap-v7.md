# PRD: Agent Estate + Brain Selection — Implementation Roadmap (v7)

Date: 2026-06-02
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`,
           CONTEXT `CONTEXT.md`,
           reviews v1–v6
Supersedes: v1, v2, v3, v4, v5, v6

## Why v7

v6 was rejected on three real bugs and two secondary gaps. Each
finding is grounded in a specific seam the doc still got wrong:

1. **Phase 7 acted on `brain_access_keys` rows when legacy-admin
   privilege actually flows from `config.accessKey` (env).** v6
   path (b) was fiction. Updating a row's `is_admin=false` does not
   reduce legacy-admin's privileges because the runtime never reads
   that row.
2. **Human-token has no brain-selection path on non-MCP HTTP
   routes.** v6 forbade query/header for human-token and left only
   the MCP route form (`POST /mcp/brains/:brainSlug`) — which doesn't
   exist for `/ingest/thought`, `/ask`, `/admin/thought/metadata`,
   `/admin/thought/similar`. So those routes have no honest
   cross-brain mechanism for human-token at all.
3. **D6 case 1 authorized two brains for legacy admin.** When a
   non-default `requestBrain` was set, the helper still allowed the
   legacy-admin default brain too. The rest of the doc assumed
   single-brain. Helper contradicted handler.

Plus two secondary fixes:

4. The access-check endpoint reused `brain` as its query param,
   colliding with the L1 selector convention. Different name.
5. Estate-membership `role='member'` granting create-rights across
   every brain in the estate was both "settled" and "open question."
   v7 closes it: it's a real permission choice, decided here.

## Vocabulary recap

(Unchanged from v6; defined in `CONTEXT.md`.)

## Layering model (refined)

The four layers from v6 stand. v7 adds a **per-route admissibility
matrix** for L1 selectors so non-MCP HTTP routes are not silently
lost (Finding 2 fix).

```
   ┌────────────────────────────────────────────────────┐
   │ L1. Auth selector (route slug, query, header)      │
   │     → produces accessContext.requestBrain          │
   │     bound at resolveAccessContext time              │
   └─────────────────────┬──────────────────────────────┘
                         │
   ┌─────────────────────▼──────────────────────────────┐
   │ L2. Auth context (auth source, principal,           │
   │     householdId, key.brain_id, isAdmin,             │
   │     requestBrain) — fresh per HTTP request          │
   └─────────────────────┬──────────────────────────────┘
                         │
   ┌─────────────────────▼──────────────────────────────┐
   │ L3. Per-call brain resolution (tool-arg `brain`     │
   │     OR body field on non-MCP HTTP)                  │
   │     → resolves slug to UUID via D8.                 │
   │       Detects requestBrain disagreement → 400.      │
   └─────────────────────┬──────────────────────────────┘
                         │
   ┌─────────────────────▼──────────────────────────────┐
   │ L4. Access check (read | write | edit)             │
   │     → ALLOW/DENY based on auth source +            │
   │       memberships + role + brain UUID.             │
   └────────────────────────────────────────────────────┘
```

Two non-negotiable rules unchanged from v6:

- Body fields never cross up into L1 or L2.
- L1 admissibility is per-auth-source (D2).

New in v7:

- **L3 admissibility is per-route AND per-auth-source** (D2 +
  Finding 2 fix). Some routes accept body `brain`; some don't. For
  human-token specifically, body `brain` on non-MCP HTTP is the only
  cross-brain mechanism available, so it MUST be admissible there.

## Goals (unchanged from v6)

## Non-goals (unchanged from v6)

## Design decisions

### D1. Estate membership is allow-only (unchanged)

`estate_memberships` has no `is_deny`. Brain-level deny is the only
deny.

### D2. Selector model — per-auth-source admissibility AND per-route admissibility (Finding 2 fix)

L1 sources unchanged: route, query string, header. Two simultaneous
L1 sources disagreeing → 400.

**L1 admissibility per auth source (unchanged from v6 except for
human-token's softening on non-MCP HTTP):**

| auth source        | route | query | header |
|--------------------|:-----:|:-----:|:------:|
| `human_token` MCP  | yes   | NO    | NO     |
| `human_token` non-MCP HTTP | route doesn't exist on these routes (`/ingest/thought`, `/ask`, etc.) — no route L1 available |
| `service_key`      | yes (MCP only) | yes | yes |
| `legacy_admin_key` | yes (MCP only) | yes | yes |

For non-MCP HTTP routes (`/ingest/thought`, `/ask`,
`/admin/thought/metadata`, `/admin/thought/similar`), there is no
route L1 — the route doesn't carry a brain slug. So the only L1
selectors available there are query and header.

**L3 admissibility per route:**

| route                          | body `brain` field admitted? |
|--------------------------------|:---------------------------:|
| MCP `capture_thought` arg      | yes (per-call) |
| MCP `search_thoughts` arg      | yes |
| MCP `list_thoughts` arg        | yes |
| MCP `stats` arg                | yes |
| MCP `ask_brain` arg            | yes |
| `/ingest/thought` body         | yes |
| `/ask` body                    | yes |
| `/admin/thought/metadata` body | yes |
| `/admin/thought/similar` body  | yes |
| `/graph/*`                     | NO (admin-only, single-brain) |

**L1 + L3 interaction:**

- If `requestBrain` (L1) is set AND tool-arg/body `brain` (L3) is set:
  must resolve to same UUID, else 400.
- If only L1: handler scopes to `requestBrain`.
- If only L3: handler resolves L3 via D8, runs L4 access check.
- If neither: handler default per D9.

**Finding 2 fix — human-token on non-MCP HTTP:**

Human-token requests on non-MCP HTTP routes have:
- No route L1 available (the route doesn't carry a slug).
- Query and header L1 forbidden by the table above (human-token
  rejects them at 400).
- That would leave human-token with no L1 selector at all on these
  routes.

Therefore, for **human-token on non-MCP HTTP**, the body `brain`
field IS the brain-selection mechanism (L3-only). It is treated as
the explicit override. L4 access check runs as normal.

This means human-token on:
- MCP routes: route-form L1 only (`POST /mcp/brains/:brainSlug`),
  body `brain` must match `requestBrain` if both set.
- Non-MCP HTTP: body `brain` (L3-only, no L1 needed). If body
  `brain` is unset, scope to `principal.default_brain_id`.

This preserves `docs/17:548`'s "explicit server-supported override"
on non-MCP/admin flows. Honest about the route topology.

### D3. Operator path (unchanged from v6)

### D4. Phase scope (unchanged from v6)

### D5. `stats` response shape (unchanged from v6)

### D6. Access-check helper — three modes, single-brain legacy admin (Finding 3 fix)

The fix: **legacy admin allows exactly one brain per request, never
two**. v6's `OR` clause is replaced with a precedence rule.

```
Effective brain for legacy_admin_key:
  - if accessContext.requestBrain is set: that brain
  - else: legacy-admin default brain (resolveDefaultAdminBrain())

L4. checkBrainAccess({accessContext, brainId, mode}):

1. legacy_admin_key
     brainId == effectiveBrainForLegacyAdmin(accessContext)  → ALLOW
     else                                                     → DENY
   (Finding 3: single-brain. If requestBrain points at non-default,
    default brain is DENIED.)

2. service_key, is_admin=true
     brain.household_id == accessContext.householdId          → ALLOW
     else                                                      → DENY

3. service_key, brain-bound (key.brain_id != null)
     brainId == key.brain_id                                  → ALLOW
     else                                                      → DENY

4. service_key, non-brain-bound, non-admin
   OR human_token (read/write/edit; mode-dependent):
     brain-level deny on (principal, brain)                    → DENY
     mode='read':
       brain-level allow on (principal, brain)                → ALLOW
       estate-level allow on (principal, brain.household_id)   → ALLOW
       otherwise                                                → DENY
     mode='write':
       brain-level allow on (principal, brain) AND
         role IN ('owner','editor','member')                  → ALLOW
       estate-level allow on (principal, brain.household_id) AND
         role='admin'                                          → ALLOW
                                          (D12: see below)
       otherwise                                                → DENY
     mode='edit':
       brain-level allow on (principal, brain) AND
         role IN ('owner','editor')                           → ALLOW
       estate-level allow on (principal, brain.household_id) AND
         role='admin'                                          → ALLOW
       otherwise                                                → DENY
```

`listAccessibleBrainIds({accessContext, mode})`:

- `legacy_admin_key`: `[effectiveBrainForLegacyAdmin]` regardless of
  mode. Always exactly one brain.
- `service_key, is_admin`: every brain in
  `accessContext.householdId`, regardless of mode.
- `service_key, brain-bound`: `[key.brain_id]`, regardless of mode.
- Other branches: per-mode.

### D7. `/admin/thought/metadata` — L3+L4 only (refined for legacy admin)

For legacy_admin_key:
- Body `brain` field: ignored at L1/L2 layer (it's L3-only).
- BUT v7 D6 case 1 single-brain rule applies. WHERE clause uses
  `effectiveBrainForLegacyAdmin(accessContext)`. If body `brain` is
  set AND it doesn't match that effective brain → 400 with explicit
  message. (This is more honest than v6's "ignored" — body `brain`
  CAN be set for legacy admin, but it must agree with the L1
  effective brain, or the request is malformed.)

For other branches (service_key non-brain-bound, human_token, etc.):
- Body `brain` resolves via D8.
- L4 `checkBrainAccess({mode: 'edit'})`.
- WHERE clause: `id = $1 AND brain_id = ANY($2)` where `$2 =
  listAccessibleBrainIds({mode: 'edit'})` if no body brain, else
  `[brain.id]`.

### D8. Slug-vs-UUID resolution (unchanged from v6)

`resolveBrainSlug` returns UUID, 404, or 409. `resolveBrainUuid`
returns UUID, 403, or 404. Slug-not-in-accessible-set → 404.
UUID-not-in-accessible-set → 403.

### D9. Human-token request-scoped binding (refined for non-MCP HTTP — Finding 2 fix)

`docs/17:250,548` is canon. v7 enforces it as request-scoped:

**For human-token on MCP routes:**
- L1 admissibility: route only.
- `requestBrain = route brain ?? principal.default_brain_id`.
- L3 (tool-arg `brain`): must equal `requestBrain`, else 400.
- Read/write defaults: scope to `requestBrain` only.

**For human-token on non-MCP HTTP routes (Finding 2 fix):**
- L1 admissibility: none (route doesn't take a slug; query and
  header are forbidden for human-token at L1).
- L3 admissibility: body `brain` field IS admitted. This is the
  intentional override path for non-MCP HTTP.
- `requestBrain` is NULL on these routes for human-token.
- If body `brain` is set: resolve via D8, check via L4 with the
  appropriate mode for the route (edit for `/admin/thought/metadata`,
  write for `/ingest/thought`, read for `/ask` and
  `/admin/thought/similar`).
- If body `brain` is unset: scope to
  `principal.default_brain_id`. If null → 400.

Service key sessions are NOT subject to this constraint. For
service keys, query/header L1 IS admissible on non-MCP HTTP, AND
body `brain` is also admitted at L3.

The handler-side enforcement of D9 is a single check at the top of
each tool/route handler:

```
if accessContext.authSource == "human_token":
  if MCP route AND requestBrain is set AND tool_arg.brain != requestBrain: 400
  if MCP route AND requestBrain is null AND tool_arg.brain is set: 400
    (human-token MCP needs route L1 for cross-brain)
  if non-MCP HTTP: body `brain` is the only path; no requestBrain check.
```

### D10. Env split (unchanged from v6)

### D11. Stored `is_admin` provisioning policy (refined; Finding 1 partial fix)

The policy half: provisioning CLI refuses `is_admin=true` without
`--allow-admin`. Warns about existing admin keys.

The enforcement half moves entirely into D14 (formerly Phase 7), with
honesty about what enforcement actually means at the runtime layer
(see D14 below). `brain_access_keys` rows are NOT the legacy-admin
choke point; `config.accessKey` is.

### D12. Estate-membership `role='member'` does NOT grant cross-brain write (Finding 5 fix)

v6 was inconsistent: D6 mode='write' allowed estate role='member'
to write into every brain in the estate, while the open-questions
section listed it as undecided.

v7 decides: **estate-membership grants READ ONLY by default.** Write
and edit through estate-membership require `role='admin'` on the
estate.

This is the more conservative choice and matches the operator path
intent (D3): the operator gets `role='admin'` on the agent estate
specifically because cross-estate write/edit is sensitive. Plain
estate-`member` (e.g., a future "household-shared read-only viewer")
should not silently inherit write rights into every brain.

D6 mode='write' / mode='edit' for estate-membership: ONLY
`role='admin'` allows. mode='read' allows both `'admin'` and
`'member'`.

This also closes the "open question" v6 left dangling. Brain-level
membership still has its own role hierarchy
(`'member'` < `'editor'` < `'owner'`) for per-brain writes.

### D13. Smoke harness contract (unchanged from v6)

### D14. Legacy-admin enforcement — `config.accessKey` rotation, not table rows (Finding 1 fix)

v6's Phase 7 acted on the wrong object. v7 fixes the layer:

**The legacy-admin layer is `config.accessKey` (from
`MCP_ACCESS_KEY` env).** Removing or rotating that env var is the
only mechanism that disables the legacy-admin auth branch in
`auth.mjs:380`. Updating `brain_access_keys` rows does nothing for
this auth source.

v7's Phase 7 (renamed: "Phase 7 — Legacy-admin layer hygiene") has
two paths, with Codex Finding 1 in mind:

**Path (a) — Strict cutover.** Remove `MCP_ACCESS_KEY` env from
the prod runtime entirely. The legacy-admin auth branch becomes
unreachable. All callers must use stored keys (operator,
repo-principal) or human-token. Requires:
- All current legacy-admin callers (smoke, schema migration,
  enrichment, Telegram bridge wrapper, FastAPI ingest paths) to be
  migrated to stored keys.
- The bridge wrapper in system-config to set
  `OB1_LEGACY_ADMIN_KEY` (or a different mechanism) instead of
  `MCP_ACCESS_KEY`.
- The MCP server config to NOT set `accessKey` (so
  `config.accessKey` is undefined).

**Path (b) — Documented containment, no removal.** Keep
`config.accessKey` set but document its single-brain semantics
(D6 case 1) and policy that no new agent or human path uses it.
Verify this with grep + a periodic check that no new callers have
adopted it. This is "honest about what we're not doing."

v7 picks **(b) for this PRD's scope**. Reasons:
- Path (a) requires a system-config change (bridge wrapper) and a
  prod-runtime env-var removal. That's a separate operational risk
  window.
- Path (b) is in-repo only and doesn't change behavior; it just
  formalizes the constraint.
- A separate handoff doc tracks path (a) for a future deployment
  cycle.

Phase 7 acceptance now reflects this:
- ☐ A grep + audit of the codebase confirms no new in-repo caller
  uses `MCP_ACCESS_KEY` to talk to legacy-admin (rather, scripts
  use `OB1_LEGACY_ADMIN_KEY` per Phase 6).
- ☐ The runtime documentation (likely `local/open-brain-mcp/README.md`
  or this PRD's "operational notes") states that legacy admin is
  load-bearing only for the Telegram bridge wrapper until that
  wrapper is migrated in system-config.
- ☐ Provisioning CLI (Phase 3) does NOT mint `is_admin=true` keys
  by default (D11), so no new admin paths appear in
  `brain_access_keys`.

The `bootstrap-admin` row in `brain_access_keys` remains active.
Whether to deactivate it is irrelevant to legacy-admin privilege
since legacy-admin doesn't read that row. We track separately:
"is the bootstrap-admin key (or any stored `is_admin=true` key)
actually used anywhere?" If grep finds zero callers using it, it
can be deactivated as cleanup, but that's stored-key hygiene
(D11), not legacy-admin enforcement.

### D15. `/admin/thought/access-check` query param renamed (Finding secondary 1 fix)

The endpoint takes `?target_brain=<slug-or-uuid>` instead of
`?brain=`. Reasons:
- `brain` is the L1 selector keyword. Using it as a request
  parameter blurs the layer boundary.
- `target_brain` makes the intent explicit: "tell me about my
  access to this specific brain" — this is L3-style introspection,
  not an L1 selector.

The endpoint's response shape (D8) is unchanged.

### D16. No estate-rename in this work (unchanged)

## Phasing

### Phase 1 — Schema (unchanged from v6)

Migration `009_estate_memberships.sql`. `estate_memberships` table
+ `brain_memberships.is_deny` column + indexes.

**Acceptance:** unchanged.

### Phase 2a — Helpers + access-check + access-check endpoint

Implement (per D6 with three modes; per D8 with split slug/UUID
paths; per D15 with renamed param):

- `checkBrainAccess({accessContext, brainId, mode}) → {allowed, reason}`
- `listAccessibleBrainIds({accessContext, mode}) → uuid[]`
- `resolveBrainSlug({accessContext, slug})`
- `resolveBrainUuid({accessContext, brainId})`
- `effectiveBrainForLegacyAdmin(accessContext)` (helper, used in
  case 1)
- `GET /admin/thought/access-check?target_brain=<slug-or-uuid>` HTTP
  route per D8/D15.

**Test matrix (revised for v7):**

| auth branch                                                | mode  | scenario                                    | expected |
|------------------------------------------------------------|-------|---------------------------------------------|----------|
| legacy_admin_key, requestBrain=null, target=default        | any   | check                                       | ALLOW |
| legacy_admin_key, requestBrain=null, target≠default        | any   | check                                       | DENY |
| legacy_admin_key, requestBrain=X, target=X                 | any   | check                                       | ALLOW |
| legacy_admin_key, requestBrain=X, target=default (≠X)      | any   | check (Finding 3: must be DENY)             | DENY (NEW) |
| legacy_admin_key, requestBrain=X                           | any   | listAccessible                              | `[X]` (NOT `[X, default]`) |
| legacy_admin_key, requestBrain=null                        | any   | listAccessible                              | `[default]` |
| service_key is_admin, brain in household                   | any   | check                                       | ALLOW |
| service_key is_admin, brain in OTHER household             | any   | check                                       | DENY |
| service_key brain-bound, target == key.brain_id            | any   | check                                       | ALLOW |
| service_key brain-bound, target ≠ key.brain_id             | any   | check                                       | DENY |
| service_key non-brain-bound, no membership                 | any   | check                                       | DENY |
| service_key non-brain-bound, brain-allow role='member'     | read  | check                                       | ALLOW |
| service_key non-brain-bound, brain-allow role='member'     | write | check                                       | ALLOW |
| service_key non-brain-bound, brain-allow role='member'     | edit  | check                                       | DENY |
| service_key non-brain-bound, brain-allow role='editor'     | edit  | check                                       | ALLOW |
| service_key non-brain-bound, brain-allow role='owner'      | edit  | check                                       | ALLOW |
| service_key non-brain-bound, estate-member                 | read  | check                                       | ALLOW |
| service_key non-brain-bound, estate-member                 | write | check (D12: NOT ALLOW for plain member)     | DENY |
| service_key non-brain-bound, estate-member                 | edit  | check                                       | DENY |
| service_key non-brain-bound, estate-admin                  | read  | check                                       | ALLOW |
| service_key non-brain-bound, estate-admin                  | write | check                                       | ALLOW |
| service_key non-brain-bound, estate-admin                  | edit  | check                                       | ALLOW |
| service_key non-brain-bound, estate-allow + brain-deny     | any   | check                                       | DENY |
| human_token, brain-allow                                    | read  | check                                       | ALLOW |
| human_token, no membership                                  | any   | check                                       | DENY |
| any, slug not in accessible set                            | n/a   | resolveBrainSlug                            | 404 |
| any, slug matches multiple                                 | n/a   | resolveBrainSlug                            | 409 |
| any, UUID not in `brains`                                   | n/a   | resolveBrainUuid                            | 404 |
| any, UUID exists but inaccessible                          | n/a   | resolveBrainUuid                            | 403 |

Endpoint test matrix:

| endpoint input                                                       | expected |
|----------------------------------------------------------------------|----------|
| `?target_brain=<slug-in-accessible-set>` (any non-legacy)            | 200 |
| `?target_brain=<slug-not-in-accessible-set>` (legacy admin)          | 200 (global resolution) |
| `?target_brain=<slug-not-in-accessible-set>` (service_key)           | 404 |
| `?target_brain=<UUID-of-accessible-brain>`                           | 200 |
| `?target_brain=<UUID-of-existing-but-inaccessible-brain>` (service_key) | 403 |
| `?target_brain=<UUID-not-in-brains>`                                 | 404 |
| no `?target_brain=`                                                  | 400 |
| no auth                                                              | 401 |

**Acceptance:**
- ☐ Test matrix above passes.
- ☐ Smoke regression unchanged.

### Phase 2b — Selector unification with per-auth-source AND per-route admissibility (Finding 2 fix)

In `resolveAccessContext`:
- Detect simultaneous L1 sources (route+query, route+header,
  query+header) → 400.
- For `human_token`: reject query and header L1 selectors → 400.
  Only route L1 admitted (and only on MCP routes; non-MCP HTTP has
  no route L1 — `requestBrain` stays null on those routes).
- For other auth sources: any of the three is admitted on routes
  that support them.
- Set `accessContext.requestBrain` from L1.

**Acceptance:**
- ☐ MCP `?brain=ob1` + `x-brain-slug=agent-common` → 400.
- ☐ MCP human-token request with `?brain=ob1` → 400.
- ☐ MCP human-token request with `x-brain-slug=ob1` → 400.
- ☐ MCP human-token request via `POST /mcp/brains/ob1` → 200.
- ☐ Service-key request with `?brain=ob1` → 200.
- ☐ Non-MCP HTTP human-token POST `/ingest/thought` with body
  `brain="ob1"` → 200 (NEW: D9 + Finding 2 fix).
- ☐ Non-MCP HTTP human-token POST `/ingest/thought` without body
  `brain` → scopes to `principal.default_brain_id`.
- ☐ Stored-key principal with estate-only access can read brain in
  estate B.
- ☐ Two estates with same slug accessible to one principal → 409.
- ☐ Brain-bound key with mismatched slug → 404.
- ☐ Slug resolves to a brain caller can read but not edit → 200 on
  read, 403 on `/admin/thought/metadata`.

### Phase 2c — Tool & HTTP surfaces

(Unchanged from v6 except for the Finding 3 + Finding 2 + Finding 5
fixes baked into D6, D9, D12 above.)

**Acceptance — legacy_admin_key (Finding 3 fix):**
- ☐ Smoke harness passes.
- ☐ Without route L1, default brain works.
- ☐ With route L1 `POST /mcp/brains/<other>`, the OTHER brain is
  the only one accessible. Default brain DENIED. (NEW Finding 3
  test.)
- ☐ Patch with body `brain` mismatching effective brain → 400 with
  explicit "legacy admin requires body brain to match request L1
  selector or default."
- ☐ Documented in error response that legacy admin is single-brain.

**Acceptance — service_key, non-brain-bound (REPO PRINCIPAL):**
- (As in v6, plus D12 estate-member writes are now DENY:)
- ☐ Capture with no `brain` → repo brain.
- ☐ Capture with `brain="agent-common"`, brain-membership
  role='editor' → 200.
- ☐ Capture with `brain="agent-common"`, brain-membership
  role='member' → 200.
- ☐ Capture with `brain="agent-common"`, ONLY estate-member on
  agent-estate (no brain-membership) → 403 (D12 fix).
- ☐ Capture with `brain="agent-common"`, estate-admin on
  agent-estate → 200.
- ☐ Capture with `brain="<unrelated>"` → 403.
- ☐ Search with no `brain` → spans accessible brains.
- ☐ `/admin/thought/metadata`:
  - role='member' on common: 403.
  - role='editor': 200.
  - role='owner': 200.
  - estate-admin: 200.
  - estate-member only: 403.

**Acceptance — service_key, is_admin (unchanged from v6).**

**Acceptance — human_token (Finding 2 fix):**
- (Unchanged for MCP routes from v6.)
- ☐ Non-MCP HTTP `/ingest/thought` body `brain="agent-common"` (with
  brain-membership role='member' or higher) → 200.
- ☐ Non-MCP HTTP `/ingest/thought` body `brain="<unrelated>"` →
  403.
- ☐ Non-MCP HTTP `/ingest/thought` no body `brain` → default brain.
- ☐ Non-MCP HTTP `/admin/thought/metadata` body `brain="agent-common"`
  with role='editor' → 200.
- ☐ Non-MCP HTTP `/admin/thought/metadata` body `brain="agent-common"`
  with estate-member only → 403 (D12).

**Acceptance — selector disagreement (unchanged from v6).**

**Acceptance — `stats` shape (unchanged from v6 D5).**

### Phase 3 — Provisioning CLI (unchanged from v6)

`scripts/agent_estate/provision.py`. Subcommands and policies as
in v6 (D11). New: D12 means `provision-repo` mints
`brain_memberships(repo-principal, common-brain, role='editor')`
(unchanged from v6) — but it does NOT need to also grant
estate-membership to repo principals. Repo principals get cross-repo
visibility via brain-membership only, not estate-membership.

This is consistent with D12: estate-membership is operator-only
(luchoh has estate-admin). Repo principals don't have any
estate-membership row at all. They get common-brain access via
the `brain_memberships` row that the CLI mints.

**Acceptance:** unchanged from v6. Plus:
- ☐ Repo principal does NOT have an `estate_memberships` row in the
  agent estate (verifies D12 design).
- ☐ Repo principal can read AND write to common brain (via
  brain-membership role='editor').
- ☐ Repo principal cannot read brains in agent estate that they
  don't have a `brain_memberships` row for. (Verifies estate-membership
  is operator-only.)

### Phase 4 — Per-repo `.envrc` (unchanged from v6)

### Phase 5 — Routing skill (unchanged from v6)

### Phase 6 — Migrate writers (refined for D15 endpoint name)

`scripts/thought_enrichment/*` and other operator scripts:
- Read `OB1_OPERATOR_ACCESS_KEY` only.
- Startup preflight: `GET /admin/thought/access-check?target_brain=<UUID>`
  (note D15 param rename). Per D8 UUID contract.
- Patches send body `brain=<UUID>` on every call.

(Otherwise unchanged from v6.)

### Phase 7 — Legacy-admin layer hygiene (Finding 1 fix; renamed and rescoped)

Replaces v6's "bootstrap-admin deactivation" Phase 7. v7 reframes
this around what actually disables legacy-admin: `config.accessKey`,
not `brain_access_keys` rows.

Phase 7 (this PRD scope, path (b) per D14):
- Audit: grep the codebase for `MCP_ACCESS_KEY` direct uses. Confirm
  that all in-repo callers either:
  - read `OB1_OPERATOR_ACCESS_KEY` (operator scripts), or
  - read `OB1_LEGACY_ADMIN_KEY` (smoke, schema-migration scripts), or
  - use the env-var as a downstream pass-through (e.g., a shell
    invocation that inherits the calling shell's env).
- Document: legacy admin is load-bearing only for the Telegram bridge
  wrapper (system-config) until that wrapper is migrated. This is
  in this PRD's "operational notes" plus a one-line note in
  `local/open-brain-mcp/README.md` if it doesn't already say so.
- Provisioning policy (D11): CLI refuses to mint `is_admin=true`
  without `--allow-admin`. Warns about existing admin keys.

Phase 7 (out of this PRD scope, path (a)):
- System-config follow-up handoff doc: rotate
  `MCP_ACCESS_KEY` out of the prod runtime entirely. Bridge wrapper
  must be updated to set a different env var first. Tracked in the
  out-of-scope section.

**Acceptance:**
- ☐ `grep MCP_ACCESS_KEY` over `scripts/`, `recipes/`,
  `integrations/` shows no in-repo caller relying on it as a
  legacy-admin key (only as a downstream pass-through, if any).
- ☐ Documentation update lands (PRD + README note).
- ☐ Provisioning CLI refuses admin keys without `--allow-admin`.
- ☐ Document explicitly: deactivating `bootstrap-admin` row would NOT
  reduce legacy-admin privilege; that's `MCP_ACCESS_KEY` env-var
  hygiene, deferred to system-config.

## Risks and mitigations

- **Body field promoted to L1 by accident.** Tests in Phase 2c.
- **Human-token contract drift on non-MCP HTTP.** D9 + Finding 2
  fix. Body `brain` is the explicit override path on non-MCP HTTP,
  with full L4 enforcement. Tests in Phase 2b/2c.
- **Operator scripts run with wrong key.** D10 + D13. Tests in
  Phase 6.
- **Legacy-admin enforcement is at the env layer, not the table
  layer.** D14 makes this explicit. Phase 7 is now honest about
  what's in-scope (audit + policy) vs deferred (env-var rotation).
- **Stored `is_admin` keys remain technically possible.** D11
  refusal-by-default + warnings. Existing `bootstrap-admin` row is
  a separate cleanup question (deactivate if unused; leave if used).
- **Estate-member writes (D12).** v7 narrows them to read-only.
  Repo principals get common-brain write rights via brain-membership,
  not estate-membership. Tests in Phase 2c.
- **`/admin/thought/access-check` param naming.** D15 uses
  `target_brain` to keep the L1 selector keyword (`brain`)
  unambiguous.
- **Multi-brain search latency.** Parallel fanout; small N.

## Out of scope, tracked separately

(Same as v6, plus:)
- **`MCP_ACCESS_KEY` rotation in prod runtime (Phase 7 path (a)).**
  Requires system-config bridge wrapper migration. Tracked as a
  future handoff doc.
- **Stored `bootstrap-admin` row deactivation as standalone cleanup.**
  Independent of legacy-admin enforcement (which is `config.accessKey`,
  not table-row). Defer until grep audit confirms no callers use
  the bootstrap stored key.
- **Service-key smoke harness.**
- **Human-token federation for agent principals.**
- **Brain-qualified human-token routes for non-MCP HTTP** (e.g.,
  `POST /admin/brains/:brainSlug/thought/metadata` as an alternative
  to body-based selection). Defer; v7's body-`brain` path is the
  current spec.

## Open questions

- D14 path (a) timing: when does system-config get the bridge wrapper
  update? Defer; a handoff doc tracks it.
- D12's narrowing of estate-member writes — does any future
  household-shared use case (multiple humans) need write through
  estate-member? Defer; provisioning CLI grants brain-membership
  explicitly when needed.
- Should brain-bound stored keys be deprecated entirely as the
  agent-estate pattern matures? Brain-bound was useful when the
  schema was the only enforcement layer. With D6 + estate-membership,
  the same effect is achievable via brain-membership without the
  schema-level binding. Defer.
