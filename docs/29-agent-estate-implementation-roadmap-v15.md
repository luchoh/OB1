# PRD: Agent Estate + Brain Selection — Implementation Roadmap (v15)

Date: 2026-06-03
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`,
           CONTEXT `CONTEXT.md`,
           reviews v1–v14
Supersedes: v1–v14

## Why v15

v14 was rejected on one finding plus one secondary gap. Both
about how the doc described its own changes:

1. **Human-token contract change was real but underspecified.** v14
   said `docs/17:565`'s "household-wide slug → 403 if no
   membership" was superseded by explicit-grants-only semantics,
   but the executable acceptance matrix barely exercised
   human-token, and the migration section named only
   `resolveStoredAccessKeyContext` (stored-key path) without
   pointing at `resolveHumanAccessContext` (the human-token path
   that today does the very thing being superseded).
2. **"404 means never granted" was too strong.** A standalone
   `brain_memberships(P, B, is_deny=true)` row with no allow path
   would produce 404 (lookup miss) — but there IS an affirmative
   deny on record. The phrasing overstated the rationale.

v15 fixes both:

- Adds explicit human-token route acceptance rows for negative
  paths (same-household-no-grant 404; deny-override 403).
- Migration section names `resolveHumanAccessContext` as a required
  migration target alongside the stored-key resolver.
- Tightens D18 wording: "404 means no current allow path" instead
  of "never granted." Adds an operational note that orphan deny
  rows are valid (the schema permits them) but are *informational
  only* in v15 — they don't cause 403 unless an allow path also
  reaches the brain.

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

### D8. Slug-vs-UUID resolution — visibility tracks explicit grants, with deny override visible (refined for orphan-deny case + human migration)

The two-step structure stays. Lookup scope stays. v15 refines the
deny semantics and the migration story.

#### Slug lookup scope per auth source (unchanged from v13/v14)

| auth source                                | slug lookup scope |
|--------------------------------------------|-------------------|
| `legacy_admin_key`                         | global brains table |
| `service_key, is_admin=true`               | every brain in `accessContext.householdId` |
| `service_key, brain-bound`                 | `[key.brain_id]` |
| `service_key, non-brain-bound, non-admin`  | `brainAllows(P) ∪ estateBrains(estateAllows(P))` |
| `human_token`                              | same as service_key non-brain-bound |

Lookup scope is built from **allow rows only**. A standalone
`brain_memberships(P, B, is_deny=true)` row does NOT add B to
lookup scope. To find B in lookup scope, the principal must have
SOME allow path covering B.

#### Two-step resolution (unchanged shape)

1. **Lookup** → 404 if 0 matches, 409 if multi-match, else proceed.
2. **Authorize** via `checkBrainAccess({mode: 'read'})` → 403 on
   DENY, return UUID on ALLOW.

`resolveBrainUuid` unchanged: 404 for nonexistent rows, 403 for
existing-but-inaccessible.

#### Inline accessible-set definition (unchanged from v14)

```
accessibleSet(P) = brainAllows(P) ∪ estateBrains(estateAllows(P))
                 − brainDenies(P)

lookupScope(P)   = brainAllows(P) ∪ estateBrains(estateAllows(P))
                 (i.e., accessibleSet + brain-deny rows that overlap an estate-allow)
```

`lookupScope(P) ⊇ accessibleSet(P)`. The strict-superset case is
exactly: a brain B reachable via an estate-membership grant AND a
`brain_memberships(P, B, is_deny=true)` row. Slug for B resolves
(via the estate path); access check denies (via the deny override);
result 403.

#### Orphan deny rows (Finding secondary 2 fix)

A `brain_memberships(P, B, is_deny=true)` row with no allow path
covering B (no `brain_memberships(P, B, is_deny=false)`, no
`estate_memberships(P, E)` where B ∈ E) is called an **orphan deny
row**. Under v15:

- B is NOT in `lookupScope(P)`. Slug for B → 404.
- The deny row is informational only — it does not cause a 403
  because the principal has no allow path to deny against.
- Schema permits orphan deny rows (no FK or check forbids them).
  v15 doesn't change that.
- The provisioning CLI (Phase 4) does NOT create orphan deny rows
  by default. Operator may create one manually if they want to
  pre-deny in anticipation of a future estate grant; that's allowed
  but unusual.

This means **404 means "no current allow path,"** not "never
granted." Phrasing tightened in D18 below.

If a future operator concern surfaces — e.g., "I want orphan deny
rows to surface as 403 so I can audit revocations even when no
allow path exists" — that's a separate ADR amending this. Not in
scope.

#### Migration to v15 D8 (Finding 1 fix part 1)

**Both `resolveStoredAccessKeyContext` AND `resolveHumanAccessContext`
must change.** v14 named only the stored-key path; v15 names both.

Stored-key path (`auth.mjs:241-317`):
- Today: household-wide slug lookup, then membership check.
- v15: lookup over `lookupScope(P)` per the table above. Narrower
  for non-admin non-brain-bound; admin keys keep household.

Human-token path (`auth.mjs:159-225`) — **NEW migration target in
v15**:
- Today: `resolveBrainBySlugForHousehold(memberships.householdId,
  requestedBrainSlug)` (`auth.mjs:202`), then membership check
  (`auth.mjs:209`). 404 if slug not in household; 403 if in
  household but no membership.
- v15: lookup over `lookupScope(P)` per D8 (same as service_key
  non-brain-bound). 404 for in-household-but-no-grant (changed from
  today's 403). 403 only for deny override of an allow path.

This is the explicit human migration. Without it, the human-token
contract still does the old thing while v15 prose says it doesn't.

### D9. Human-token request-scoped binding (unchanged)

### D10. Env split (unchanged)

### D11. Stored `is_admin` provisioning policy (unchanged)

### D12. Estate-membership `role='member'` is read-only (unchanged)

### D13. Smoke harness contract (unchanged)

### D14. Legacy-admin layer hygiene (unchanged)

### D15. `/admin/thought/access-check` query param `target_brain` (unchanged)

### D16. No estate-rename in this work (unchanged)

### D17. Auth-context resolution becomes estate-aware (unchanged from v14)

### D18. Visibility tracks explicit grants; lookup is a superset of access; 404 means no current allow path (Finding 1 fix + Finding secondary 2 fix)

The v14 D18 properties stand:
- Visibility-via-explicit-grants property: home estate gives no
  implicit visibility.
- Lookup ⊇ access property: lookup is a strict superset of access,
  differing only by deny rows that overlap an allow path.

The wording refinement in v15:

**404 means "no current allow path covers this brain for this
principal."** It does NOT necessarily mean "never granted" or
"deny doesn't exist." A standalone `brain_memberships(P, B,
is_deny=true)` row alone does not produce a 403 — there's no allow
path, so lookup misses, response is 404. The deny row is
informational only in that case.

**403 means "principal has an allow path to this brain, but a
brain-deny row blocks access."** Reachable only when an
`estate_memberships(P, E)` row covers B's estate AND
`brain_memberships(P, B, is_deny=true)` exists.

**Supersedes-`docs/17:565` (kept from v14):** human-token slug
visibility is explicit-grants-only. Same-household-with-no-grant
returns 404 (was 403). Behavior change for human-token; affects
no current production caller (Keycloak binding not yet wired).

## Phasing

### Phase 1 — Schema (unchanged)

### Phase 2 — Auth context + helpers

Acceptance matrix expanded with the human-token negative-path rows
(Finding 1 fix part 2):

| auth branch                                                                   | scenario                                                              | expected | rationale |
|-------------------------------------------------------------------------------|-----------------------------------------------------------------------|----------|-----------|
| any                                                                           | route+query/header L1 disagree                                        | 400      | D2 |
| `human_token`                                                                 | `?brain=ob1`                                                          | 400      | D2/D9 |
| `human_token`                                                                 | `x-brain-slug=ob1`                                                    | 400      | D2/D9 |
| `human_token`                                                                 | `POST /mcp/brains/ob1` (brain-membership exists)                      | 200      | D9 |
| **`human_token`, no membership to target, target in same household** (NEW Finding 1) | **`POST /mcp/brains/<same-household-no-grant>`**                      | **404**  | **D18: explicit-grants-only; supersedes `docs/17:565`** |
| **`human_token`, brain-deny override of estate-allow** (NEW Finding 1)        | **`POST /mcp/brains/<denied-via-brain_membership-reached-via-estate>`** | **403**  | **D18: lookup hit via estate, deny wins** |
| **`human_token`, estate-only access** (NEW)                                   | **`POST /mcp/brains/<brain-in-membership-estate>`**                   | **200**  | **D8 lookup includes estateBrains** |
| **`human_token`, cross-estate direct brain-membership** (NEW)                 | **`POST /mcp/brains/<brain-in-other-estate-via-brain-membership>`**   | **200**  | **D8 lookup includes brainAllows (any estate)** |
| `service_key, is_admin`                                                       | `?brain=<in-household, no-membership>`                                | 200      | D6 case 2 |
| `service_key, is_admin`                                                       | `?brain=<in-OTHER-household>`                                         | 404      | not in admin lookup |
| `service_key, brain-bound`                                                    | `?brain=<key.brain_id>`                                               | 200      | D6 case 3 |
| `service_key, brain-bound`                                                    | `?brain=<other-anywhere>`                                             | 404      | not in `[key.brain_id]` |
| `service_key, non-brain-bound, brain-membership only`                         | `?brain=<member-brain>`                                               | 200      | brainAllows |
| `service_key, non-brain-bound, estate-only`                                   | `?brain=<brain-in-membership-estate>`                                 | 200      | estateBrains |
| `service_key, non-brain-bound, estate-only`                                   | `?brain=<brain-in-OTHER-estate-NO-membership>`                        | 404      | no allow path |
| `service_key, non-brain-bound, brain-deny + estate-allow`                     | `?brain=<denied-brain>`                                               | 403      | D18 lookup-hit + deny |
| **`service_key, non-brain-bound, ORPHAN DENY ROW (no allow path)`** (NEW Finding secondary 2) | **`?brain=<brain-with-orphan-deny>`**                                 | **404**  | **D18: orphan deny → no allow path → 404** |
| `service_key, non-brain-bound, ONLY direct cross-estate brain-membership`     | `?brain=<brain-in-other-estate-via-direct-brain-membership>`          | 200      | brainAllows |
| `service_key, non-brain-bound, repo principal homed in agent-estate, NO membership` | `?brain=<sibling-repo-brain-no-membership>`                           | 404      | no implicit home-estate visibility |
| `service_key, non-brain-bound, repo with brain-membership to common-brain`    | `?brain=common-brain`                                                 | 200      | brainAllows |
| any non-legacy                                                                | `?brain=<typo>`                                                       | 404      | not in lookup |
| any non-legacy                                                                | slug matches multiple in lookup scope                                 | 409      | ambiguity |

The five **NEW** rows close Finding 1 (four human-token rows) and
Finding secondary 2 (orphan-deny row).

**Acceptance — L4 helpers** (per D6, unchanged).

**Acceptance — `/admin/thought/access-check`:** unchanged from v13;
the orphan-deny case is implicitly tested by the same logic.

**Migration sites named in Phase 2 implementation order
(refresh):**

1. Migration 009 (Phase 1).
2. `loadPrincipalAccess` per D17 (replaces
   `loadPrincipalMemberships` — `auth.mjs:65`).
3. `accessContext` shape extension (`brainMemberships`,
   `estateMemberships`).
4. **`resolveStoredAccessKeyContext` updated** (`auth.mjs:241-317`):
   slug lookup over `lookupScope(P)` per D8.
5. **`resolveHumanAccessContext` updated** (`auth.mjs:159-225`):
   slug lookup over `lookupScope(P)` per D8. **NEW migration target
   in v15.**
6. Selector unification in `resolveAccessContext`: simultaneous-L1
   detection, human-token query/header rejection.
7. Helpers: `checkBrainAccess`, `listAccessibleBrainIds`,
   `resolveBrainSlug`, `resolveBrainUuid`,
   `effectiveBrainForLegacyAdmin`.
8. `GET /admin/thought/access-check?target_brain=<...>` route.

### Phase 3 — Tool & HTTP surfaces (unchanged from v11/v12/v13/v14)

(Includes the metadata Finding 1 closure tests from v10 and the
capture Finding 2 closure tests from v11.)

### Phase 4 — Provisioning CLI (unchanged from v13)

Re-stated note: provisioning never creates orphan deny rows. Operator
may add them manually for pre-deny scenarios; v15 treats them as
informational and they produce 404 (not 403) under the lookup-scope
rule.

### Phase 5 — Per-repo `.envrc` (unchanged)

### Phase 6 — Routing skill (unchanged)

### Phase 7 — Migrate writers (unchanged)

### Phase 8 — Legacy-admin layer hygiene (unchanged)

## Risks and mitigations

(Unchanged from v14, plus:)

- **Human-token migration is a real behavior change.**
  Mitigation: D8 v15 names `resolveHumanAccessContext` as a
  migration site. Phase 2 acceptance has four new human-token rows.
  No production caller is affected today (Keycloak binding not
  wired); the contract is forward-looking.
- **Orphan deny rows produce 404, not 403.** Mitigation: D18 v15
  states this explicitly. Phase 2 has a dedicated test row.
  Operators expecting "deny logs as 403" can read the row directly
  in `brain_memberships`; deny rows remain audit-grep-able.
- **"404 means no current allow path" is the canonical phrasing.**
  Replaces v14's "404 means never granted" which was too strong.

## Out of scope, tracked separately (unchanged)

## Open questions (unchanged)
