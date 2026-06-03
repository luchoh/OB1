# Review: Agent Estate Implementation Roadmap v8

Date: 2026-06-03
Reviewed doc: `docs/29-agent-estate-implementation-roadmap-v8.md`
Verdict: Closer again. Still reject as written.

## Zoom-Out

- The runtime choke points are still [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:65), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1063), and the accepted product contract in [ADR-0001](/Users/luchoh/Dev/OB1/docs/adr/0001-agent-estate-brain-model.md:75) plus [docs/17](/Users/luchoh/Dev/OB1/docs/17-local-household-multitenancy-prd.md:488).
- v8 did fix the specific v7 seam around `human_token` non-MCP `/admin/thought/metadata`, and it stopped pretending handler-layer assertions belonged in the selector phase.
- The remaining problem is different and nastier: v8 now sneaks in a broader write contract for service keys on metadata patch when `brain` is omitted, and that contract does not match the accepted ADR or the live single-brain runtime.

## Findings

1. **D7 quietly changes omitted-`brain` metadata writes from single-brain to multi-brain for service keys, which contradicts the accepted ADR and the current runtime contract.**

   v8's D7 says that when `/admin/thought/metadata` omits body `brain`, `service_key, is_admin` scopes across every brain in the household, and `service_key, non-brain-bound, non-admin` scopes across `listAccessibleBrainIds({mode:'edit'})` by default [roadmap v8](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v8.md:76). That is not what the accepted design says. ADR-0001 says the default when `brain` is omitted is `principal.default_brain_id`, with only `search_thoughts`, `list_thoughts`, `ask_brain`, and `stats` called out as the multi-brain exception [ADR-0001](/Users/luchoh/Dev/OB1/docs/adr/0001-agent-estate-brain-model.md:80). The multitenancy PRD says the same thing in the service/admin request path: resolve a specific allowed brain only when the path supports explicit override, otherwise use the effective brain for reads and writes [docs/17](/Users/luchoh/Dev/OB1/docs/17-local-household-multitenancy-prd.md:492).

   The live runtime also still behaves like the ADR, not like D7. Stored keys resolve one `effectiveBrainId` from requested brain, bound brain, or default brain [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:312). `/admin/thought/metadata` then patches exactly that one brain by passing `accessContext.effectiveBrainId` into `updateThoughtMetadata()` [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1085). v8 therefore is not just filling in an implementation detail. It is changing the omitted-`brain` write contract on an edit endpoint from "default brain unless explicitly overridden" to "search all editable brains for the UUID." That is an ADR-level semantic change, and the doc never admits it as one.

   Rewrite gate: either keep omitted `brain` on `/admin/thought/metadata` aligned with the accepted contract and require explicit `brain` for all cross-brain edits, or amend ADR-0001 and `docs/17` first and call out the back-compat change plainly. Right now the roadmap says "derived from accepted ADR-0001" while doing something else.

2. **Phase 2b still understates the auth-context rewrite needed for estate-aware selectors.**

   v8 says Phase 2b is "selector-only" inside `resolveAccessContext()`, and explicitly says it does not touch route handlers [roadmap v8](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v8.md:170). That part is fine. The problem is that its own acceptance still expects a stored-key principal with estate-only access to resolve a slug successfully [roadmap v8](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v8.md:191). The live auth path cannot do that today. `loadPrincipalMemberships()` only loads `brain_memberships`, not `estate_memberships` [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:65). `resolveHumanAccessContext()` rejects a requested brain unless it is present in those brain memberships [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:200), and `resolveStoredAccessKeyContext()` does the same for stored keys [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:291).

   So the acceptance case cannot pass just by normalizing selectors. Phase 2b also has to change how auth-context resolution loads memberships or where requested-brain authorization happens, otherwise estate-only principals still die before D6/D8 helper logic ever gets a vote. This is not a route-handler problem, but it is more than the four bullets v8 currently lists.

   Rewrite gate: Phase 2b needs to say explicitly that `resolveHumanAccessContext()` and `resolveStoredAccessKeyContext()` stop doing brain-membership-only requested-brain authorization, or that they become estate-aware. Without that, the phase description is still too small for its own acceptance criteria.

## Recommendation

Do not implement v8 as written.

Minimum rewrite before coding:

- Put `/admin/thought/metadata` back on the accepted omitted-`brain` contract: default brain unless the caller explicitly sets `brain`. If you want UUID-based multi-brain patch for agents, treat that as an ADR change, not a stealth default.
- Expand Phase 2b so it explicitly rewires auth-context resolution for estate-aware requested-brain lookup, instead of describing the phase as pure selector normalization.
