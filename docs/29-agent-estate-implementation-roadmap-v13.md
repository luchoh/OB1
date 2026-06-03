# PRD: Agent Estate + Brain Selection — Implementation Roadmap (v13)

Date: 2026-06-03
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`,
           CONTEXT `CONTEXT.md`,
           reviews v1–v12
Supersedes: v1–v12

## Why v13

v12 was rejected on one finding plus one secondary gap, both naming
the same policy collision: D8's "home estate is automatic lookup
scope" disclosed brain existence (via 403) that the canonical
repo-principal model intentionally hides (via 404 / brain-membership-
only visibility).

ADR-0001 point 2 + 3, v7's provisioning section, and CONTEXT.md all
say the same thing: repo principals get visibility through
**explicit grants** — `brain_memberships` rows or `estate_memberships`
rows. They do NOT get implicit visibility into sibling brains in
their home estate. v12 accidentally added that implicit visibility
by including "home estate" in the lookup scope unconditionally.

v13 picks the explicit-grant policy across the board. There is no
"home estate gives implicit visibility" rule. Visibility — both at
slug-existence (404 vs 403) and at access (403 vs 200) — is driven
by explicit memberships only.

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

### D8. Slug-vs-UUID resolution — visibility tracks explicit grants (Finding 1 fix)

The two-step structure (lookup → access check) from v11/v12 stays.
The **lookup scope** is corrected: home estate is no longer an
automatic part of it. Visibility tracks explicit memberships only,
matching ADR-0001 + v7 provisioning + CONTEXT.md.

#### Slug lookup scope per auth source (v13, corrected)

| auth source                                | slug lookup scope |
|--------------------------------------------|-------------------|
| `legacy_admin_key`                         | global brains table |
| `service_key, is_admin=true`               | every brain in `accessContext.householdId` (admin carve-out) |
| `service_key, brain-bound`                 | `[key.brain_id]` only (slug must resolve to that one brain) |
| `service_key, non-brain-bound, non-admin`  | `brainMemberships` ∪ `(brains in estates with estate_memberships)` |
| `human_token`                              | `brainMemberships` ∪ `(brains in estates with estate_memberships)` |

Differences vs v12:

- Home estate is **removed** as an automatic lookup-scope
  contributor. A non-admin repo principal homed in the agent estate
  can NOT slug-probe sibling repo brains in the same estate without
  an explicit grant. The slug returns 404, not 403.
- Brain-bound stored keys' lookup scope narrows to `[key.brain_id]`
  (matches the access set). A slug typo for any other brain returns
  404, not 403. (Slight behavioral change vs the live runtime,
  which today does household-wide lookup before brain-bound denial.
  v13 chooses the tighter rule for consistency with the explicit-
  grant policy.)
- Admin carve-out preserved: `service_key, is_admin=true` retains
  household-wide lookup. Admin keys are intentionally privileged.
- Non-admin non-brain-bound and human-token: scope is exactly the
  set of brains the principal has an explicit relationship to,
  through either `brainMemberships` (any estate) or
  `estateMemberships` (every brain in those estates).

#### Why this is consistent with everything

- **ADR-0001 point 2-3:** "Two ways to grant: estate-level
  membership (broad — all brains in the estate) or brain-level
  membership (specific)." No third way called "home estate
  implicit." v13 D8 honors that.
- **v7 provisioning:** "Repo principal does NOT have an
  `estate_memberships` row in the agent estate." "Repo principal
  cannot read brains in agent estate that they don't have a
  `brain_memberships` row for." v13 D8 lookup scope = these grants
  exactly.
- **CONTEXT.md common brain:** "single brain in the agent estate,
  shared via brain memberships across all repo principals." Each
  repo principal has a `brain_memberships(repo-principal,
  common-brain, role='editor')` row. That row puts common-brain in
  their lookup scope. Sibling repo brains, without such a row,
  remain hidden.
- **Operator path D3:** `estate_memberships(luchoh, agent-estate,
  role='admin')` puts every brain in agent-estate into the
  operator's lookup scope. The operator can slug-resolve any agent
  brain. ✓

#### `resolveBrainSlug({accessContext, slug}) → resolution` (unchanged shape)

Two-step:

1. Lookup the slug within the per-auth-source lookup scope.
   - 0 matches: **404 Brain not found.**
   - Multiple matches: **409 Conflict, pass UUID.**
   - 1 match: proceed to step 2.
2. Authorize via `checkBrainAccess({mode: 'read'})`.
   - ALLOW: return UUID.
   - DENY: **403 Not authorized for brain.**

When does step 2 actually deny? In v13, the lookup scope IS the
read-accessible set (subject to the small admin/brain-bound
carve-outs above), so step 2 nearly always allows. The remaining
case where step 2 denies is **brain-deny override** —
`brain_memberships(P, B, is_deny=true)` exists, AND there's an
`estate_memberships(P, E)` row that would otherwise grant access
to B, AND P uses the slug for B. Lookup includes B (via the estate
membership), step 2 denies (via the brain-deny override).

The slug-and-UUID consistency property from v12 still holds:
accessible-by-UUID implies accessible-by-slug. The lookup scope is
narrower in v13, but it tracks the read-accessible set faithfully
for non-admin non-brain-bound principals.

#### `resolveBrainUuid` (unchanged from v11/v12)

UUIDs are opaque. 404 for nonexistent rows; 403 for existing-but-
inaccessible. Unchanged.

#### Migration to v13 D8

Code-level changes vs today (`auth.mjs:286-310`):

- Today: stored-key slug lookup uses
  `resolveBrainBySlugForHousehold(first.household_id, slug)`.
  Household-wide lookup, then membership/admin checks.
- v13: stored-key slug lookup operates over the union scope
  (brain-memberships ∪ estate-membership-bound estates) for
  non-admin non-brain-bound, OR `[key.brain_id]` for brain-bound,
  OR household for admin keys.
- **Behavior delta vs today:** a non-admin non-brain-bound stored
  key today CAN resolve any household brain by slug (and is then
  rejected at access check). v13: it can only resolve its own
  membership-set. A typo for a sibling household brain returns 404
  in v13 vs 403 today.
- **Why this delta is acceptable:** today's behavior was inherited
  from `docs/17`'s human-household model. v13 aligns slug visibility
  with the explicit-grant model from ADR-0001. The delta affects
  zero current callers (the only stored key today is bootstrap-
  admin, which is admin and unaffected). The policy is forward-
  looking.

### D9. Human-token request-scoped binding (unchanged)

### D10. Env split (unchanged)

### D11. Stored `is_admin` provisioning policy (unchanged)

### D12. Estate-membership `role='member'` is read-only (unchanged)

### D13. Smoke harness contract (unchanged)

### D14. Legacy-admin layer hygiene (unchanged)

### D15. `/admin/thought/access-check` query param `target_brain` (unchanged)

### D16. No estate-rename in this work (unchanged)

### D17. Auth-context resolution becomes estate-aware, with admin carve-out preserved (unchanged from v10/v11/v12)

### D18. Visibility-via-explicit-grants is a normative property (NEW)

v13 explicitly states the design property that v12 violated:

**For non-admin non-brain-bound and human-token principals,
visibility (slug-resolvability and existence-disclosure-via-403)
tracks the same set as access. There is no "home estate gives
implicit visibility" rule. A repo principal cannot slug-probe
sibling brains in its home estate without an explicit grant.**

This is enforced by:

- D8 lookup scope being the membership-bound union (not home-
  estate-bound).
- D17 accessible set being the same membership-bound union.
- The slug-and-UUID consistency property: lookup scope = access
  set for these auth sources.

Admin keys (D6 case 2, D17 admin carve-out) retain household-wide
visibility because they are explicitly elevated. Brain-bound keys
have the narrowest visibility (their one brain). These are the only
two carve-outs from the explicit-grant rule, both well-named.

## Phasing

### Phase 1 — Schema (unchanged)

### Phase 2 — Auth context + helpers (refined matrix per D8 v13)

**Acceptance — selector + auth context (v13 matrix):**

| auth branch                                                                   | scenario                                                                | expected |
|-------------------------------------------------------------------------------|-------------------------------------------------------------------------|----------|
| any                                                                           | route+query L1 disagree                                                 | 400 |
| any                                                                           | route+header L1 disagree                                                | 400 |
| any                                                                           | query+header L1 disagree                                                | 400 |
| `human_token`                                                                 | `?brain=ob1`                                                            | 400 |
| `human_token`                                                                 | `x-brain-slug=ob1`                                                      | 400 |
| `human_token`                                                                 | `POST /mcp/brains/ob1` (brain-membership exists)                        | 200 |
| `service_key, is_admin`                                                       | `?brain=<in-household, no-membership>` (admin carve-out)                | 200 |
| `service_key, is_admin`                                                       | `?brain=<in-OTHER-household>` (slug not in admin scope)                 | 404 |
| `service_key, brain-bound`                                                    | `?brain=<key.brain_id>`                                                 | 200 |
| `service_key, brain-bound`                                                    | `?brain=<other-anywhere>` (slug not in scope `[key.brain_id]`)          | 404 (v13 change vs today's 403; behavior delta documented in D8) |
| `service_key, non-brain-bound, brain-membership only` (in own estate)         | `?brain=<member-brain>`                                                 | 200 |
| `service_key, non-brain-bound, estate-only`                                   | `?brain=<brain-in-membership-estate>`                                   | 200 |
| `service_key, non-brain-bound, estate-only`                                   | `?brain=<brain-in-OTHER-estate-NO-membership>`                          | 404 |
| `service_key, non-brain-bound, brain-deny + estate-allow`                     | `?brain=<denied-brain>` (resolves in scope, then DENY at L4)            | 403 |
| `service_key, non-brain-bound, ONLY direct cross-estate brain-membership`     | `?brain=<brain-in-other-estate-via-direct-brain-membership>`            | 200 |
| **`service_key, non-brain-bound, repo principal homed in agent-estate, NO brain-membership to sibling brain` (NEW Finding 1 closure)** | **`?brain=<sibling-repo-brain-in-agent-estate-no-membership>`**         | **404** |
| **same auth, same scenario**                                                  | **body `brain=<sibling-repo-brain-slug>` on `/admin/thought/metadata`**  | **404 (slug not in lookup scope)** |
| **`service_key, non-brain-bound, repo principal homed in agent-estate, with brain-membership to common-brain`** | **`?brain=common-brain`**                                              | **200** |
| any non-legacy                                                                | `?brain=<typo>` (slug resolves nowhere in scope)                        | 404 |
| any non-legacy                                                                | slug matches multiple in lookup scope                                   | 409 |

The three **NEW** rows are the canonical Finding 1 closure tests. A
repo principal homed in the agent estate with NO membership row to
a sibling repo brain gets 404 (not 403) on slug — because the slug
isn't in lookup scope. The same principal with a brain-membership
row to common-brain gets 200 — because that explicit grant puts
common-brain in scope.

**Acceptance — L4 helpers (per D6, unchanged from v10).**

**Acceptance — `/admin/thought/access-check` endpoint:**

| endpoint input                                                          | expected |
|-------------------------------------------------------------------------|----------|
| `?target_brain=<slug-in-lookup-scope, accessible>`                      | 200 |
| `?target_brain=<slug-in-lookup-scope, NOT accessible>` (e.g., brain-deny) | 403 |
| `?target_brain=<slug-not-in-lookup-scope>`                              | 404 |
| `?target_brain=<slug-of-cross-estate-direct-brain-membership>`          | 200 |
| **`?target_brain=<sibling-repo-brain-slug, no membership>` (NEW)**      | **404** |
| `?target_brain=<UUID-of-accessible-brain>`                              | 200 |
| `?target_brain=<UUID-of-existing-but-inaccessible-brain>`               | 403 |
| `?target_brain=<UUID-not-in-brains>`                                    | 404 |
| no `?target_brain=`                                                     | 400 |
| no auth                                                                 | 401 |

Note: the UUID path still discloses 403 for inaccessible-but-
existent brains. UUIDs are opaque; the principal had to obtain the
UUID from somewhere (a prior result, manual configuration). 404 vs
403 on UUIDs is informational, not a confidentiality leak. Slugs
are the human-typeable, guess-prone surface; THAT is where v13
hides existence behind 404.

### Phase 3 — Tool & HTTP surfaces (unchanged from v11/v12)

(Unchanged. L4 runs on every write surface. Finding 1 closure tests
for metadata patch and Finding 2 closure tests for capture path
stay.)

### Phase 4 — Provisioning CLI (unchanged)

### Phase 5 — Per-repo `.envrc` (unchanged)

### Phase 6 — Routing skill (unchanged)

### Phase 7 — Migrate writers (unchanged)

### Phase 8 — Legacy-admin layer hygiene (unchanged)

## Risks and mitigations

(Unchanged from v12, plus:)

- **v13 narrows lookup scope for brain-bound keys: 404 instead of
  today's 403 for typos.** Mitigation: documented as an explicit
  behavior delta in D8. Affects no current caller (no brain-bound
  stored keys exist today). Forward-looking.
- **Visibility-via-explicit-grants is a normative property (D18).**
  Mitigation: stated explicitly. Future schema or auth changes must
  preserve it; the canonical Phase 2 acceptance row enforces it
  per-test.

## Out of scope, tracked separately (unchanged)

## Open questions (unchanged)
