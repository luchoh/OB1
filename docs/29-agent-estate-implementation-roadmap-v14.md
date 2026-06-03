# PRD: Agent Estate + Brain Selection — Implementation Roadmap (v14)

Date: 2026-06-03
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`,
           CONTEXT `CONTEXT.md`,
           reviews v1–v13
Supersedes: v1–v13

## Why v14

v13 was rejected on one finding plus one secondary gap. The
finding: D8 and D18 contradicted each other on
`brain-deny + estate-allow`. D8 said the slug resolves and returns
403; D18 said `lookup scope = access set` (which would make a
denied brain invisible — 404). Cannot both be true.

v14 picks **World A**: lookup is a strict superset of access. The
difference is exactly `brain-deny` rows. A denied brain remains
slug-visible to a caller who has an estate-membership grant
covering that brain — and step 2 returns 403 with "Not authorized
for brain." This is more truthful than 404 because brain-deny is
an affirmative operator action; 404 ("never granted") would
mislead.

Concretely v14:

1. Rewrites D18 to say "lookup ⊇ access" instead of "lookup =
   access," names the exception (deny rows), and inlines the
   accessible-set rule so the reader doesn't have to cross-reference
   v12.
2. Says explicitly that `docs/17:565`'s "household-wide slug
   resolution returning 403" is **superseded by v14** for the agent-
   estate model. Human-token visibility is explicit-grants-only.

The v13 lookup scope (membership-only, no implicit home-estate)
stays. The v13 closure tests for sibling-repo-brain probing (404)
stay. The new closure tests for `brain-deny + estate-allow` (403)
stay too — they're now consistent with D18.

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

### D8. Slug-vs-UUID resolution — visibility tracks explicit grants, with deny override visible (Finding 1 fix)

The two-step structure (lookup → access check) stays. The lookup
scope per auth source stays as in v13. The contradiction between
D8 and D18 is resolved by stating clearly that **lookup is a strict
superset of access**, differing only by deny rows.

#### Slug lookup scope per auth source (unchanged from v13)

| auth source                                | slug lookup scope |
|--------------------------------------------|-------------------|
| `legacy_admin_key`                         | global brains table |
| `service_key, is_admin=true`               | every brain in `accessContext.householdId` |
| `service_key, brain-bound`                 | `[key.brain_id]` |
| `service_key, non-brain-bound, non-admin`  | `brainMemberships` (allow rows) ∪ (brains in estates with `estate_memberships` allow rows) |
| `human_token`                              | same as service_key non-brain-bound |

Crucial detail: the lookup scope is built from **allow rows only**.
A `brain-memberships(P, B, is_deny=true)` row does NOT grant
visibility, but the principal may still have visibility into B
through some OTHER allow path — typically an `estate_memberships`
row covering B's estate. In that case, the slug for B is in lookup
scope (via the estate path), step 1 resolves, step 2 access-checks
and applies the deny → 403.

If no allow path covers B at all, B is absent from lookup scope, and
the slug for B returns 404.

#### Two-step resolution

`resolveBrainSlug({accessContext, slug}) → resolution`:

1. **Lookup** the slug within the per-auth-source lookup scope (allow-
   row driven, per the table above).
   - 0 matches: **404 Brain not found.**
   - Multiple matches: **409 Conflict, pass UUID.**
   - 1 match: proceed to step 2.
2. **Authorize** via `checkBrainAccess({mode: 'read'})`.
   - ALLOW: return UUID.
   - DENY: **403 Not authorized for brain.** (Reachable when a
     `brain_memberships` deny row overrides an otherwise-allowing
     estate-membership grant.)

`resolveBrainUuid({accessContext, brainId}) → resolution`:

1. If no row in `brains`: **404.**
2. Run `checkBrainAccess({mode: 'read'})`. ALLOW → return; DENY →
   **403.**

#### Inline accessible-set definition (Finding 1 secondary cleanup)

For non-admin non-brain-bound and `human_token` (the only auth
sources whose access is membership-driven):

```
accessibleSet(P) = brainAllows(P) ∪ estateBrains(estateAllows(P))
                 − brainDenies(P)

where:
  brainAllows(P)   = { B : brain_memberships(P, B, is_deny=false) exists }
  brainDenies(P)   = { B : brain_memberships(P, B, is_deny=true)  exists }
  estateAllows(P)  = { E : estate_memberships(P, E) exists }
  estateBrains(Es) = { B : B.household_id ∈ Es }
```

This is the same set v12 D17 used; v14 inlines it so the reader
doesn't have to chase across versions.

`lookupScope(P) = brainAllows(P) ∪ estateBrains(estateAllows(P))`

(i.e., accessibleSet + the brain-deny rows).

`lookupScope(P) ⊇ accessibleSet(P)` always, with the difference
being exactly the brain-deny rows that overlap an estate-allow.

#### Migration to v14 D8 (unchanged from v13)

Same migration story as v13. Code-level deltas vs today's
`auth.mjs:286-310`:

- Today: stored-key slug lookup uses
  `resolveBrainBySlugForHousehold(first.household_id, slug)`
  (household-wide).
- v14: stored-key slug lookup operates over `lookupScope(P)`
  defined above. Narrower for non-admin non-brain-bound and
  human-token; admin keys keep household-wide.
- Today: brain-bound mismatch returns 403 ("Access key is bound to
  a different brain") for any brain in the household.
- v14: brain-bound returns 404 for any slug other than its one
  brain (lookupScope is `[key.brain_id]`). Behavioral delta vs
  today, documented in D8 above.
- New behavior under v14: a non-admin non-brain-bound principal
  with `estate_memberships(P, E)` AND `brain_memberships(P, B,
  is_deny=true)` where B ∈ E: slug resolves (via estate path), L4
  denies, returns 403. Possible today only if estate-membership
  rows existed (they don't yet); v14 extends behavior consistently.

### D9. Human-token request-scoped binding (unchanged)

### D10. Env split (unchanged)

### D11. Stored `is_admin` provisioning policy (unchanged)

### D12. Estate-membership `role='member'` is read-only (unchanged)

### D13. Smoke harness contract (unchanged)

### D14. Legacy-admin layer hygiene (unchanged)

### D15. `/admin/thought/access-check` query param `target_brain` (unchanged)

### D16. No estate-rename in this work (unchanged)

### D17. Auth-context resolution becomes estate-aware, with admin carve-out preserved (inlined into D8 v14, kept normative)

The accessible-set definition for L1 authorization in
`resolveStoredAccessKeyContext` and `resolveHumanAccessContext` is
exactly `accessibleSet(P)` from D8 v14. Admin keys keep their
household-wide carve-out (D6 case 2). Brain-bound keys keep
`[key.brain_id]` only (D6 case 3).

### D18. Visibility tracks explicit grants; lookup is a superset of access (Finding 1 fix; rewritten)

The v13 D18 statement "lookup scope = access set" was wrong. v14
restates the design property correctly:

**Visibility-via-explicit-grants property (v14):**

For non-admin non-brain-bound and `human_token` principals,
visibility is bounded by **explicit grants**. There is no "home
estate gives implicit visibility" rule. A repo principal cannot
slug-probe sibling brains in its home estate without an explicit
grant.

**Lookup ⊇ access property (v14, replaces v13's lookup = access):**

For the same auth sources, `lookupScope(P) ⊇ accessibleSet(P)`. The
strict superset relation is intentional: a principal can
*encounter* a brain via slug (because they have an allow grant
through estate-membership) and still be denied access (because of
a brain-deny override). In that case the response is 403, not 404,
because the principal demonstrably has a grant relationship to the
brain — they just don't have access to THIS one. 404 ("never
granted") would mislead by hiding the affirmative deny.

The two properties together:
- 404 if the principal has no allow path to the brain (lookup miss).
- 403 if the principal has an allow path that reaches the brain but
  a brain-deny row blocks access.
- 200 if the allow path reaches and no deny blocks.

These rules apply to slug selection. UUID selection uses
`resolveBrainUuid` and is opaque-row-driven (404 for nonexistent;
403 for existing-but-inaccessible).

**Supersedes-`docs/17:565` (Finding secondary fix):**

`docs/17:565` ("household-wide slug resolution returning 403 for
inaccessible brains in same household") is superseded for the
agent-estate model by D18 v14. Human-token visibility is now
explicit-grants-only: 404 for a brain in the same household with no
explicit grant; 403 only for brain-deny override of an estate-
allow.

The behavioral change for human-token affects no current caller
(human-token is unused in production today; Keycloak binding is
not yet wired). It's a forward-looking contract for when human-
token is enabled.

If you ever want to restore the broad household-wide visibility
rule for human-token specifically, that's a separate ADR amending
this one. Not in scope.

## Phasing

### Phase 1 — Schema (unchanged)

### Phase 2 — Auth context + helpers

(Unchanged from v13. Acceptance matrix already had the right rows;
v14 D8/D18 fix makes them consistent with the design properties.)

**Acceptance — selector + auth context (v14, same matrix as v13
with consistency notes):**

| auth branch                                                                   | scenario                                                              | expected | rationale |
|-------------------------------------------------------------------------------|-----------------------------------------------------------------------|----------|-----------|
| any                                                                           | route+query/header L1 disagree                                        | 400      | D2 |
| `human_token`                                                                 | `?brain=ob1`                                                          | 400      | D2/D9 |
| `human_token`                                                                 | `POST /mcp/brains/ob1` (brain-membership)                             | 200      | D9 |
| `service_key, is_admin`                                                       | `?brain=<in-household, no-membership>`                                | 200      | D6 case 2 |
| `service_key, is_admin`                                                       | `?brain=<in-OTHER-household>`                                         | 404      | not in admin lookup scope |
| `service_key, brain-bound`                                                    | `?brain=<key.brain_id>`                                               | 200      | D6 case 3 |
| `service_key, brain-bound`                                                    | `?brain=<other-anywhere>`                                             | 404      | not in `[key.brain_id]` lookup scope |
| `service_key, non-brain-bound, brain-membership only` (own estate)            | `?brain=<member-brain>`                                               | 200      | brainAllows |
| `service_key, non-brain-bound, estate-only`                                   | `?brain=<brain-in-membership-estate>`                                 | 200      | estateBrains |
| `service_key, non-brain-bound, estate-only`                                   | `?brain=<brain-in-OTHER-estate-NO-membership>`                        | 404      | no allow path |
| `service_key, non-brain-bound, brain-deny + estate-allow`                     | `?brain=<denied-brain>`                                               | **403**  | **lookup hit via estate; access deny via brain-deny override (D18 v14)** |
| `service_key, non-brain-bound, ONLY direct cross-estate brain-membership`     | `?brain=<brain-in-other-estate-via-direct-brain-membership>`          | 200      | brainAllows (any estate) |
| `service_key, non-brain-bound, repo principal homed in agent-estate, NO membership to sibling brain` | `?brain=<sibling-repo-brain-in-agent-estate-no-membership>`           | 404      | D18: no implicit home-estate visibility |
| `service_key, non-brain-bound, repo principal with brain-membership to common-brain` | `?brain=common-brain`                                                | 200      | brainAllows |
| any non-legacy                                                                | `?brain=<typo>`                                                       | 404      | not in lookup |
| any non-legacy                                                                | slug matches multiple in lookup scope                                 | 409      | ambiguity |

**Acceptance — L4 helpers** (per D6, unchanged).

**Acceptance — `/admin/thought/access-check`:**

(Unchanged from v13.)

### Phase 3 — Tool & HTTP surfaces (unchanged from v11/v12/v13)

### Phase 4 — Provisioning CLI (unchanged)

### Phase 5 — Per-repo `.envrc` (unchanged)

### Phase 6 — Routing skill (unchanged)

### Phase 7 — Migrate writers (unchanged)

### Phase 8 — Legacy-admin layer hygiene (unchanged)

## Risks and mitigations

(Unchanged from v13, plus:)

- **Lookup ⊇ access is the v14 invariant.** Mitigation: D18 states
  it normatively. Phase 2 matrix has separate rows for the two cases
  (lookup miss → 404, lookup hit + access deny → 403) so a future
  edit cannot collapse them without a failing test.
- **`docs/17:565` superseded for human-token.** Mitigation: D18 says
  so explicitly. No production caller affected (Keycloak-bound
  human-token isn't wired yet).

## Out of scope, tracked separately (unchanged)

## Open questions (unchanged)
