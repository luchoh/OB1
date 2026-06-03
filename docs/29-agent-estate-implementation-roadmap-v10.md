# PRD: Agent Estate + Brain Selection — Implementation Roadmap (v10)

Date: 2026-06-03
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`,
           CONTEXT `CONTEXT.md`,
           reviews v1–v9
Supersedes: v1, v2, v3, v4, v5, v6, v7, v8, v9

## Why v10

v9 was rejected on two findings, both at L4 seams that v9 hadn't
explicitly drawn:

1. **Authorization bypass on `/admin/thought/metadata` no-body
   path.** v9 ran `mode='edit'` only when body `brain` was set. A
   principal with read-only access to a brain via query/header L1
   selector, omitting body `brain`, would land on
   `effectiveBrainId=that-brain` and update without an edit check.
   `updateThoughtMetadata` (`server.mjs:566`) has no internal
   permission gate. Real bypass.
2. **D17's accessible-brain set dropped the admin household-wide
   carve-out.** D17 defined the set as `brain-allow ∪ estate-allow
   − brain-deny`. D6's admin branch says `is_admin=true` accesses
   every brain in the principal's household regardless of
   memberships, mirroring `auth.mjs:299-310`. v9's auth-context
   resolver would have rejected admin-key requests for in-household
   brains the admin had no explicit memberships for.

Plus one secondary gap:

3. **Phase 2a/2b dependency was muddled.** v9 said Phase 2a
   helpers operated on arrays "loaded in Phase 2b" while leaving
   Phase 2a acceptance unchanged. Either merge or be honest about
   ordering.

All three fixed in v10.

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

### D7. Omitted-`brain` write defaults align with ADR-0001 (unchanged from v9)

The contract: write surfaces (`/admin/thought/metadata`,
`/ingest/thought`, `capture_thought`) without body `brain` scope to
a single brain (`accessContext.effectiveBrainId`). Cross-brain
writes require explicit body `brain`. Multi-brain default is read-
only (ADR-0001 point 11 list).

**Authorization clarification (Finding 1 fix; new in v10):**

L1 selector authorization (D17) operates at **read scope**. It
permits a principal to bind `requestedBrain` if they can read it.
This is correct: an L1 selector saying "I'm interested in brain X"
shouldn't itself require edit privilege.

**The handler is responsible for running mode-specific access
checks**, every time. v9's mistake: the no-body path on
`/admin/thought/metadata` skipped the mode='edit' check and trusted
the L1-authorized `effectiveBrainId`.

v10 rule: `/admin/thought/metadata` runs
`checkBrainAccess({mode: 'edit'})` against the resolved target brain
**every time, regardless of whether body `brain` was set**.

For body `brain` set: target = resolved-from-body brain.
For body `brain` not set: target = `accessContext.effectiveBrainId`.

Either way, L4 mode='edit' enforcement runs before the SQL update.
If denied → 403, regardless of L1 selection.

This generalizes: every write surface runs L4 with the appropriate
mode against the actual target brain, every time. Specifically:

- `/admin/thought/metadata`: `mode='edit'` always.
- `/ingest/thought`, `capture_thought`: `mode='write'` always.
- Read tools: `mode='read'` always.

This is the seam-closing rule. L1 picks "what brain this request
talks about." L4 says "may this principal do THIS OPERATION on THAT
BRAIN." The two are independent. v9 conflated them on the no-body
write path.

#### `/admin/thought/metadata` rules (refined for Finding 1):

**Body `brain` set:**
- Resolve via D8.
- L4 `checkBrainAccess({mode: 'edit'})` against resolved brain. If
  403 → 403.
- WHERE: `id = $1 AND brain_id = $resolved`.

**Body `brain` unset:**
- Target = `accessContext.effectiveBrainId` (per auth source as in
  v9 D7).
- **L4 `checkBrainAccess({mode: 'edit'})` against target brain.** If
  403 → 403. **(NEW in v10 — Finding 1 fix.)**
- WHERE: `id = $1 AND brain_id = $target`.

Special legacy-admin sub-rule (carries over): if `legacy_admin_key`
AND body `brain` doesn't match `effectiveBrainForLegacyAdmin` → 400.

This eliminates the read-→-edit escalation path. A principal with
read-only access to brain X cannot patch rows in X by binding
`requestedBrain=X` and omitting body brain — L4 mode='edit' would
deny.

### D8. Slug-vs-UUID resolution (unchanged)

### D9. Human-token request-scoped binding (unchanged from v9, refined per D7 v10)

Same defaults as v9 D9. The L4 mode='edit' check on
`/admin/thought/metadata` (D7 v10) applies equally to human-token,
so the same Finding 1 fix protects this auth source.

### D10. Env split (unchanged)

### D11. Stored `is_admin` provisioning policy (unchanged)

### D12. Estate-membership `role='member'` is read-only (unchanged)

### D13. Smoke harness contract (unchanged)

### D14. Legacy-admin layer hygiene (unchanged)

### D15. `/admin/thought/access-check` query param (unchanged)

### D16. No estate-rename in this work (unchanged)

### D17. Auth-context resolution becomes estate-aware, with admin carve-out preserved (Finding 2 fix)

The auth-context resolvers (`resolveHumanAccessContext`,
`resolveStoredAccessKeyContext`) authorize `requestedBrain` (L1)
against a per-auth-source accessible set:

**Per-auth-source accessible-brain set used for L1 authorization:**

| auth source                                      | accessible-brain set used at L1 |
|--------------------------------------------------|---------------------------------|
| `legacy_admin_key`                               | global brains table (preserves `auth.mjs:336-364`) |
| `service_key, is_admin=true`                     | every brain in `accessContext.householdId` (preserves `auth.mjs:299` admin carve-out — Finding 2 fix) |
| `service_key, brain-bound`                       | `[key.brain_id]` |
| `service_key, non-brain-bound, non-admin`        | brain-allow ∪ estate-allow − brain-deny |
| `human_token`                                    | brain-allow ∪ estate-allow − brain-deny |

The "combined set" applies to non-admin, non-brain-bound principals
only. Admin keys keep their household-wide L1 selection authority,
matching D6 case 2 and the live runtime.

This is the same set definition that
`listAccessibleBrainIds({mode: 'read'})` in D6 uses; v10 makes it
explicit that admin keys take a different branch in the L1 resolver
just like they do in L4.

**`accessContext` shape (unchanged from v9):**

- `accessContext.brainMemberships`: array of {brain_id, brain_slug,
  role, is_deny}.
- `accessContext.estateMemberships`: array of {estate_id, role}.
- `accessContext.householdId`: the principal's home estate.
- `accessContext.effectiveBrainId`: the single brain bound to this
  request (L1 ?? key.brain_id ?? default).

L4 helpers (D6) read from `accessContext` arrays. Admin keys'
in-household brains are reachable via L4 case 2's
`brain.household_id == accessContext.householdId` check, so the
helper still works for admin keys without populating
`brainMemberships` or `estateMemberships` for them.

**Loader rename:**

`loadPrincipalMemberships` becomes `loadPrincipalAccess`, returning
both arrays plus the principal's metadata. Admin keys do NOT need
`brainMemberships` / `estateMemberships` populated for L1 (D17) or
L4 (D6) — both branches short-circuit on `is_admin=true`. The
loader still populates the arrays (cheap), but admin-branch logic
ignores them. v10 makes this explicit so an implementer doesn't
"optimize" by not loading them and miss the L4 case-4 fallback if
admin status is somehow unset on a row.

## Phasing

### Phase 1 — Schema (unchanged)

### Phase 2a/2b — merged (Secondary gap fix)

v9 had Phase 2a (helpers) and Phase 2b (selectors + estate-aware
loader) as nominally separate. The helpers in 2a depend on
`accessContext.brainMemberships` and `.estateMemberships`, which
2b populates. Until 2b lands, 2a's tests cannot run against the
live stack.

v10 merges them into **Phase 2 — Auth context + helpers**. One
deliverable, one acceptance pass. The implementation order within
the phase:

1. Migration 009 (covered by Phase 1).
2. `loadPrincipalAccess` per D17 (replaces
   `loadPrincipalMemberships`).
3. `accessContext` shape extension (`brainMemberships`,
   `estateMemberships`).
4. `resolveStoredAccessKeyContext` and `resolveHumanAccessContext`
   updated to:
   - call `loadPrincipalAccess`,
   - authorize `requestedBrain` against the per-auth-source
     accessible-brain set per D17 (admin → household, others →
     combined set).
5. Selector unification: detect simultaneous L1 sources → 400; for
   `human_token` reject query/header → 400.
6. Helpers: `checkBrainAccess({accessContext, brainId, mode})`,
   `listAccessibleBrainIds({accessContext, mode})`,
   `resolveBrainSlug`, `resolveBrainUuid`,
   `effectiveBrainForLegacyAdmin`.
7. `GET /admin/thought/access-check?target_brain=<...>` route.

Acceptance is one combined matrix (covers v9's Phase 2a + Phase 2b
matrices). Big but cohesive.

**Acceptance — selector + auth context (per D17 v10):**

| auth branch                                                        | scenario                                                                | expected |
|--------------------------------------------------------------------|-------------------------------------------------------------------------|----------|
| any                                                                | route+query L1 disagree                                                 | 400 |
| any                                                                | route+header L1 disagree                                                | 400 |
| any                                                                | query+header L1 disagree                                                | 400 |
| `human_token`                                                      | `?brain=ob1`                                                            | 400 |
| `human_token`                                                      | `x-brain-slug=ob1`                                                      | 400 |
| `human_token`                                                      | `POST /mcp/brains/ob1` (with brain-membership)                          | 200 |
| `service_key, is_admin`                                            | `?brain=<in-household, no-membership>` (admin carve-out, NEW Finding 2) | 200 |
| `service_key, is_admin`                                            | `?brain=<in-OTHER-household>`                                           | 403 |
| `service_key, brain-bound`                                         | `?brain=<key.brain_id>`                                                 | 200 |
| `service_key, brain-bound`                                         | `?brain=<other>`                                                        | 403 |
| `service_key, non-brain-bound, brain-membership only`              | `?brain=<member-brain>`                                                 | 200 |
| `service_key, non-brain-bound, estate-only`                        | `?brain=<brain-in-estate>`                                              | 200 |
| `service_key, non-brain-bound, estate-only`                        | `?brain=<brain-in-OTHER-estate>`                                        | 403 |
| `service_key, non-brain-bound, brain-deny + estate-allow`          | `?brain=<denied-brain>`                                                 | 403 |
| any non-legacy                                                     | `?brain=<slug-not-in-accessible>` resolveBrainSlug                      | 404 |
| any non-legacy                                                     | slug matches multiple in accessible                                     | 409 |

**Acceptance — L4 helpers (per D6 with three modes, unchanged from v9 Phase 2a):**

(Same matrix as v9, including the admin household carve-out.)

**Acceptance — `/admin/thought/access-check` endpoint:**

(Same matrix as v9.)

### Phase 3 — Tool & HTTP surfaces (was v9 Phase 2c; renumbered)

Handler-layer changes. Phase 2 finished above. Phase 3 wires routes.

**Capture path** (`capture_thought`, `/ingest/thought`):

(Same as v9. L4 `mode='write'` always runs against the resolved
target brain. Default = `accessContext.effectiveBrainId` per D7.)

**Read path** (`search_thoughts`, `list_thoughts`, `ask_brain`,
`/ask`, `/admin/thought/similar`):

(Same as v9. L4 `mode='read'` always.)

**`stats`:** (Same as v9. D5 multi-brain shape per scope.)

**`/admin/thought/metadata`** (Finding 1 fix in v10):

- Accept optional body `brain` field.
- Resolve target brain:
  - Body `brain` set → resolve via D8.
  - Body `brain` unset → `accessContext.effectiveBrainId`.
- **Run `checkBrainAccess({mode: 'edit'})` against target brain.**
  If 403 → 403. (NEW in v10.)
- Legacy-admin sub-rule: body `brain` ≠ `effectiveBrainForLegacyAdmin`
  → 400.
- WHERE: `id = $1 AND brain_id = $target`.
- Row not found → 404 with explicit "not in target brain X; pass
  body `brain` for cross-brain patch."

**`/graph/*`:** unchanged. Admin-only.

**Acceptance — Finding 1 closure (NEW canonical tests in v10):**

- ☐ Service-key non-brain-bound principal with **read-only** access
  to `agent-common` (e.g., role='member' on a brain or estate-member
  via D12) sets L1 `?brain=agent-common`, omits body `brain` on
  `/admin/thought/metadata`, target row exists in agent-common: →
  **403** (mode='edit' denies). NOT a successful update.
- ☐ Same principal, but role='editor' on agent-common, same call
  shape: → 200 (mode='edit' allows).
- ☐ Same setup, body `brain="agent-common"` set explicitly:
  outcomes match the no-body case (L4 makes the decision either
  way).

**Other acceptance** (legacy admin, brain-bound, repo principal,
admin in household, human-token): unchanged from v9.

### Phase 4 — Provisioning CLI (was v9 Phase 3, renumbered)

(Unchanged from v9.)

### Phase 5 — Per-repo `.envrc` (was Phase 4)

(Unchanged.)

### Phase 6 — Routing skill (was Phase 5)

(Unchanged from v9.)

### Phase 7 — Migrate writers (was Phase 6)

(Unchanged from v9.)

### Phase 8 — Legacy-admin layer hygiene (was Phase 7)

(Unchanged from v9.)

## Risks and mitigations

(Unchanged from v9, plus:)

- **L4 mode='edit' check on every metadata patch is mandatory.**
  Mitigation: it is in D7's normative rules and Phase 3 acceptance
  has explicit Finding 1 closure tests. Implementer cannot skip it
  without a failing test.
- **`loadPrincipalAccess` ignored arrays for admin keys.**
  Mitigation: D17 makes the admin short-circuit explicit. Loader
  still populates the arrays so the data is available if needed by
  future code.
- **Phase 2 is now bigger than v9's Phase 2a or Phase 2b alone.**
  Mitigation: it's a single coordinated change. The acceptance
  matrix is comprehensive. Splitting into 2a/2b was always
  artificial for this work.

## Out of scope, tracked separately (unchanged)

## Open questions (unchanged)
