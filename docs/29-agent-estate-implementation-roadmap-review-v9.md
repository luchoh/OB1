# Review: Agent Estate Implementation Roadmap v9

Date: 2026-06-03
Reviewed doc: `docs/29-agent-estate-implementation-roadmap-v9.md`
Verdict: Best version so far. Still reject as written.

## Zoom-Out

- The runtime choke points are still [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:65) and [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1085). `auth.mjs` decides which brain becomes request-bound, and `server.mjs` is where metadata patching still turns into one SQL update keyed by `thought_id` and `brain_id`.
- v9 did fix the two v8 findings. It restored the ADR-aligned single-brain default for omitted-`brain` writes [roadmap v9](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v9.md:60), and it finally admits that estate-aware selection requires a real auth-context rewrite, not just selector normalization [roadmap v9](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v9.md:156).
- The remaining bugs are seam bugs again. One is an authorization bypass on the metadata no-body path. The other is that the new estate-aware resolver still forgets the stored `is_admin=true` branch it claims to preserve from D6.

## Findings

1. **`requestedBrain` is authorized at read scope, then reused on the no-body metadata path without an edit check. That lets read-only access become edit access.**

   D17 says auth-context resolution authorizes `requestedBrain` against a combined accessible set built from brain allows plus estate memberships minus brain denies, explicitly using the read-side union [roadmap v9](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v9.md:186), and Phase 2b keeps L1 selectors available for non-human auth sources [roadmap v9](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v9.md:237). The live resolver already reads those selectors from query/header for service keys in `explicitServiceBrainSlug()` [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:227).

   Then `/admin/thought/metadata` splits into two paths. If body `brain` is set, v9 runs `checkBrainAccess({mode:'edit'})` [roadmap v9](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v9.md:75). If body `brain` is not set, v9 just scopes the SQL to `brain_id = $effectiveBrainId` [roadmap v9](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v9.md:83), and the Phase 2c handler description repeats the same thing with no L4 edit check on that branch [roadmap v9](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v9.md:329). But D6's unchanged edit rule is stricter: plain brain `member` and plain estate `member` are not allowed to edit; only brain `owner`/`editor` or estate `admin` may do that [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:211).

   That creates an authorization bypass. A non-brain-bound service key with read-only access to `agent-common` can bind `requestedBrain=agent-common` through query/header, omit body `brain` on `/admin/thought/metadata`, and land on `effectiveBrainId=agent-common` without ever hitting the edit-mode check. The live `updateThoughtMetadata()` function does not have its own permission gate; it just updates `where id = $1 and brain_id = $2` [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:566).

   Rewrite gate: the no-body metadata path must still run `checkBrainAccess({mode:'edit'})` against `effectiveBrainId` before calling `updateThoughtMetadata()`. Otherwise read-authorized `requestedBrain` selection becomes an edit escalation.

2. **D17's new estate-aware requested-brain logic drops the stored `service_key, is_admin=true` carve-out and contradicts D6 plus the live runtime.**

   D17 claims its computed accessible-brain set for slug resolution is the same as `listAccessibleBrainIds({mode:'read'})`, then defines that set as brain-allow rows plus estate-membership rows minus brain denies [roadmap v9](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v9.md:186). It applies that set to `resolveStoredAccessKeyContext()` for requested-brain authorization [roadmap v9](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v9.md:194), and Phase 2b restates the same rule as "brain-memberships UNION estate-memberships, minus brain-deny" [roadmap v9](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v9.md:245).

   That is not actually the same as D6. D6's unchanged `service_key, is_admin=true` branch allows every brain in the household regardless of memberships [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:189), and `listAccessibleBrainIds()` for that branch is explicitly "every brain in `accessContext.householdId`" [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:223). The live runtime matches that behavior by skipping the membership-based requested-brain rejection when `first.is_admin` is true [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:299).

   As written, a stored admin key with no explicit brain or estate memberships could lose L1 brain selection for perfectly valid household brains, because the new D17 set would be empty while D6 and the live code say admin should still be able to target any in-household brain. v9 never adds the missing admin carve-out; it just assumes the new union-set description is enough.

   Rewrite gate: D17 must explicitly preserve the `service_key, is_admin=true` requested-brain rule as household-wide authorization, not membership-union authorization. Otherwise v9 regresses the stored admin path while claiming D6 is unchanged.

## Secondary Gaps

- **Phase 2a is no longer independently landable, but the roadmap still treats it as unchanged.** v9 says Phase 2a helpers operate on the new `brainMemberships` and `estateMemberships` arrays loaded in Phase 2b [roadmap v9](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v9.md:226), then leaves Phase 2a acceptance unchanged [roadmap v9](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v9.md:231). That is not a fatal design bug, but the phasing story is still sloppy. Either merge 2a and 2b, or say outright that 2a's helper API is defined there but cannot pass in the live stack until 2b lands.

## Recommendation

Do not implement v9 as written.

Minimum rewrite before coding:

- Add an explicit `mode='edit'` access check on `/admin/thought/metadata` when body `brain` is omitted and the route is using `effectiveBrainId`.
- Fix D17 so stored `is_admin=true` keys authorize requested brains household-wide, matching D6 and the current runtime.
- Clean up the Phase 2a/2b dependency so the phasing reflects the actual implementation order instead of pretending the helper inputs already exist.
