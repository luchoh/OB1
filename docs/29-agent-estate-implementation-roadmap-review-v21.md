# Review: Agent Estate Implementation Roadmap v21

Date: 2026-06-03
Reviewed doc: `docs/29-agent-estate-implementation-roadmap-v21.md`
Verdict: Best version so far. Still reject as written.

## Zoom-Out

- The live runtime still resolves selector plus access together inside `resolveHumanAccessContext` and `resolveStoredAccessKeyContext`, then hands handlers one `accessContext.effectiveBrainId` in [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:200) and [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:291). Handlers and MCP tools then just consume that bound brain in [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:889) and [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1063).
- v21 improves the roadmap materially. It fixes the v20 legacy-admin `400` bug by splitting D8 into normalize-only vs lookup-plus-access, and it finally inlines the Phase 2 acceptance instead of punting to older versions.
- The remaining failure is now one layer up: the doc says D19 is the only canonical pipeline and that access checks happen at Step 7, but Phase 2 still encodes the old “resolver denies early” behavior. So the pipeline is cleaner on paper than it is in the actual contract.

## Findings

1. **v21 still contradicts itself about where non-legacy access denial happens: D19 says access starts at Step 7, but Phase 2 still expects `403` during selector/auth-context resolution.**

   D8 now says `normalizeBrainSelector` is lookup-only with **no access check** in [roadmap v21](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v21.md:150). D19 doubles down: Step 3 is normalize-only, and the first L4 access check happens at Step 7 in [roadmap v21](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v21.md:231) and [roadmap v21](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v21.md:252). It even says this ordering is the **only** place the pipeline is specified in [roadmap v21](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v21.md:216).

   Phase 2 then reintroduces the old behavior. The implementation order still routes brain selection through `resolveStoredAccessKeyContext` / `resolveHumanAccessContext` in [roadmap v21](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v21.md:323). And the inlined Phase 2 acceptance explicitly expects access-deny `403` at that stage, for example `service_key, non-brain-bound, brain-deny + estate-allow ?brain=<denied-slug> -> 403` in [roadmap v21](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v21.md:355).

   Those two stories do not coexist cleanly:

   - If D19 is really the only pipeline, selector/auth-context resolution can normalize and bind context, but it cannot emit that `403`; Step 7 has not happened yet.
   - If Phase 2's `403` row is authoritative, then auth-context resolution is still doing access denial before Step 7, which means D19 is not actually the only pipeline.

   This is not hypothetical. The live resolver code still performs that early deny today in [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:209) and [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:308). So v21 is still giving implementers two defensible choices:

   - preserve the current resolver-style early `403`
   - refactor to D19's normalize-first, deny-later flow

   Both can point at the doc. That is still a reject.

## Secondary Gaps

- **D4 still misstates the work scope.** The scope list excludes `/admin/thought/access-check` in [roadmap v21](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v21.md:69), but D15 names it, Phase 2 step 8 adds it, and §2.3 defines its acceptance in [roadmap v21](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v21.md:201) and [roadmap v21](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v21.md:335). Small, but it means the supposedly self-contained scope section is still not fully honest.
- **The non-MCP HTTP acceptance still leaves admitted L1 query/header paths under-specified for service-key and legacy-admin.** D2 admits query and header selectors for both auth sources in [roadmap v21](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v21.md:54), and D19 Step 4 defines canonical-UUID disagreement handling between L1 and L3 in [roadmap v21](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v21.md:236). But `/ask` only covers body-`brain` cases plus human-token query rejection in [roadmap v21](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v21.md:556), and `/admin/thought/similar` just inherits the same row set in [roadmap v21](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v21.md:576). There are no concrete rows for service-key or legacy-admin query/header selectors on those routes, and no rows for query/header vs body disagreement. That is still a test hole right where the selector layer gets tricky.

## Recommendation

Do not implement v21 as written.

Minimum rewrite before coding:

- Make Phase 2 consistent with D19. Either:
  - Phase 2 auth-context acceptance must stop expecting access-deny `403` before Step 7, or
  - D19 must admit an explicit early-deny carve-out in `resolveAccessContext`, and stop claiming it is the only pipeline.
- Put `/admin/thought/access-check` in D4's in-scope list.
- Add concrete `/ask` and `/admin/thought/similar` rows for service-key and legacy-admin query/header selectors, including L1-vs-body mismatch `400` cases.
