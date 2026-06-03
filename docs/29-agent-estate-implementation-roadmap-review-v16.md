# Review: Agent Estate Implementation Roadmap v16

Date: 2026-06-03
Reviewed doc: `docs/29-agent-estate-implementation-roadmap-v16.md`
Verdict: Best version so far. Still reject as written.

## Zoom-Out

- The real policy choke points are still split across two layers. Slug-resolution and auth-source binding live in [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:159). Body-`brain` handling for non-MCP HTTP lives in the handlers that still write and read against `accessContext.effectiveBrainId` in [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:312), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:426), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:663), and [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1085).
- v16 fixed the two v15 review points. It now names handler-layer migration sites and scopes D18's 403/404 language correctly to slug/read visibility in [roadmap v16](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v16.md:90) and [roadmap v16](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v16.md:126).
- The remaining problem is nastier because it is new: the fresh human-token Phase 3 matrix now contradicts D12's estate-write rule.

## Findings

1. **Phase 3 newly grants `human_token` estate-only capture write, which conflicts with D12's read-only estate-member rule and with the earlier capture closure tests.**

   v16 keeps D12 unchanged: `estate_membership role='member'` is still read-only in [roadmap v16](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v16.md:120). The inherited D12 decision is explicit: write and edit through estate-membership require `role='admin'`, while plain estate-member must not silently inherit write rights in [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:308).

   But the new human-token non-MCP HTTP matrix says `human_token`, estate-only access, `POST /ingest/thought` with body `brain="<brain-in-membership-estate>"` returns `200` in [roadmap v16](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v16.md:227). Its rationale is only "D8 lookup includes estateBrains," which speaks to lookup visibility, not write authorization. The very next row says the same estate-only setup on metadata edit returns `403` unless the caller is estate-admin in [roadmap v16](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v16.md:228).

   That is internally inconsistent. Under D12, plain estate-member is read-only. If estate-only means estate-member, `/ingest/thought` should be `403`, not `200`. If estate-only secretly means estate-admin, the row is mislabeled and the rationale is wrong. The earlier capture closure tests already locked the conservative rule in place: capture with estate-member-only access must deny in [roadmap v11](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v11.md:294).

   Rewrite gate: split the row into estate-admin vs estate-member, or change the expected status to `403`. As written, v16 weakens D12 by accident.

## Secondary Gaps

- **The read-handler migration is still not fully executable.** D8 now says `handleAskBrain`, `handleSimilarThoughtLookup`, `handleSearchThoughts`, `handleListThoughts`, and `handleStats` must change in [roadmap v16](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v16.md:98), but Phase 3 still labels the read path and `stats` as unchanged in [roadmap v16](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v16.md:190). The current runtime still routes those handlers through `accessContext.effectiveBrainId` in [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:450), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:672), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:697), and [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:709). There are still no explicit Phase 3 acceptance rows for `/ask`, `/admin/thought/similar`, `search_thoughts`, `list_thoughts`, or `stats` body/default behavior.

- **v16 quietly introduces auth-source-dependent retrieval defaults without reconciling its companion docs.** The new handler-layer note says `search_thoughts`, `list_thoughts`, and `stats` default multi-brain for non-human service callers but single-brain for `human_token` in [roadmap v16](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v16.md:100). That may be defensible, but it is not neutral: ADR-0001 still says those surfaces default to all accessible brains in [ADR-0001](/Users/luchoh/Dev/OB1/docs/adr/0001-agent-estate-brain-model.md:84), while `docs/17` says default retrieval never crosses brain boundaries and prefers one default brain per user with explicit override in [docs/17](/Users/luchoh/Dev/OB1/docs/17-local-household-multitenancy-prd.md:556) and [docs/17](/Users/luchoh/Dev/OB1/docs/17-local-household-multitenancy-prd.md:744). If v16 intends an auth-source split, say so explicitly instead of burying it in one handler bullet.

## Recommendation

Do not implement v16 as written.

Minimum rewrite before coding:

- Fix the new human-token `estate-only access` capture row. Estate-member write should stay `403`; estate-admin can be a separate `200` row.
- Add explicit Phase 3 acceptance for the read handlers that v16 now names as migration sites: `/ask`, `/admin/thought/similar`, `search_thoughts`, `list_thoughts`, and `stats`.
- State the intended default-retrieval policy by auth source plainly, and reconcile it against ADR-0001 point 11 and `docs/17` instead of leaving the reader to infer which contract wins.
