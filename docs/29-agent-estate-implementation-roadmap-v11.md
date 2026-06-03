# PRD: Agent Estate + Brain Selection — Implementation Roadmap (v11)

Date: 2026-06-03
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`,
           CONTEXT `CONTEXT.md`,
           reviews v1–v10
Supersedes: v1, v2, v3, v4, v5, v6, v7, v8, v9, v10

## Why v11

v10 was rejected on one finding plus one secondary gap:

1. **L1 slug-selector status code contract was inconsistent.** v10
   said D8 was unchanged ("inaccessible slug = 404") while the
   Phase 2 matrix listed several **403** rows for inaccessible
   slugs (admin in other household, brain-bound mismatch,
   estate-only with cross-estate slug, brain-deny override).
   Same selector mechanism, conflicting status codes.
2. **Capture path lacked the "L4 always runs" closure test that
   metadata patch got.** D7 generalized the rule to every write
   surface, but Phase 3 acceptance only tested it on
   `/admin/thought/metadata`. An implementer fixing the metadata
   bypass could miss the matching capture path.

Both fixed in v11. The status-code question is settled by
explicitly choosing **the live runtime's two-step semantics**:
slug-not-resolvable-in-lookup-scope = 404; slug-resolves-but-
inaccessible = 403. Then defining the lookup scope per auth
source. The Phase 2 matrix was always describing the second case;
v11 makes that visible in D8 itself.

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

### D7. Omitted-`brain` write defaults align with ADR-0001; L4 runs on every write (unchanged from v10)

The contract: write surfaces (`/admin/thought/metadata`,
`/ingest/thought`, `capture_thought`) without body `brain` scope to
a single brain (`accessContext.effectiveBrainId`). Cross-brain
writes require explicit body `brain`. Multi-brain default is read-
only.

L4 runs on every write surface against the resolved target brain,
every time:

- `/admin/thought/metadata`: `mode='edit'` always.
- `/ingest/thought`, `capture_thought`: `mode='write'` always.
- Read tools: `mode='read'` always.

Body `brain` set OR unset → L4 still runs. v10 closed the
metadata-patch bypass; v11 explicitly closes the capture-path
bypass with parallel acceptance tests (Phase 3).

### D8. Slug-vs-UUID resolution — two-step semantics (Finding 1 fix)

v11 splits slug resolution into two named steps and fixes the
status code per step. The current runtime already implements this
split (see `auth.mjs:286-310`); v11 codifies it.

#### Slug lookup scope per auth source

For a slug input from L1 selector OR body `brain` field:

| auth source                                      | slug lookup scope |
|--------------------------------------------------|-------------------|
| `legacy_admin_key`                               | global brains table |
| `service_key, is_admin=true`                     | every brain in `accessContext.householdId` |
| `service_key, brain-bound`                       | every brain in `accessContext.householdId` (so a slug typo can resolve, then 403 because of brain-bound restriction; matches `auth.mjs:286-310`) |
| `service_key, non-brain-bound, non-admin`        | every brain in `accessContext.householdId` PLUS every brain in estates where the principal has `estate_memberships` (the "lookup union" — superset of accessible) |
| `human_token`                                    | every brain in `accessContext.householdId` PLUS every brain in estates where the principal has `estate_memberships` |

The **lookup scope** is broader than the **accessible set**. This
is the part that lets us emit 403 (not 404) for a slug the
principal could plausibly have meant but cannot reach.

The lookup scope is defined narrowly enough to avoid global
enumeration: a non-admin service-key principal cannot probe brains
in estates they have NO relationship to. The scope is:

- Brains in the principal's home estate (always known to the
  principal — they could plausibly type any slug there).
- Brains in estates where the principal has estate-membership rows
  (allow). They've been explicitly granted SOMETHING in that
  estate, so brain existence in it is not new information.

Brains in third-party estates remain unenumerable (slug typo or
guess returns 404, never 403).

#### `resolveBrainSlug({accessContext, slug}) → resolution`

Two-step:

1. **Lookup** the slug within the per-auth-source lookup scope.
   - If 0 matches: **404 Brain not found.**
   - If multiple matches (rare; same slug in different estates,
     both in scope): **409 Conflict, pass UUID to disambiguate.**
   - If 1 match: proceed to step 2 with the resolved UUID.
2. **Authorize** via `checkBrainAccess({mode: 'read'})` against the
   resolved UUID.
   - If ALLOW: return UUID. The handler then runs its own L4 check
     for the operation it's about to perform (write/edit).
   - If DENY: **403 Not authorized for brain.**

#### `resolveBrainUuid({accessContext, brainId}) → resolution`

UUIDs are opaque. No "lookup scope" — the row either exists in
`brains` or not.

1. If no row in `brains`: **404 Brain not found.**
2. If row exists, run `checkBrainAccess({mode: 'read'})`:
   - ALLOW: return UUID.
   - DENY: **403 Not authorized for brain.**

#### Why this is consistent with v10's matrix

v10 listed 403 for cases like "brain-bound key with `?brain=<other>`"
and "estate-only with `?brain=<brain-in-OTHER-estate>`." Under v11
D8:

- **Brain-bound key with `?brain=<other-in-same-household>`**: lookup
  scope is the full household, slug resolves (step 1 OK), then
  step 2 access check denies because brain-bound restricts to
  `[key.brain_id]`. **403.** ✓
- **Brain-bound key with `?brain=<other-in-different-household>`**:
  lookup scope is household only; slug not found. **404.** Different
  case from above.
- **Admin with `?brain=<in-other-household>`**: lookup scope is the
  admin's household; slug not found. **404.**
- **Estate-only principal with `?brain=<brain-in-other-estate-WITH-membership>`**:
  lookup scope includes the membership-bound estate. Resolves.
  Access check ALLOW. **200.**
- **Estate-only with `?brain=<brain-in-NO-membership-estate>`**:
  lookup scope doesn't include that estate. **404.**
- **Brain-deny override**: lookup scope includes principal's home
  estate. Slug resolves. Access check DENY (deny wins per D6 case 4).
  **403.**

So 403 means "brain exists in a place you could have meant it, but
you can't access it." 404 means "slug doesn't resolve in any place
you have a relationship with."

The v10 Phase 2 matrix rows that listed 403 were correct as the
**target end-state**; v10's flaw was not having D8 spell out why.
v11 D8 spells it out explicitly. The matrix in Phase 2 below is now
self-consistent with D8 because D8's two-step semantics produce the
same status codes.

#### Migration to v11 D8

Code-level changes vs today (`auth.mjs:286-310`):

- Today: stored-key slug lookup uses
  `resolveBrainBySlugForHousehold(first.household_id, slug)` —
  household-only. v11: extends scope to include estates where the
  principal has membership.
- Today: brain-bound mismatch returns 403 with "Access key is bound
  to a different brain." v11: same behavior; D8 step 2 access
  check produces the 403.
- Today: not-in-membership returns 403 ("Not authorized for brain").
  v11: same behavior; D8 step 2 produces the 403.
- v11 NEW: slug not in lookup scope returns 404. Today's
  household-only lookup already does this for cross-household slugs.
- v11 NEW: estate-only principals can resolve slugs in their
  estate-membership estates.

### D9. Human-token request-scoped binding (unchanged)

### D10. Env split (unchanged)

### D11. Stored `is_admin` provisioning policy (unchanged)

### D12. Estate-membership `role='member'` is read-only (unchanged)

### D13. Smoke harness contract (unchanged)

### D14. Legacy-admin layer hygiene (unchanged)

### D15. `/admin/thought/access-check` query param `target_brain` (unchanged)

### D16. No estate-rename in this work (unchanged)

### D17. Auth-context resolution becomes estate-aware, with admin carve-out preserved (unchanged from v10)

## Phasing

### Phase 1 — Schema (unchanged)

### Phase 2 — Auth context + helpers (refined matrix per D8 v11)

Implementation order unchanged from v10. The acceptance matrix
status codes are now self-consistent with D8 v11:

**Acceptance — selector + auth context (refined per D8 v11):**

| auth branch                                                        | scenario                                                                | expected |
|--------------------------------------------------------------------|-------------------------------------------------------------------------|----------|
| any                                                                | route+query L1 disagree                                                 | 400 |
| any                                                                | route+header L1 disagree                                                | 400 |
| any                                                                | query+header L1 disagree                                                | 400 |
| `human_token`                                                      | `?brain=ob1`                                                            | 400 |
| `human_token`                                                      | `x-brain-slug=ob1`                                                      | 400 |
| `human_token`                                                      | `POST /mcp/brains/ob1` (with brain-membership)                          | 200 |
| `service_key, is_admin`                                            | `?brain=<in-household, no-membership>` (admin carve-out)                | 200 |
| `service_key, is_admin`                                            | `?brain=<in-OTHER-household>` (slug not in lookup scope, D8 step 1)     | 404 |
| `service_key, brain-bound`                                         | `?brain=<key.brain_id>`                                                 | 200 |
| `service_key, brain-bound`                                         | `?brain=<other-in-same-household>` (resolves, then DENY at L4)          | 403 |
| `service_key, brain-bound`                                         | `?brain=<other-in-different-household>` (slug not in lookup scope)      | 404 |
| `service_key, non-brain-bound, brain-membership only`              | `?brain=<member-brain>`                                                 | 200 |
| `service_key, non-brain-bound, estate-only`                        | `?brain=<brain-in-membership-estate>`                                   | 200 |
| `service_key, non-brain-bound, estate-only`                        | `?brain=<brain-in-OTHER-estate-NO-membership>` (not in lookup scope)    | 404 |
| `service_key, non-brain-bound, brain-deny + estate-allow`          | `?brain=<denied-brain>` (resolves in scope, then DENY)                  | 403 |
| any non-legacy                                                     | `?brain=<typo>` (slug resolves nowhere in scope)                        | 404 |
| any non-legacy                                                     | slug matches multiple in lookup scope                                   | 409 |

The matrix is now self-consistent with D8: 404 means "slug
doesn't resolve in your lookup scope," 403 means "slug resolves in
scope but you can't access the resulting brain."

**Acceptance — L4 helpers (per D6, unchanged from v10).**

**Acceptance — `/admin/thought/access-check` endpoint (refined for
D8 v11):**

| endpoint input                                                        | expected |
|-----------------------------------------------------------------------|----------|
| `?target_brain=<slug-in-lookup-scope, accessible>`                   | 200 |
| `?target_brain=<slug-in-lookup-scope, NOT accessible>` (e.g., brain-deny) | 403 |
| `?target_brain=<slug-not-in-lookup-scope>`                            | 404 |
| `?target_brain=<UUID-of-accessible-brain>`                            | 200 |
| `?target_brain=<UUID-of-existing-but-inaccessible-brain>`             | 403 |
| `?target_brain=<UUID-not-in-brains>`                                  | 404 |
| no `?target_brain=`                                                   | 400 |
| no auth                                                               | 401 |

### Phase 3 — Tool & HTTP surfaces (Finding 2 fix)

Handler-layer changes. L4 runs on every operation against the
resolved target brain.

**Capture path** (`capture_thought`, `/ingest/thought`):

- Optional `brain` body field (L3).
- Resolve target:
  - Body `brain` set: resolve via D8.
  - Body `brain` unset: target = `accessContext.effectiveBrainId`.
- L3 disagreement check: if body `brain` and `requestBrain` both
  set, must match → 400 if different. For human-token MCP, body
  `brain` must equal `requestBrain` (D9).
- **L4 `checkBrainAccess({mode: 'write'})` against target brain
  always.** If 403 → 403.
- Then write.

**Read path** (unchanged from v10).

**`stats`:** (unchanged.)

**`/admin/thought/metadata`** (unchanged from v10):

- L4 `checkBrainAccess({mode: 'edit'})` against target brain
  always. (Closes Finding 1 from v9.)

**`/graph/*`:** unchanged.

**Acceptance — Finding 1 closure (metadata patch, from v10):**
- ☐ Service-key non-brain-bound principal with read-only access to
  `agent-common` (role='member' on a brain or estate-member),
  `?brain=agent-common` L1, no body `brain`, target row in
  agent-common: → 403 (mode='edit' denies).
- ☐ Same principal with role='editor' on agent-common: → 200.
- ☐ Same setup, body `brain="agent-common"` set explicitly:
  outcomes match.

**Acceptance — Finding 2 closure (capture path, NEW in v11):**
- ☐ Service-key non-brain-bound principal with **read-only** access
  to `agent-common` (e.g., role doesn't exist, or estate-member
  only per D12), `?brain=agent-common` L1, no body `brain`,
  `/ingest/thought` POST: → **403** (mode='write' denies). NOT a
  successful capture written to agent-common.
- ☐ Same call shape with role='member' on agent-common (write
  allowed, edit not): → 200.
- ☐ Same with `capture_thought` MCP tool body `brain="agent-common"`:
  outcomes match.

**Acceptance — D8 v11 status codes on body `brain`:**
- ☐ `/admin/thought/metadata` body `brain=<typo-not-in-scope>` →
  404 ("Brain not found").
- ☐ `/admin/thought/metadata` body `brain=<resolves-but-not-accessible>`
  → 403 ("Not authorized for brain").
- ☐ Same status code rules for `/ingest/thought` body brain.

**Other acceptance** (legacy admin, brain-bound, repo principal,
admin in household, human-token MCP and non-MCP HTTP): unchanged
from v10.

### Phase 4 — Provisioning CLI (unchanged)

### Phase 5 — Per-repo `.envrc` (unchanged)

### Phase 6 — Routing skill (unchanged)

### Phase 7 — Migrate writers (unchanged)

### Phase 8 — Legacy-admin layer hygiene (unchanged)

## Risks and mitigations

(Unchanged from v10, plus:)

- **D8 v11 has two layers of failure (lookup scope vs access).
  Implementation must not collapse them.** Mitigation: D8
  explicitly names the two steps; Phase 2 matrix has separate rows
  for 404 (lookup miss) and 403 (lookup hit, access deny) on the
  same auth source, forcing the implementer to handle both paths.
- **L4 mode='write' on every capture is mandatory.** Mitigation:
  D7 normative rule + Phase 3 capture-path closure tests.
  Implementer cannot skip without a failing test.
- **Lookup scope vs accessible set are different things.**
  Mitigation: D8 v11 names them. Lookup scope is broader than
  accessible — it includes brains the principal could plausibly
  refer to even if access denies. Naming both prevents drift.

## Out of scope, tracked separately (unchanged)

## Open questions (unchanged)
