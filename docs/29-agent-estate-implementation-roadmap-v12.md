# PRD: Agent Estate + Brain Selection — Implementation Roadmap (v12)

Date: 2026-06-03
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`,
           CONTEXT `CONTEXT.md`,
           reviews v1–v11
Supersedes: v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11

## Why v12

v11 was rejected on one finding plus one secondary gap, both
about the same hole: D8's slug lookup scope excluded brains
accessible only via direct cross-estate `brain_memberships`. ADR-0001
point 3 names that exact pattern as the canonical "shared brain"
mechanism, and the common-brain design relies on it (a repo
principal homed in `agent-estate` receives membership to brains in
other estates only via `brain_memberships`, not `estate_memberships`).

Under v11 D8, such a principal would 200 on UUID selection and 404
on slug selection for the same accessible brain. v12 closes that.

## Vocabulary recap (unchanged)

## Layering model (unchanged)

## Goals (unchanged)

## Non-goals (unchanged)

## Design decisions

### D1. Estate membership is allow-only (unchanged)

### D2. Selector model — per-auth-source AND per-route admissibility (unchanged)

### D3. Operator path (unchanged)

### D4. Phase scope (unchanged)

### D5. `stats` response shape (unchanged)

### D6. Access-check helper — three modes, single-brain legacy admin (unchanged)

### D7. Omitted-`brain` write defaults align with ADR-0001; L4 runs on every write (unchanged)

### D8. Slug-vs-UUID resolution — two-step semantics with brain-membership-aware scope (Finding 1 fix)

v12 fixes the lookup-scope omission. The two-step structure from
v11 stays; the **scope per auth source** is corrected to include
brains directly granted by `brain_memberships`.

#### Slug lookup scope per auth source (v12, corrected)

| auth source                                | slug lookup scope |
|--------------------------------------------|-------------------|
| `legacy_admin_key`                         | global brains table |
| `service_key, is_admin=true`               | every brain in `accessContext.householdId` |
| `service_key, brain-bound`                 | every brain in `accessContext.householdId` (allows slug typo to resolve, then 403 because of brain-bound restriction; matches `auth.mjs:286-310`) |
| `service_key, non-brain-bound, non-admin`  | every brain in `accessContext.householdId` ∪ every brain in estates with `estate_memberships` ∪ **every brain in `brainMemberships` (any estate, including cross-estate direct grants)** ∪ deny rows are visible at lookup but excluded at access check |
| `human_token`                              | same as service_key non-brain-bound |

The new term in the union: `brainMemberships` — direct brain-level
memberships, regardless of which estate the brain belongs to. ADR-0001
point 3 specifies these as the cross-estate sharing mechanism, so
they MUST be in the lookup scope. v11 dropped them. v12 puts them
back.

#### Why this is still NOT global enumeration

A non-admin service-key principal's lookup scope under v12 is bound
by:

- Their home estate (always knowable to the principal).
- Estates where they have `estate_memberships` rows (an explicit
  grant from someone, so brain existence in that estate is not
  fresh information).
- Brains where they have `brain_memberships` rows (an explicit
  grant from someone, so brain existence is not fresh information).

A principal with no relationship to brain B in estate E (no
brain-membership, no estate-membership) cannot probe B's existence
via slug — the lookup returns 404. The mechanism remains
non-enumerable for third-party brains.

#### `resolveBrainSlug({accessContext, slug}) → resolution`

(Unchanged from v11 in shape; only the lookup-scope definition
above changes.)

Two-step:

1. **Lookup** the slug within the per-auth-source lookup scope.
   - 0 matches: **404 Brain not found.**
   - Multiple matches: **409 Conflict, pass UUID.**
   - 1 match: proceed to step 2 with the resolved UUID.
2. **Authorize** via `checkBrainAccess({mode: 'read'})` against the
   resolved UUID.
   - ALLOW: return UUID. Handler then runs its own L4 check for the
     operation.
   - DENY: **403 Not authorized for brain.**

Slug-and-UUID consistency property (v12 invariant): for any brain B
and principal P, if `checkBrainAccess(P, B, 'read') == ALLOW`, then
the slug of B is in P's lookup scope. So slug selection of an
accessible brain always succeeds. v11 broke this property; v12
restores it.

#### `resolveBrainUuid({accessContext, brainId}) → resolution`

(Unchanged from v11.)

#### Migration to v12 D8

Code-level changes vs today (`auth.mjs:286-310`):

- Today: stored-key slug lookup uses
  `resolveBrainBySlugForHousehold(first.household_id, slug)`.
  Household-only.
- v12: stored-key slug lookup operates over the union scope
  (household + estate-membership-bound estates + brain-membership-
  bound brains). For non-admin non-brain-bound and human-token
  branches.
- Today: brain-bound mismatch returns 403 ("Access key is bound to
  a different brain"). v12: same (D8 step 2 produces it).
- Today: not-in-membership returns 403 ("Not authorized for brain").
  v12: same.
- v12 NEW: estate-only principals can slug-resolve brains in their
  estate-membership estates.
- v12 NEW: cross-estate brain-membership principals can slug-resolve
  the directly-granted brain.

### D9. Human-token request-scoped binding (unchanged)

### D10. Env split (unchanged)

### D11. Stored `is_admin` provisioning policy (unchanged)

### D12. Estate-membership `role='member'` is read-only (unchanged)

### D13. Smoke harness contract (unchanged)

### D14. Legacy-admin layer hygiene (unchanged)

### D15. `/admin/thought/access-check` query param `target_brain` (unchanged)

### D16. No estate-rename in this work (unchanged)

### D17. Auth-context resolution becomes estate-aware, with admin carve-out preserved (unchanged from v10)

The accessible-brain set used inside `resolveStoredAccessKeyContext`
and `resolveHumanAccessContext` for L1 authorization continues to
be:

| auth source                                  | accessible-brain set (L1 authorization) |
|----------------------------------------------|------------------------------------------|
| `legacy_admin_key`                           | global |
| `service_key, is_admin=true`                 | every brain in `accessContext.householdId` |
| `service_key, brain-bound`                   | `[key.brain_id]` |
| `service_key, non-brain-bound, non-admin`    | brain-allow ∪ estate-allow − brain-deny |
| `human_token`                                | brain-allow ∪ estate-allow − brain-deny |

Note that "brain-allow" here is `brainMemberships` rows with
`is_deny=false` — same set v12 D8 includes in the lookup scope.

The lookup scope (D8) and the accessible set (D17) are still
distinct things — lookup is broader by including the principal's
home estate (where they may type a slug for any brain even without
membership). But for non-admin non-brain-bound, every brain in the
accessible set IS in the lookup scope, satisfying the
slug-and-UUID consistency property.

## Phasing

### Phase 1 — Schema (unchanged)

### Phase 2 — Auth context + helpers (refined matrix per D8 v12)

Implementation order unchanged from v10/v11.

**Acceptance — selector + auth context (refined per D8 v12):**

| auth branch                                                                   | scenario                                                              | expected |
|-------------------------------------------------------------------------------|-----------------------------------------------------------------------|----------|
| any                                                                           | route+query L1 disagree                                               | 400 |
| any                                                                           | route+header L1 disagree                                              | 400 |
| any                                                                           | query+header L1 disagree                                              | 400 |
| `human_token`                                                                 | `?brain=ob1`                                                          | 400 |
| `human_token`                                                                 | `x-brain-slug=ob1`                                                    | 400 |
| `human_token`                                                                 | `POST /mcp/brains/ob1` (brain-membership exists)                      | 200 |
| `service_key, is_admin`                                                       | `?brain=<in-household, no-membership>` (admin carve-out)              | 200 |
| `service_key, is_admin`                                                       | `?brain=<in-OTHER-household>` (slug not in lookup scope)              | 404 |
| `service_key, brain-bound`                                                    | `?brain=<key.brain_id>`                                               | 200 |
| `service_key, brain-bound`                                                    | `?brain=<other-in-same-household>` (resolves, then DENY at L4)        | 403 |
| `service_key, brain-bound`                                                    | `?brain=<other-in-different-household>` (slug not in lookup scope)    | 404 |
| `service_key, non-brain-bound, brain-membership only` (in own estate)         | `?brain=<member-brain>`                                               | 200 |
| `service_key, non-brain-bound, estate-only`                                   | `?brain=<brain-in-membership-estate>`                                 | 200 |
| `service_key, non-brain-bound, estate-only`                                   | `?brain=<brain-in-OTHER-estate-NO-membership>` (not in lookup scope)  | 404 |
| `service_key, non-brain-bound, brain-deny + estate-allow`                     | `?brain=<denied-brain>` (resolves in scope, then DENY at L4)          | 403 |
| **`service_key, non-brain-bound, ONLY direct cross-estate brain-membership` (NEW)** | **`?brain=<brain-in-other-estate-via-direct-brain-membership>` (slug resolves AND access ALLOWS)**  | **200** |
| **same auth, same direct grant**                                              | **body `brain=<same-slug>` on `/admin/thought/metadata`**             | **resolves; outcome per L4 mode='edit'** |
| any non-legacy                                                                | `?brain=<typo>` (slug resolves nowhere in scope)                      | 404 |
| any non-legacy                                                                | slug matches multiple in lookup scope                                 | 409 |

The two **NEW** rows are Codex Finding 1 closure tests for v11.
They prove the slug-and-UUID consistency property: a brain
accessible via direct cross-estate brain-membership resolves cleanly
on both selectors.

The repo principal + agent-common scenario (canonical use case
from CONTEXT.md and v7's Phase 3 acceptance) IS this case if a repo
principal is homed outside the agent estate. ADR-0001 + CONTEXT.md
treat repo principals as homed in the agent estate, so for the v12
canonical setup the principal does have brain-membership in its own
home estate. But the design ALSO supports cross-estate brain-
membership (per ADR-0001 point 3). The new test row proves the
broader case works.

**Acceptance — L4 helpers (per D6, unchanged from v10).**

**Acceptance — `/admin/thought/access-check` endpoint (refined per D8 v12):**

| endpoint input                                                          | expected |
|-------------------------------------------------------------------------|----------|
| `?target_brain=<slug-in-lookup-scope, accessible>`                      | 200 |
| `?target_brain=<slug-in-lookup-scope, NOT accessible>` (e.g., brain-deny) | 403 |
| `?target_brain=<slug-not-in-lookup-scope>`                              | 404 |
| **`?target_brain=<slug-of-cross-estate-direct-brain-membership>` (NEW)** | **200** |
| `?target_brain=<UUID-of-accessible-brain>`                              | 200 |
| `?target_brain=<UUID-of-existing-but-inaccessible-brain>`               | 403 |
| `?target_brain=<UUID-not-in-brains>`                                    | 404 |
| no `?target_brain=`                                                     | 400 |
| no auth                                                                 | 401 |

### Phase 3 — Tool & HTTP surfaces (unchanged from v11)

(Unchanged. L4 runs on every write surface against the resolved
target brain. Finding 1 closure tests for metadata patch and
Finding 2 closure tests for capture path stay as in v11.)

### Phase 4 — Provisioning CLI (unchanged)

### Phase 5 — Per-repo `.envrc` (unchanged)

### Phase 6 — Routing skill (unchanged)

### Phase 7 — Migrate writers (unchanged)

### Phase 8 — Legacy-admin layer hygiene (unchanged)

## Risks and mitigations

(Unchanged from v11, plus:)

- **Lookup scope must include direct `brainMemberships` even
  cross-estate.** Mitigation: D8 v12 lists this explicitly. Phase 2
  matrix has the canonical test row. Implementer cannot omit
  brainMemberships without a failing test.
- **The slug-and-UUID consistency property is a v12 invariant.**
  Mitigation: stated in D8 explicitly. Any future change to the
  lookup scope or the accessible set must preserve it.

## Out of scope, tracked separately (unchanged)

## Open questions (unchanged)
