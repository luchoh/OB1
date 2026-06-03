# PRD: Agent Estate + Brain Selection — Implementation Roadmap (v6)

Date: 2026-06-02
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`,
           CONTEXT `CONTEXT.md`,
           reviews v1, v2, v3, v4, v5
Supersedes: v1, v2, v3, v4, v5

## Why v6

v5's review surfaced three real bugs and two secondary gaps. The
recurring theme is honesty about the runtime: v5 used "session"
language that the live server doesn't implement (every HTTP request
resolves access fresh, no session state); promised an endpoint
behavior whose own selector rules it broke; introduced a third
permission mode mid-phase instead of in the helper contract; and
claimed compatibility on a `stats` shape that is actually changing.

v6 rewrites with no fictions:

1. **Human-token: route-only L1.** Reject `?brain=` and
   `x-brain-slug` for human-token requests. Brain switching requires
   a new `POST /mcp/brains/:brainSlug` request. Per-request, not
   per-session, but enforced as request-scoped binding for that auth
   source. No "session" language survives.
2. **`/admin/thought/access-check`: explicit slug vs UUID rules,
   one failure contract.** Separate D8 into two paths
   (slug-resolution and UUID-existence) and pin the failure mode
   for inaccessible UUIDs to **403** consistently. Slug-not-in-
   accessible-set keeps 404 (avoids enumeration of brain slugs across
   estates); UUID-not-accessible returns 403 (UUID is already opaque,
   no information leak).
3. **`requireWrite` lives in D6 from the start.** Phase 2a tests it.
   Phase 2c does not "introduce" anything new at the handler layer.
4. **`stats` response shape declared honestly.** v6 spells out the
   exact response payload for each scope, including the new fields
   that ARE being added, and how to keep `top_sources` /
   `top_types` / `top_people` working in the multi-brain case.
5. **Stored `is_admin` constraints get teeth.** v6 adds a Phase 7:
   after the operator path is cut over, deactivate the existing
   `bootstrap-admin` key. This converts D11 from policy to
   enforcement at the end state.

## Vocabulary recap

Defined in `CONTEXT.md`. Quick reference:

- **Auth source** — `human_token`, `service_key`, `legacy_admin_key`.
- **Brain-bound key** — `service_key` with
  `brain_access_keys.brain_id != null`.
- **Operator stored key** — non-admin, non-brain-bound `service_key`
  for principal `luchoh` paired with
  `estate_memberships(luchoh, agent-estate, role='admin')`.

## Layering model

The four layers from v5, refined to remove "session" language:

```
   ┌──────────────────────────────────────────────────┐
   │ L1. Auth selector (route slug, query, header)    │
   │     → produces accessContext.requestBrain        │
   │     bound at resolveAccessContext time           │
   └────────────────────┬─────────────────────────────┘
                        │
   ┌────────────────────▼─────────────────────────────┐
   │ L2. Auth context (auth source, principal,        │
   │     householdId, key.brain_id, isAdmin,          │
   │     requestBrain) — fresh per HTTP request       │
   └────────────────────┬─────────────────────────────┘
                        │
   ┌────────────────────▼─────────────────────────────┐
   │ L3. Per-call brain resolution (tool-arg `brain`) │
   │     → resolves slug to UUID via D8.              │
   │       Detects requestBrain disagreement → 400.   │
   └────────────────────┬─────────────────────────────┘
                        │
   ┌────────────────────▼─────────────────────────────┐
   │ L4. Access check (read | write | edit)           │
   │     → ALLOW/DENY based on auth source +          │
   │       memberships + role + brain UUID.           │
   └──────────────────────────────────────────────────┘
```

Two non-negotiable rules:

- **Body fields never cross up into L1 or L2.** A body `brain` field
  is L3 input only.
- **Per-auth-source L1 admissibility.** Each auth source declares
  which L1 sources it accepts (Finding 1 fix; D9).

## Goals (unchanged from v5)

- Per-repo agent isolation with cross-repo recall via the common
  brain.
- Operator visibility into agent brains via stored-key + estate
  membership.
- Zero regressions on legacy-admin and human-token contracts.
- Enrichment / backfill scripts succeed against any brain via
  operator path with upfront authorization.
- Every write surface that becomes cross-brain capable does so
  through L4, not ad-hoc body fields.

## Non-goals (unchanged from v5)

## Design decisions

### D1. Estate membership is allow-only (unchanged)

`estate_memberships` has no `is_deny`. Brain-level deny is the only
deny.

### D2. Selector model — strict layering with per-auth-source L1 admissibility (Finding 1 fix)

L1 sources, in order of precedence (still at most one of {route,
query, header}):

- Route: `POST /mcp/brains/:brainSlug`.
- Query string: `?brain=<slug-or-uuid>`.
- Header: `x-brain-slug: <slug-or-uuid>`.

Two simultaneous L1 sources disagreeing → 400.

**L1 admissibility per auth source (new in v6):**

| auth source        | route allowed | query allowed | header allowed |
|--------------------|:-------------:|:-------------:|:--------------:|
| `human_token`      | yes           | NO (400)      | NO (400)       |
| `service_key`      | yes           | yes           | yes            |
| `legacy_admin_key` | yes           | yes           | yes            |

For `human_token`: query string and header L1 selectors are rejected
with **400 Bad Request**, message: "Human-token brain selection must
use the route form (POST /mcp/brains/<slug>)." This is enforced in
`resolveAccessContext` at L1, before any handler runs.

L1 produces `accessContext.requestBrain` (UUID + slug, or null).
Per-request, not per-session. The "session" language from v5 is
removed; this is request-scoped binding.

L3 selector source: tool-arg `brain` field on a tool call (MCP) or
HTTP body field on a non-MCP route.

L3 rules:

- If `requestBrain` is set AND tool-arg `brain` is set: must resolve
  to the same UUID, else 400.
- If `requestBrain` is null AND tool-arg `brain` is set: tool-arg
  resolves via D8.
- If both null: handler default per D9.

**Per-auth-source L3 rules:**

- `human_token`: tool-arg `brain` MUST equal `requestBrain` (when
  both set), else 400. tool-arg-only (without route L1) is rejected
  with 400 — human-token requires brain selection at L1 (route).
  Result: human-token requests are strictly bound to one brain per
  HTTP request, established by route only.
- `service_key`, non-brain-bound, non-admin: tool-arg freely picks
  any brain in the principal's accessible set (D8 + D6 case 4).
  No constraint to `requestBrain` if it isn't set.
- `service_key`, brain-bound: tool-arg must equal `key.brain_id`
  (else 403 from L4).
- `service_key`, admin: tool-arg must be in principal's household
  (else 403 from L4).
- `legacy_admin_key`: tool-arg `brain` is **ignored at L1/L2**.
  Body-field `brain` on `/admin/thought/metadata` is also ignored
  for this auth source (D7). Effective brain is always
  `requestBrain` (from L1 selector) or the legacy-admin default
  brain.

### D3. Operator path — stored key + estate-admin (unchanged from v5)

### D4. Phase scope (unchanged from v5)

### D5. `stats` response shape — declared honestly (Finding secondary 1 fix)

Today's response (`server.mjs:707-770`) returns:

```json
{
  "success": true,
  "overview": { /* output of thoughts_stats($1::uuid) */ },
  "top_sources": [...],
  "top_types": [...],
  "top_people": [...],
  "graph": { ... }            // only if isAdmin
}
```

v6's response keeps the existing keys and ADDS new ones for
multi-brain. **Existing keys are not removed or repurposed.**

| field         | scope=legacy | scope=single | scope=multi |
|---------------|:------------:|:------------:|:-----------:|
| `success`     | yes          | yes          | yes         |
| `scope`       | yes          | yes          | yes (NEW)   |
| `overview`    | yes          | yes          | yes (aggregated across brains; same shape) |
| `top_sources` | yes          | yes          | yes (aggregated; same shape) |
| `top_types`   | yes          | yes          | yes |
| `top_people`  | yes          | yes          | yes |
| `graph`       | conditional  | conditional  | conditional |
| `brains`      | NO           | NO           | yes (NEW; per-brain breakdown with `brain_id`, `brain_slug`, `overview`, `top_sources`, `top_types`, `top_people`) |
| `brain_id`    | NO (legacy preserved) | yes (NEW; identifies which one brain) | NO (use `brains[]`) |
| `brain_slug`  | NO           | yes (NEW)    | NO          |

Compatibility statement, accurate this time:

- **legacy_admin_key callers** (today's only callers) get the **same
  top-level fields they get today** plus a new `scope: "legacy"`
  field. The shape they parse is unchanged. `brain_id` / `brain_slug`
  / `brains` are NOT added at the top level for this scope, to avoid
  any field-presence-test surprise.
- **`scope="single"`** callers (human-token, brain-bound service key)
  get today's shape plus `scope: "single"` plus `brain_id` and
  `brain_slug`. New fields, additive. Existing parsers ignore them.
- **`scope="multi"`** callers (non-brain-bound service key) get
  today's shape (aggregated) plus `scope: "multi"` plus a `brains`
  array. The aggregated `overview` etc. let existing single-brain
  parsers continue to function on the aggregate. The `brains` array
  enables per-brain inspection.

`scope` is server-derived, not an input. Determined by auth source
(D6 case → scope mapping in Phase 2c).

### D6. Access-check helper — three permission modes (Finding 3 fix)

L4. Pure function:
`checkBrainAccess({accessContext, brainId, mode}) → ALLOW | DENY`,
where `mode` is one of `'read' | 'write' | 'edit'`.

```
Definitions:
  read  = "principal may retrieve thoughts from this brain"
  write = "principal may create new thoughts in this brain"
  edit  = "principal may modify existing thoughts in this brain"

Branches:

1. legacy_admin_key
     brainId == accessContext.requestBrain (L1 derived) OR
     brainId == legacy-admin default brain                 → ALLOW
     else                                                   → DENY
   (single-brain by definition, all three modes; cross-brain via L1
    selector only.)

2. service_key, is_admin=true
     brain.household_id == accessContext.householdId        → ALLOW
     else                                                    → DENY
   (all three modes; admin keys have full rights within their
    household.)

3. service_key, brain-bound (key.brain_id != null)
     brainId == key.brain_id                                → ALLOW
     else                                                    → DENY
   (all three modes; brain-bound keys are restricted to one brain.)

4. service_key, non-brain-bound, non-admin
   OR human_token (read/write/edit; difference is at L1 in D9):
     brain-level deny on (principal, brain)                  → DENY
     mode='read':
       brain-level allow on (principal, brain)              → ALLOW
       estate-level allow on (principal, brain.household_id) → ALLOW
       otherwise                                              → DENY
     mode='write':
       brain-level allow on (principal, brain) AND
         role IN ('owner','editor','member')                → ALLOW
       estate-level allow on (principal, brain.household_id) AND
         role IN ('admin','member')                         → ALLOW
       otherwise                                              → DENY
     mode='edit':
       brain-level allow on (principal, brain) AND
         role IN ('owner','editor')                         → ALLOW
       estate-level allow on (principal, brain.household_id) AND
         role='admin'                                        → ALLOW
       otherwise                                              → DENY
```

Note the new `write` mode (Finding 3 fix). It allows
`role='member'` at brain-level (a member can write new captures into
a brain they belong to) but does NOT allow editing existing rows.
`edit` is strictly stricter.

`listAccessibleBrainIds({accessContext, mode})`:

- Now parameterized by mode. Returns the set of brains for which
  `checkBrainAccess({mode})` would return ALLOW.
- Handler defaults call with `mode='read'` for read paths,
  `mode='write'` for capture, `mode='edit'` for metadata patch.
- For `legacy_admin_key`: returns `[requestBrain ?? legacy-admin
  default]` regardless of mode.
- For `service_key, is_admin`: every brain in principal's household
  regardless of mode.
- For `service_key, brain-bound`: `[key.brain_id]` regardless of mode.
- For `service_key non-brain-bound non-admin` and `human_token`:
  the set of brains satisfying mode.

Replaces v5's `listAccessibleBrainIds` and `listEditableBrainIds`
(separate functions) with one mode-parameterized call.

### D7. `/admin/thought/metadata` — L3+L4 only (unchanged from v5)

The endpoint takes a thought_id. Optional `brain` body field (L3).
Resolution per D7. Legacy admin path strictly single-brain (body
`brain` ignored on that branch).

### D8. Slug-vs-UUID resolution and access-check endpoint failure contract (Finding 2 fix)

**Two paths in resolution, explicitly named:**

`resolveBrainSlug({accessContext, slug}) → {brainId} | 404 | 409`:

- For `legacy_admin_key`: global lookup (preserves
  `auth.mjs:336-364`).
- For other auth sources: lookup over `listAccessibleBrainIds({mode:
  'read'})`.
- 404 if not in the accessible set (slug enumeration is undesirable,
  so we don't disclose existence of cross-estate brains).
- 409 if multi-match within accessible set.

`resolveBrainUuid({accessContext, brainId}) → {brainId} | 403 | 404`:

- 404 if no row exists in `brains` (not even globally — UUID is
  opaque, not enumerated).
- 403 if the row exists but is not in
  `listAccessibleBrainIds({mode: 'read'})`.
- ALLOW (return brainId) if accessible.

Why the difference:

- A **slug** is human-readable. If a slug exists in another estate,
  returning 403 instead of 404 leaks "a brain by this name exists
  somewhere" — useful for enumeration. We return 404, hiding it.
- A **UUID** is opaque. If a caller has a UUID, they had to obtain
  it somewhere (row from a prior result, configuration, etc.). 403
  vs 404 distinguishes "exists but you can't access" from "doesn't
  exist," which is actionable for legitimate callers and not useful
  for enumeration. We return 403 for inaccessible.

**`/admin/thought/access-check` endpoint contract:**

```
GET /admin/thought/access-check?brain=<slug-or-uuid>

Response (200):
{
  "principal_id": "uuid",
  "brain_id": "uuid",
  "brain_slug": "slug",
  "canRead": true,
  "canWrite": true,
  "canEdit": false
}

Failure modes:
  401 — no valid auth
  400 — `brain` is missing or malformed
  404 — brain not found:
    - slug input that doesn't resolve via resolveBrainSlug
    - UUID input that doesn't exist in brains
  403 — brain exists but not accessible:
    - UUID input that resolves but principal cannot read it
```

Note: a slug input never returns 403; it returns 404 if outside the
accessible set. This is consistent with `resolveBrainSlug`. A UUID
input may return 403 (consistent with `resolveBrainUuid`).

**This is the single failure contract** for inaccessible targets.
v5's contradictions are gone.

### D9. Human-token — request-scoped binding via route only (Finding 1 fix)

`docs/17:250,548` is canon. v6 enforces it as **request-scoped, not
session-scoped**:

- L1 admissibility (D2): for human-token, only the route form
  (`POST /mcp/brains/:brainSlug`) is admissible. Query and header
  are rejected at 400.
- A request without route L1 has `requestBrain = principal.default_brain_id`.
- Tool-arg `brain` for human-token (D2): MUST equal `requestBrain`
  (when both set), else 400. tool-arg-only without a matching route
  L1 → 400.
- Read defaults for human-token (D6 case 4 with
  `mode='read'` would broaden, but the human-token branch in the
  HANDLER restricts it): the request scopes to `requestBrain` only,
  not `listAccessibleBrainIds`. Handler-side branch documented in
  Phase 2c.
- Write defaults for human-token: capture targets `requestBrain`.
  Tool-arg `brain` matching `requestBrain` is the only legal way to
  pass it.

This is the only auth source with the "single-brain per request"
constraint. v6 makes the constraint **explicit at L1 (admissibility)
and L3 (tool-arg matching)**, not as a mythical "session boundary."

`service_key, non-brain-bound non-admin` is **not** subject to this
constraint. For service keys, tool-arg `brain` may freely select
any brain in the accessible set, and read defaults to multi-brain
(`listAccessibleBrainIds({mode: 'read'})`).

### D10. Env split (unchanged from v5)

Three env vars: `MCP_ACCESS_KEY`, `OB1_LEGACY_ADMIN_KEY`,
`OB1_OPERATOR_ACCESS_KEY`. See v5 D10 for usage rules.

### D11. Stored `is_admin` keys — provisioning refused, bootstrap deactivated post-cutover (Finding secondary 2 fix)

Two parts:

- **Provisioning policy** (Phase 3): the CLI refuses to mint
  `is_admin=true` without `--allow-admin`. Warns about existing
  admin keys.
- **Bootstrap deactivation** (Phase 7, new in v6): after Phases 1–6
  are deployed and the operator path is verified end-to-end, Phase 7
  **deactivates** `bootstrap-admin` (sets `is_active=false`). All
  subsequent admin tasks flow through:
  - `OB1_LEGACY_ADMIN_KEY` for legacy admin (smoke, schema migration,
    provisioning bootstrap).
  - `OB1_OPERATOR_ACCESS_KEY` for operator-style cross-estate work.
  - Per-repo `MCP_ACCESS_KEY` for repo-scoped agent work.
- Post-Phase-7 invariant: there are zero `service_key, is_admin=true,
  brain_id=null` rows that are `is_active=true` in the database.
  v6's enforcement is "Phase 7 verifies this; future provisioning
  refuses to break it."

This is enforcement at the data layer, not just policy. Phase 7's
acceptance test queries `brain_access_keys` and asserts the count of
active admin keys is zero.

### D12. Smoke harness contract — legacy-admin only (unchanged from v5)

### D13. Enrichment-script preflight (unchanged in spirit from v5; uses D8 contract)

Scripts call `GET /admin/thought/access-check?brain=<UUID>` (UUID,
not slug — they have the UUID from `--brain-id`). Per D8, UUID
resolution returns 403 for inaccessible. Preflight checks `canEdit`.
If false: error with brain UUID and principal_id, advise role
upgrade.

### D14. No estate-rename in this work (unchanged)

## Phasing

### Phase 1 — Schema (unchanged from v5)

Migration `009_estate_memberships.sql`. `estate_memberships` table
+ `brain_memberships.is_deny` column + indexes.

**Acceptance:** unchanged.

### Phase 2a — Helpers + access-check + access-check endpoint (Finding 3 fix)

Implement:

- `checkBrainAccess({accessContext, brainId, mode}) → {allowed, reason}`
  where `mode ∈ {'read', 'write', 'edit'}`.
- `listAccessibleBrainIds({accessContext, mode}) → uuid[]`.
- `resolveBrainSlug({accessContext, slug}) → uuid | 404 | 409`
  per D8.
- `resolveBrainUuid({accessContext, brainId}) → uuid | 403 | 404`
  per D8.
- `GET /admin/thought/access-check?brain=<slug-or-uuid>` HTTP route
  per D8.

**Test matrix.** Each row tests `(auth branch, mode)`. Adding a
mode column versus v5:

| auth branch                                                    | mode  | helper            | expected |
|----------------------------------------------------------------|-------|-------------------|----------|
| legacy_admin_key, target = requestBrain                        | read  | check             | ALLOW |
| legacy_admin_key, target = requestBrain                        | write | check             | ALLOW |
| legacy_admin_key, target = requestBrain                        | edit  | check             | ALLOW |
| legacy_admin_key, target ≠ requestBrain                        | any   | check             | DENY |
| legacy_admin_key                                                | any   | listAccessible    | `[requestBrain ?? default]` |
| service_key is_admin, brain in household                       | any   | check             | ALLOW |
| service_key is_admin, brain in OTHER household                 | any   | check             | DENY |
| service_key is_admin                                            | any   | listAccessible    | every brain in household |
| service_key brain-bound, target == key.brain_id                | any   | check             | ALLOW |
| service_key brain-bound, target ≠ key.brain_id                 | any   | check             | DENY |
| service_key brain-bound                                         | any   | listAccessible    | `[key.brain_id]` |
| service_key non-brain-bound, no membership                     | any   | check             | DENY |
| service_key non-brain-bound, brain-allow role='member'         | read  | check             | ALLOW |
| service_key non-brain-bound, brain-allow role='member'         | write | check             | ALLOW |
| service_key non-brain-bound, brain-allow role='member'         | edit  | check             | DENY |
| service_key non-brain-bound, brain-allow role='editor'         | edit  | check             | ALLOW |
| service_key non-brain-bound, brain-allow role='owner'          | edit  | check             | ALLOW |
| service_key non-brain-bound, estate-membership member          | read  | check             | ALLOW |
| service_key non-brain-bound, estate-membership member          | write | check             | ALLOW |
| service_key non-brain-bound, estate-membership member          | edit  | check             | DENY |
| service_key non-brain-bound, estate-membership admin           | edit  | check             | ALLOW |
| service_key non-brain-bound, estate-allow + brain-deny         | any   | check             | DENY |
| service_key brain-bound + estate-allow on different brain      | any   | check             | DENY (case 3 wins) |
| human_token, brain-allow                                        | read  | check             | ALLOW |
| human_token, no membership                                      | any   | check             | DENY |
| any, slug not in accessible set                                | n/a   | resolveBrainSlug  | 404 |
| any, slug matches multiple in accessible set                   | n/a   | resolveBrainSlug  | 409 |
| any, UUID not in `brains`                                      | n/a   | resolveBrainUuid  | 404 |
| any, UUID exists but inaccessible                              | n/a   | resolveBrainUuid  | 403 |

Endpoint test matrix:

| endpoint input                                                  | expected |
|-----------------------------------------------------------------|----------|
| `?brain=<slug-in-accessible-set>`                              | 200, fields filled |
| `?brain=<slug-not-in-accessible-set>` (legacy admin)            | 200 (global resolution) |
| `?brain=<slug-not-in-accessible-set>` (service_key)            | 404 |
| `?brain=<UUID-of-accessible-brain>`                            | 200 |
| `?brain=<UUID-of-existing-but-inaccessible-brain>` (service_key)| 403 |
| `?brain=<UUID-not-in-brains>`                                  | 404 |
| no `?brain=`                                                   | 400 |
| no auth                                                         | 401 |

**Acceptance:**
- ☐ Test matrix above passes.
- ☐ Smoke regression unchanged.

### Phase 2b — Selector unification with per-auth-source admissibility (Finding 1 fix)

In `resolveAccessContext`:

- Detect simultaneous L1 sources (route+query, route+header,
  query+header) → 400.
- For `human_token` requests: reject `?brain=` and `x-brain-slug`
  → 400. Only route L1 admitted.
- For other auth sources: any of the three is admitted.
- Set `accessContext.requestBrain` from L1.

**Acceptance:**
- ☐ `?brain=ob1` + `x-brain-slug=agent-common` → 400.
- ☐ Human-token request with `?brain=ob1` → 400 (NEW: rejected
  for human-token).
- ☐ Human-token request with `x-brain-slug=ob1` → 400 (NEW).
- ☐ Human-token request via `POST /mcp/brains/ob1` → 200.
- ☐ Service-key request with `?brain=ob1` → 200 (still admissible).
- ☐ Stored-key principal with estate-only access can read brain in
  estate B (L1 selector resolves the brain via D8).
- ☐ Two estates with same slug accessible to one principal → 409.
- ☐ Brain-bound key with mismatched slug → 404.
- ☐ Slug resolves to a brain caller can read but not edit → 200 on
  read, 403 on `/admin/thought/metadata`.

### Phase 2c — Tool & HTTP surfaces

**Capture path** (`capture_thought`, `/ingest/thought`):

- Optional `brain` body field (L3).
- L3 disagreement with `requestBrain` → 400.
- For human_token: tool-arg `brain` MUST equal `requestBrain` else
  400 (D9).
- L4 access check with `mode='write'`. Note: D6 case 4 mode='write'
  allows role='member' on brain-membership and role='admin'/'member'
  on estate-membership. **This is the create-authority table that
  Finding 3 demanded be in the helper contract.**
- Default brain when no `brain` specified:
  - `legacy_admin_key`: `requestBrain ?? legacy-admin default`.
  - `service_key, is_admin`: `principal.default_brain_id`.
  - `service_key, brain-bound`: `key.brain_id`.
  - `service_key, non-brain-bound non-admin`:
    `principal.default_brain_id` or 400 if null.
  - `human_token`: `requestBrain`.

**Read path** (`search_thoughts`, `list_thoughts`, `ask_brain`,
`/ask`, `/admin/thought/similar`):

- Optional `brain` body field.
- If set: L3 disagreement check, L4 `mode='read'`, scope to that
  brain.
- If not set:
  - `legacy_admin_key`: `[requestBrain ?? legacy-admin default]`.
  - `service_key, is_admin`: `listAccessibleBrainIds({mode: 'read'})`
    (= every brain in household).
  - `service_key, brain-bound`: `[key.brain_id]`.
  - `service_key, non-brain-bound non-admin`:
    `listAccessibleBrainIds({mode: 'read'})`.
  - `human_token`: `[requestBrain]` (D9).

Multi-brain scope → fan out, merge, tag every row with
`brain_id`/`brain_slug`.

**`stats`:** D5 shape per scope, server-derived. `scope` mapping:

- `legacy_admin_key` → `scope: "legacy"` (today's exact shape, plus
  `scope` field).
- `service_key, brain-bound` OR `human_token` OR (any auth source
  with single-brain accessible set) → `scope: "single"` (today's
  shape + `brain_id`, `brain_slug`).
- `service_key, non-brain-bound` with multi accessible OR
  `service_key, is_admin` with >1 brain in household → `scope:
  "multi"` (today's shape aggregated, plus `brains[]`).

Aggregation: `top_sources`, `top_types`, `top_people` are computed
across all brains in scope (single SQL pass with brain filter
`WHERE brain_id = ANY($brains)`). Per-brain breakdown lives in the
new `brains[]` array.

**`/admin/thought/metadata`** (D7):

- Optional `brain` body field.
- For `legacy_admin_key`: body field IGNORED. WHERE clause uses
  `requestBrain ?? legacy-admin default`. Cross-brain patch via this
  branch is impossible by design.
- For other branches: body field resolves via L3, L4
  `mode='edit'`. WHERE clause: `id = $1 AND brain_id = ANY($2)`
  where `$2 = listAccessibleBrainIds({mode: 'edit'})` if no body
  brain, or `[brain.id]` if body brain.

**`/graph/*`:** unchanged. Admin-only.

**Acceptance — legacy_admin_key (Finding 1 closure):**
- ☐ Smoke harness passes.
- ☐ Patch with body `brain=<other>` → body field IGNORED. If thought
  is in default brain → 200; if in `<other>` → 404 with explicit
  message.
- ☐ Documented in error response that legacy admin cannot patch
  cross-brain.

**Acceptance — service_key, brain-bound:**
- ☐ Capture with no `brain` → `key.brain_id`.
- ☐ Capture with `brain=<other>` → 403.
- ☐ Search no `brain` → only `key.brain_id`.

**Acceptance — service_key, non-brain-bound (REPO PRINCIPAL):**
- ☐ Capture with no `brain` → repo brain (default).
- ☐ Capture with `brain="agent-common"`, role='editor' on
  agent-common → write succeeds.
- ☐ Capture with `brain="agent-common"`, role='member' on
  agent-common → write succeeds (mode='write' allows member).
- ☐ Capture with `brain="<unrelated>"` → 403.
- ☐ Search with no `brain` → spans repo + common.
- ☐ Search with `brain="ob1"` → repo only.
- ☐ `/admin/thought/metadata` body `brain="agent-common"`:
  - role='member': 403 (mode='edit' denies member).
  - role='editor': 200.
  - role='owner': 200.
  - estate-admin: 200.

**Acceptance — service_key, is_admin:**
- ☐ Capture with `brain=<in-household>` → 200.
- ☐ Capture with `brain=<in-OTHER-household>` → 403.
- ☐ `listAccessibleBrainIds({mode:'edit'})` = brains in household.

**Acceptance — human_token (Finding 1):**
- ☐ Search with no `brain` → `requestBrain` only.
- ☐ Search with body `brain` matching `requestBrain` → 200.
- ☐ Search with body `brain` NOT matching `requestBrain` → 400
  ("must match requestBrain").
- ☐ Search with no route L1 + body `brain` → 400 (D9: human-token
  needs route L1).
- ☐ Capture with no `brain` → `requestBrain`.
- ☐ Capture with body `brain` ≠ `requestBrain` → 400.

**Acceptance — selector disagreement:**
- ☐ `POST /mcp/brains/ob1` + body `brain="agent-common"` → 400.
- ☐ `?brain=ob1` (service_key) + body `brain="agent-common"` → 400.

**Acceptance — `stats` shape (Finding secondary 1):**
- ☐ Today's legacy_admin_key shape preserved exactly + `scope:
  "legacy"` field added; existing parsers unaffected.
- ☐ `scope="single"` adds `brain_id`/`brain_slug`; `overview` /
  `top_*` unchanged.
- ☐ `scope="multi"` aggregates `top_*` and adds `brains[]`.
- ☐ Snapshot test against today's prod legacy_admin response,
  ignoring the new `scope` field.

### Phase 3 — Provisioning CLI (unchanged from v5)

`scripts/agent_estate/provision.py`. Subcommands:
`provision-estate-and-common`, `provision-repo --slug <slug>`,
`provision-operator-membership`, `rotate-key --slug <slug>`.
Refuses to mint admin keys without `--allow-admin`. Warns on
existing admin keys (D11).

**Acceptance** (unchanged from v5).

### Phase 4 — Per-repo `.envrc` (unchanged from v5)

### Phase 5 — Routing skill (unchanged from v5)

### Phase 6 — Migrate writers (unchanged in spirit from v5; uses D8 UUID contract)

`scripts/thought_enrichment/*` and other operator scripts:

- Read `OB1_OPERATOR_ACCESS_KEY` only. Refuse `MCP_ACCESS_KEY`
  fallback.
- Startup preflight: `GET /admin/thought/access-check?brain=<UUID>`.
- Per D8 UUID contract: 403 for inaccessible, 404 for nonexistent.
  Preflight propagates the exact status to the operator with the
  brain UUID, principal_id, and remediation instructions.
- Patches send body `brain=<UUID>` on every call.

Smoke harness: legacy-admin only, reads `OB1_LEGACY_ADMIN_KEY`.

**Acceptance** (unchanged from v5).

### Phase 7 — Bootstrap-admin deactivation (NEW in v6, Finding secondary 2 fix)

After Phases 1–6 are deployed and verified end-to-end:

- Verify `scripts/thought_enrichment/*` runs successfully against
  `OB1_OPERATOR_ACCESS_KEY` for at least one full enrichment pass.
- Verify the smoke harness runs against `OB1_LEGACY_ADMIN_KEY`.
- Verify all Telegram bridge / FastAPI ingest paths still work (they
  use the legacy admin key via the wrapper script).
- THEN: deactivate `bootstrap-admin`:

  ```sql
  update brain_access_keys
    set is_active = false, updated_at = now()
    where label = 'bootstrap-admin' and is_admin = true;
  ```
  (Or: keep `bootstrap-admin` active because the Telegram bridge
  wrapper still uses it. **Honest constraint: the bridge wrapper
  lives in system-config, not this repo.** Until the wrapper is
  updated to use a different key, deactivating `bootstrap-admin`
  would break the bridge.)

Two paths:

**(a) Strict cutover.** Deactivate `bootstrap-admin`, fail closed
on any caller still using it. Requires the system-config wrapper
update first. Tracked as a follow-up handoff doc.

**(b) Soft deprecation.** Mark `bootstrap-admin` as
`is_admin=false` (downgrade to non-admin) but keep `is_active=true`.
The Telegram bridge keeps working but loses cross-household admin
power. Requires verifying the bridge doesn't rely on admin behavior
(it captures into `luchoh` brain, which it already has membership
for — should be fine).

v6 picks **(b) soft deprecation** as the in-this-repo Phase 7. Strict
cutover (a) is tracked as a separate system-config handoff after
the bridge wrapper is updated.

**Acceptance:**
- ☐ Phases 1–6 verified.
- ☐ Bridge keeps capturing after `bootstrap-admin.is_admin=false`.
  (If it doesn't, this acceptance fails and we revert + flag the
  bridge dependency for the handoff doc.)
- ☐ `select count(*) from brain_access_keys where is_active=true and
  is_admin=true` returns the count of admin keys in the system.
  Document the count and which keys remain (likely zero after Phase
  7).
- ☐ Future `is_admin=true` mints continue to require `--allow-admin`
  (D11).

## Risks and mitigations

- **Body field promoted to L1 by accident.** Mitigation: D7 +
  D6 case 1 explicitly state legacy admin ignores body `brain`.
  Tests in Phase 2c.
- **Human-token contract drift.** Mitigation: D2 admissibility +
  D9 + Phase 2b acceptance enforce route-only L1 for human-token.
- **Operator scripts run from repo shell with wrong key.**
  Mitigation: D10 + D13 + Phase 6 acceptance test for "no operator
  key set inside repo shell → fail clearly."
- **Stored `is_admin` keys remain a hole.** Mitigation: D11 +
  Phase 7 deactivation. End state: zero active admin keys.
- **`stats` shape claim.** Mitigation: D5 explicit per-scope table +
  Phase 2c acceptance snapshot test.
- **Phase 7 bridge dependency.** Mitigation: pick path (b) soft
  deprecation. Strict cutover deferred to a system-config handoff.
- **Multi-brain search latency.** Mitigation: parallel fanout, N
  small.

## Out of scope, tracked separately

- Renaming `households` → `estates`.
- Brain-qualified graph projections + multi-brain graph queries.
- `update_thought_mcp` / `delete_thought_mcp` MCP tools.
- Thought-audit log (ADR-27).
- Telegram bridge wrapper env split (system-config follow-up).
- Strict bootstrap-admin cutover (Phase 7 path (a); system-config
  follow-up).
- Recurring backup design (task #14).
- Service-key smoke harness (separate effort).
- Human-token federation for agent principals.

## Open questions

- Phase 7 path (a) vs (b) — should we eventually cut bootstrap-admin
  fully? Defer until system-config wrapper update lands.
- D9's request-scoped binding may surface as a usability issue if
  human dashboards want a multi-brain view. Defer; would need a
  separate ADR amending `docs/17:250,548`.
- D6 mode='write' allows role='member' at brain-level AND
  role='member' at estate-level. Is "estate-level role='member'
  enables write to all brains in the estate"  too broad? It is
  symmetric with read-via-estate-membership but more permissive
  than per-brain membership ('member' brain-membership grants
  read+write but NOT edit; 'editor' grants edit). Reverse case:
  estate-level grants read+write but not edit. Symmetric. Defer
  unless a real concern surfaces.
