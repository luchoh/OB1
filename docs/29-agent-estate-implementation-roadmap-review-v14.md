# Review: Agent Estate Implementation Roadmap v14

Date: 2026-06-03
Reviewed doc: `docs/29-agent-estate-implementation-roadmap-v14.md`
Verdict: Best version so far. Still reject as written.

## Zoom-Out

- The real choke point is still the access-context layer. Every brain-scoped surface hangs off `resolveAccessContext(...)`, so the lookup/access policy only matters if both the stored-key path and the human-token path are migrated consistently in [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:159).
- v14 did fix the v13 contradiction. It now picks one coherent rule: no implicit home-estate visibility, `lookupScope(P) ⊇ accessibleSet(P)`, and the only slug-visible-but-denied case is deny override of an explicit allow path in [roadmap v14](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v14.md:66) and [roadmap v14](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v14.md:187).
- The remaining risk is narrower: the doc rewrites the human-token contract, but the executable acceptance and migration notes still lean heavily toward the stored-key branch. That is exactly how the old human behavior survives by accident.

## Findings

1. **The human-token behavior change is still not encoded tightly enough, so v14 can be implemented “correctly” for service keys while leaving the live human path on the old household-wide 403 model.**

   v14 explicitly changes human-token semantics. D18 says `docs/17`'s household-wide slug rule is superseded, and for `human_token` the new rule is explicit-grants-only: same-household-with-no-grant should now be `404`, while `403` is reserved for deny override of an allow path in [roadmap v14](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v14.md:221). That is a real behavior change, not a wording tweak.

   But the acceptance matrix barely exercises it. The only human-token rows in Phase 2 are "`?brain=ob1` -> 400" and happy-path "`POST /mcp/brains/ob1` (brain-membership) -> 200" in [roadmap v14](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v14.md:254). There is still no explicit human-token route test for:

   - `/mcp/brains/<same-household-brain-with-no-explicit-grant>` -> `404`
   - `/mcp/brains/<brain-denied-via-brain_membership-but-reached-via-estate_membership>` -> `403`

   The migration note has the same blind spot. Its concrete code-level delta still points at the stored-key branch (`auth.mjs:286-310`) and talks about stored-key lookup behavior in [roadmap v14](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v14.md:146). Meanwhile the live human path still does the old thing today: household-wide slug resolution first, then `403` on membership miss in [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:200).

   That gap matters because the human route is the one `docs/17` originally specified, and v14 is expressly superseding it. If the roadmap does not add explicit human negative-path acceptance and call out `resolveHumanAccessContext(...)` as a migration target, the new human contract is still too easy to miss.

## Secondary Gaps

- **D18's “404 means never granted” rationale still assumes deny rows only exist as live overrides, but the roadmap never states or enforces that invariant.** v14 justifies `403` for `brain-deny + estate-allow` by saying `404` would hide an affirmative deny in [roadmap v14](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v14.md:202). But Phase 1 is still only “add `brain_memberships.is_deny` + indexes” in [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:405), and the underlying table shape still allows a single standalone deny row per `(principal, brain)` in [005_household_multitenancy.sql](/Users/luchoh/Dev/OB1/local/open-brain-mcp/migrations/005_household_multitenancy.sql:54). In that state, v14 would return `404` even though there was an affirmative deny row, so “404 means never granted” is too strong. Either say standalone deny rows are invalid and must be cleaned up when estate access disappears, or narrow the wording to “404 means no current allow path.”

## Recommendation

Do not implement v14 as written.

Minimum rewrite before coding:

- Add explicit `human_token` route acceptance rows for the two negative-path cases that v14 newly defines: same-household/no-grant `404`, and deny-override `403`.
- In D8's migration section, name the human path directly: [resolveHumanAccessContext](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:159) is a required migration site, not just the stored-key branch.
- Tighten the deny-row story. Either forbid orphan deny rows operationally, or stop claiming that `404` means “never granted.”
