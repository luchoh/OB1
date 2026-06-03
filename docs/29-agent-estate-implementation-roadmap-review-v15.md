# Review: Agent Estate Implementation Roadmap v15

Date: 2026-06-03
Reviewed doc: `docs/29-agent-estate-implementation-roadmap-v15.md`
Verdict: Closest version so far. Still reject as written.

## Zoom-Out

- The tenancy policy still lands in two layers, not one. Route-scoped slug selection lives in the access-context resolvers in [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:159) and [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:241). Body-`brain` selection for non-MCP HTTP lives in the handler layer that currently writes and patches against `accessContext.effectiveBrainId` in [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:312) and [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1085).
- v15 did close the last two v14 issues. It now names `resolveHumanAccessContext(...)` as a migration site and fixes the orphan-deny wording in [roadmap v15](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v15.md:135) and [roadmap v15](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v15.md:176).
- The remaining problem is narrower: the new human-token contract is now executable for MCP route selection, but still not executable enough for the non-MCP HTTP body-`brain` path that D9 explicitly preserves.

## Findings

1. **v15 still under-specifies the human-token non-MCP HTTP body-`brain` path, so the repo can pass the new human route tests while leaving the real L3 human path inconsistent.**

   D9's inherited rule is not optional. For human-token on non-MCP HTTP, query/header selectors are forbidden and body `brain` is the selection mechanism in [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:152). That means the human-token behavior change is not confined to `POST /mcp/brains/:brain_slug`; it also has to show up in `/ingest/thought`, `/admin/thought/metadata`, and the other non-MCP body-driven surfaces.

   v15's new human coverage is still route-centric. The added human rows in Phase 2 are all MCP-route cases in [roadmap v15](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v15.md:214). The migration section likewise focuses on changing the access-context resolvers in [roadmap v15](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v15.md:137) and [roadmap v15](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v15.md:245).

   But the current runtime still proves why Phase 3 matters. Capture writes use `accessContext.effectiveBrainId` in [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:345), and metadata patch uses the same effective brain in [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1089). Those are exactly the call sites that must change for L3 body-`brain` handling to obey the new human-token visibility rules.

   v15 leaves Phase 3 inherited and only says it includes the old metadata/capture closure tests in [roadmap v15](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v15.md:265). Those inherited tests are still service-key-centric in [roadmap v11](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v11.md:285). So a coder can update `resolveHumanAccessContext(...)`, pass every new v15 human test, and still miss the non-MCP human body-`brain` cases entirely.

   Rewrite gate: add explicit human-token non-MCP HTTP acceptance rows for body `brain`, at minimum:

   - `/ingest/thought` or `/admin/thought/metadata` with body `brain=<same-household-no-grant>` -> `404`
   - same surfaces with body `brain=<denied-via-estate-allow>` -> `403`
   - body `brain=<typo-not-in-scope>` -> `404`

## Secondary Gaps

- **D18 now overstates what `403` means across the whole roadmap.** It says `403` means a principal has an allow path but a brain-deny row blocks access, reachable only via estate-allow plus brain-deny in [roadmap v15](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v15.md:193). That is true for slug/read visibility, but Phase 3 still preserves `403` cases caused by mode/role denial without any deny row at all, such as metadata edit with read-only access in [roadmap v11](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v11.md:285) and estate-member write/edit denial in [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:446). Scope D18 back to slug/read resolution or the document will teach the wrong invariant again.

## Recommendation

Do not implement v15 as written.

Minimum rewrite before coding:

- Add explicit human-token non-MCP HTTP body-`brain` acceptance rows in Phase 3, not just MCP route rows in Phase 2.
- In the migration narrative, call out the handler-layer work directly, not only the access-context resolvers. The runtime write surfaces in [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:312) and [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1085) are part of the human-token behavior change.
- Narrow D18's `403` language to slug/read visibility, or explicitly acknowledge that write/edit can also return `403` for role-based mode denial without any brain-deny row.
