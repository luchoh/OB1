# Review: Agent Estate Implementation Roadmap v7

Date: 2026-06-03
Reviewed doc: `docs/29-agent-estate-implementation-roadmap-v7.md`
Verdict: Closest yet. Still reject as written.

## Zoom-Out

- The runtime choke points are still [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:159), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1063), and [config.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/config.mjs:349). `auth.mjs` decides auth source and request-scoped brain binding, `server.mjs` defines which surfaces actually carry a brain selector, and `config.mjs` is still where legacy-admin privilege enters from env.
- v7 fixed the two dumbest v6 mistakes. It now admits legacy-admin is `config.accessKey`-driven rather than `brain_access_keys`-driven [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:328), and it finally closes estate-member write/edit by making estate `member` read-only and estate `admin` the only cross-brain writer [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:302).
- What is left is not a broad direction problem. It is a seam problem between the roadmap's own L3/L4 contract for a human principal on non-MCP HTTP and the metadata-patch rule that still widens the operation back out across every editable brain in the estate.

## Findings

1. **D7 and D9 still disagree on what a no-body `human_token` metadata patch means on non-MCP HTTP.**

   D9 says the rule plainly: for `human_token` on non-MCP HTTP, body `brain` is the explicit override path, and if body `brain` is unset, the request scopes to `principal.default_brain_id` [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:262). D7 then reopens the wound. For "other branches" including `human_token`, `/admin/thought/metadata` with no body `brain` uses `listAccessibleBrainIds({mode:'edit'})` and patches `id = $1 AND brain_id = ANY($2)` [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:239). Under D6, that edit set can include every brain where the principal has brain-level `owner` or `editor`, plus any estate where they are estate-`admin` [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:211).

   Those two rules are not compatible. D9 says "no body `brain`" on non-MCP HTTP human traffic means default-brain-only. D7 says the same omission on `/admin/thought/metadata` means "any editable brain is fair game." Same auth source. Same route family. Opposite default.

   This is not academic. The live server still has no brain-qualified non-MCP route and currently feeds `/admin/thought/metadata` a single `effectiveBrainId` from `resolveAccessContext()` [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1085), while `resolveHumanAccessContext()` only binds humans from route slug or default brain at auth time [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:159). So implementation will have to pick which sentence in v7 to violate. The current Phase 2c acceptance does not catch it either; it only tests human metadata patching when body `brain` is explicitly set [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:551).

   Rewrite gate: if D9 is canon, then D7 must special-case `human_token` on non-MCP HTTP so `/admin/thought/metadata` without body `brain` scopes to `principal.default_brain_id`, not `listAccessibleBrainIds({mode:'edit'})`. If D7 is canon instead, D9 must stop claiming default-brain-only behavior on that route. Right now the doc promises both.

## Secondary Gaps

- **Phase 2b acceptance already depends on Phase 2c handler work, so the phase boundary is still fake.** Phase 2b is described as selector unification inside `resolveAccessContext()` [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:477). But its acceptance already asserts non-MCP HTTP `/ingest/thought` body-`brain` behavior and route-specific edit enforcement on `/admin/thought/metadata` [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:495). Those are not selector-only checks. In the live server, non-MCP routes parse request bodies in the route handlers, and `/admin/thought/metadata` still ignores body `brain` entirely by passing only `accessContext.effectiveBrainId` into `updateThoughtMetadata()` [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1063), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1089). If the phases are meant to be independently landable, those acceptance cases belong in Phase 2c.

## Recommendation

Do not implement v7 as written.

Minimum rewrite before coding:

- Pick one default rule for `human_token` non-MCP `/admin/thought/metadata` when body `brain` is omitted. D7 and D9 cannot both survive.
- Add an explicit acceptance case for that seam: human-token metadata patch with no body `brain` must prove either default-brain-only or multi-editable-brain behavior, whichever rule you actually want.
- Move the body-`brain` handler assertions out of Phase 2b into Phase 2c, or rename Phase 2b so it stops pretending to be selector-only.
