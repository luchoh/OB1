# Review: Agent Estate Implementation Roadmap v12

Date: 2026-06-03
Reviewed doc: `docs/29-agent-estate-implementation-roadmap-v12.md`
Verdict: Best version so far. Still reject as written.

## Zoom-Out

- The live choke points are still [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:227) and the route handlers that act on one resolved target brain. v12 finally fixed the obvious cross-estate direct-grant slug bug from v11.
- The remaining issue is narrower and nastier: v12's new D8 treats "home estate" as always safe to expose at slug-lookup time, but its own canonical repo-principal setup makes that assumption dubious.
- In plain English: v12 fixed "UUID works, slug 404s" for direct cross-estate grants, but it may now overshoot and reintroduce cross-repo brain visibility inside the agent estate through 403-based slug probing.

## Findings

1. **D8 still conflicts with the repo-principal visibility model: canonical repo principals homed in the agent estate can now slug-probe other repo brains there without direct brain-membership.**

   v12's D8 says non-admin non-brain-bound principals get slug lookup across their entire home estate, plus estate-membership estates, plus directly granted brain-memberships [roadmap v12](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v12.md:54). It justifies that by saying the home estate is "always knowable to the principal," and therefore a principal with no relationship to a brain cannot probe it only when the brain is outside that lookup scope [roadmap v12](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v12.md:70). The problem is that v12 also says the canonical repo-principal setup homes repo principals in the agent estate [roadmap v12](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v12.md:211).

   That collides with the earlier repo-principal contract. v7's provisioning section says repo principals do **not** get estate-membership in the agent estate, and that their cross-repo visibility comes from direct `brain_memberships` only, not estate-membership [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:562). It even makes "repo principal cannot read brains in agent estate that they don't have a `brain_memberships` row for" an acceptance point [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:574). CONTEXT uses the same model for the common brain: it is in the agent estate, and repo principals reach it through explicit brain memberships [CONTEXT.md](/Users/luchoh/Dev/OB1/CONTEXT.md:57).

   Under v12 D8, a repo principal homed in the agent estate can probe any other repo brain slug in that estate. The slug is inside lookup scope because the whole home estate is in scope. The subsequent access check may deny and return 403, but the existence of the brain is no longer hidden behind direct brain-membership. That is hard to square with "cross-repo visibility via brain-membership only." The roadmap is now mixing two different policies:

   - D8 policy: same-home-estate brains are fair game for slug-level existence disclosure.
   - v7 provisioning policy: repo-principal cross-repo visibility is granted by direct brain-membership, not by broad estate-level context.

   The original household PRD is not enough to rescue this, because its `403 if slug exists in the household` rule was written for household humans [docs/17](/Users/luchoh/Dev/OB1/docs/17-local-household-multitenancy-prd.md:565). v12 is applying the same idea to an agent-estate topology where principals are intentionally *not* given estate-level visibility.

   Rewrite gate: v12 needs to choose explicitly whether repo principals homed in the agent estate may discover other repo-brain slugs there via 403. If yes, say so plainly and admit that slug-level visibility is broader than brain-membership visibility. If no, the non-admin home-estate part of D8 lookup scope is too broad for the canonical repo-principal setup and must be narrowed.

## Secondary Gaps

- **Phase 2 still does not test the canonical same-agent-estate non-member case.** v12 adds the direct cross-estate brain-membership row [roadmap v12](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v12.md:182), but it still has no row for `service_key, non-brain-bound, repo principal homed in agent-estate, ?brain=<other-repo-brain-in-agent-estate-with-no-brain_membership>`. That is exactly the policy fork above. Add the row and pick the expected status code. Right now the doc implies `403`, while the older "visibility via brain-membership only" language implies `404`.

## Recommendation

Do not implement v12 as written.

Minimum rewrite before coding:

- Decide the same-agent-estate slug-visibility rule for repo principals. The doc currently implies broad lookup visibility through home-estate scope while older provisioning language implies brain-membership-only visibility.
- Add an explicit Phase 2 acceptance row for that case so the policy is executable instead of rhetorical.
