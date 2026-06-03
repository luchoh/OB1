# Review: Agent Estate Implementation Roadmap v11

Date: 2026-06-03
Reviewed doc: `docs/29-agent-estate-implementation-roadmap-v11.md`
Verdict: Best version so far. Still reject as written.

## Zoom-Out

- The live choke points are still [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:227) and [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:312). `auth.mjs` is where slug selection is interpreted, and the handlers still write against one resolved target brain.
- v11 did fix the explicit v10 bug. D8 now picks one slug-selector status contract, and Phase 3 finally adds a capture-path closure test instead of only testing metadata.
- The remaining problem is in the new D8 itself: its slug lookup scope is not actually a superset of accessible brains. It drops the ADR's cross-estate **brain-membership-only** case.

## Findings

1. **D8's new lookup scope excludes cross-estate brains granted by direct `brain_memberships`, so an accessible brain can 404 by slug and 200 by UUID.**

   v11 says that for non-admin non-brain-bound principals and `human_token`, slug lookup scope is: every brain in the principal's home estate plus every brain in estates where the principal has `estate_memberships` [roadmap v11](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v11.md:90). It even labels that "lookup union" a **superset of accessible** [roadmap v11](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v11.md:90). That is false against the accepted ADR. ADR-0001 says there are two grant mechanisms: estate-level membership and brain-level membership [ADR-0001](/Users/luchoh/Dev/OB1/docs/adr/0001-agent-estate-brain-model.md:42). It also explicitly says a brain can be shared to principals in **other estates** by granting brain-membership rows while the brain itself stays in one estate [ADR-0001](/Users/luchoh/Dev/OB1/docs/adr/0001-agent-estate-brain-model.md:48).

   Under v11 D8, a principal who has direct `brain_membership` to a brain in another estate but no `estate_membership` there is missing from the slug lookup scope. So `resolveBrainSlug()` step 1 returns 404 because the slug is "not in lookup scope" [roadmap v11](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v11.md:114). But `resolveBrainUuid()` for the same brain would succeed, because UUID resolution checks existence in `brains`, then runs `checkBrainAccess({mode:'read'})` [roadmap v11](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v11.md:125). If the principal really has direct brain-membership, that read check allows. Same accessible brain. Slug path 404. UUID path 200.

   That breaks the design contract in two places. First, ADR-0001 point 9 says the `brain` parameter on the wire is how the principal selects an accessible brain, with the server validating membership before acting [ADR-0001](/Users/luchoh/Dev/OB1/docs/adr/0001-agent-estate-brain-model.md:75). Second, the repo's own common-brain pattern is brain-membership-driven, not estate-membership-driven: the common brain lives in the agent estate, and repo principals are granted direct brain memberships to it [CONTEXT.md](/Users/luchoh/Dev/OB1/CONTEXT.md:57). v7 also states repo principals do **not** need estate-membership rows in the agent estate; they get cross-repo visibility via `brain_memberships` only [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:563). If any such principal is homed outside the agent estate, v11 D8 turns the shared brain into "UUID works, slug 404s."

   Rewrite gate: non-admin/human slug lookup scope must include directly granted `brainMemberships`, even when those brains live outside the principal's home estate and outside estates where they hold `estate_memberships`. Otherwise D8 still does not implement the ADR's permission model.

## Secondary Gaps

- **Phase 2 acceptance still misses the failing case.** v11 adds rows for estate-only and brain-deny slug selection [roadmap v11](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v11.md:214), but it never tests `?brain=<cross-estate-brain-with-direct-brain-membership-only>` -> `200`. That is the exact case D8 now mishandles. Add one slug-selector row and one body-`brain` row for a cross-estate direct brain-membership without estate-membership.

## Recommendation

Do not implement v11 as written.

Minimum rewrite before coding:

- Expand D8's non-admin/human slug lookup scope to include explicit `brainMemberships`, not just home-estate brains plus estate-membership estates.
- Add acceptance coverage for the direct-brain-membership cross-estate case, proving slug and UUID selection both work for the same accessible brain.
