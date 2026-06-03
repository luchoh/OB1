# Review: Agent Estate Implementation Roadmap v17

Date: 2026-06-03
Reviewed doc: `docs/29-agent-estate-implementation-roadmap-v17.md`
Verdict: Best version so far. Still reject as written.

## Zoom-Out

- The real decision boundary in this roadmap is still the split between **selector admissibility** and **brain visibility/access**. D2/D9 govern which selector sources are even legal for a given auth source. D8/D18 govern what happens after a selector is admitted.
- The live choke points reflect that split. Auth-source binding and route/query/header selection live in [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:159). Handler-layer body-`brain` behavior lives in the read/write handlers in [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:312), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:426), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:663), and [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1085).
- v17 fixed the v16 write-side contradiction and finally promoted retrieval defaults into a first-class decision. The remaining issue is that D19 now blurs the selector/access split again for human-token MCP reads.

## Findings

1. **D19 reintroduces a human-token MCP selector contradiction: it says explicit `brain` on read tools always wins, while D9 still says human-token MCP selection is route-only and must 400 on tool-arg-only or mismatch.**

   v17 keeps D2 and D9 unchanged in [roadmap v17](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v17.md:44) and [roadmap v17](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v17.md:58). The older D9 contract is explicit: for human-token on MCP routes, route-form L1 is the selector; body/tool-arg `brain` must match `requestBrain`, and tool-arg-only without route L1 is a `400` in [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:157) and [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:283).

   D19 then says the opposite at the read layer. It says explicit `brain` on read tools "always wins" in [roadmap v17](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v17.md:123). It also merges `search_thoughts` (MCP) and `/admin/thought/similar` (HTTP) into one table where `any` caller with body `brain="<accessible>"` resolves explicitly and body `brain="<inaccessible>"` returns `403` in [roadmap v17](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v17.md:165). The concrete rows double down with `any, search_thoughts body brain="<inaccessible>" -> 403` and `body brain="<typo>" -> 404` in [roadmap v17](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v17.md:198).

   Those cannot both be true for `human_token` on MCP:

   - Under D9, `search_thoughts` with tool-arg/body `brain` but no route brain is a selector error: `400`.
   - Under D19's read table, the same shape becomes an authorization/existence result: `403` or `404`.

   That is not just sloppy wording. It changes the failure class from "illegal selector source for this auth/route" to "legal selector source, then auth/lookup decision." v17 has collapsed two layers that were previously kept separate for a reason.

   Rewrite gate: D19 needs to scope explicit-`brain` override by auth source and route. For `human_token` MCP, explicit tool/body `brain` must only mirror the route brain; mismatch or tool-arg-only stays `400`. For non-MCP HTTP, body `brain` can stay the selector. Right now the doc mixes those two worlds and asks implementers to guess.

## Secondary Gaps

- **Phase 3 still claims each read tool gets explicit acceptance, but the concrete rows remain partial.** D19 says "Each read tool gets explicit acceptance rows" in [roadmap v17](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v17.md:162), but the concrete table only names `search_thoughts`, `/ask`, and `stats` in [roadmap v17](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v17.md:190). `list_thoughts`, `ask_brain` MCP, and `/admin/thought/similar` still ride on "identical" prose. That is exactly where the selector split above matters most, because MCP and non-MCP routes do not admit the same selector sources for human-token.

## Recommendation

Do not implement v17 as written.

Minimum rewrite before coding:

- Separate selector admissibility from read visibility again. D19 should not say explicit `brain` "always wins" without the D9 route/auth-source carve-outs.
- Split the combined `search_thoughts`/`/admin/thought/similar` tables by route family, or at least add explicit human-token MCP rows for:
  - tool/body `brain` with no route brain -> `400`
  - tool/body `brain` mismatching route brain -> `400`
- Add concrete read-handler acceptance rows for `list_thoughts`, `ask_brain`, and `/admin/thought/similar` instead of relying on "identical rules" prose.
