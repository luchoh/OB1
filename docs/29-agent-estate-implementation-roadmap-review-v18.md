# Review: Agent Estate Implementation Roadmap v18

Date: 2026-06-03
Reviewed doc: `docs/29-agent-estate-implementation-roadmap-v18.md`
Verdict: Best version so far. Still reject as written.

## Zoom-Out

- The live runtime is still organized around one request-scoped `accessContext.effectiveBrainId`, resolved up front in [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:367) and selected from route/query/header inputs in [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:378).
- MCP and HTTP read surfaces then just consume that already-resolved brain. The read handlers for `search_thoughts`, `ask_brain`, `similar`, `list_thoughts`, and `stats` all execute against `accessContext.effectiveBrainId` in [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:369), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:450), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:672), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:697), and [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:709).
- So the roadmap only works if it keeps two layers separate: selector admissibility first, access/scope second. v18 fixes the human-token MCP mix-up, but it still blurs those layers again for legacy-admin. It also still under-specifies the runtime plumbing needed to make tool/body `brain` real.

## Findings

1. **v18 swaps the human-token contradiction for a legacy-admin contradiction.**

   D2 says MCP tools freely admit tool-arg `brain` for `legacy-admin`, and non-MCP HTTP admits body `brain` for all auth sources in [roadmap v18](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v18.md:60) and [roadmap v18](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v18.md:67). D19 then says the opposite for legacy-admin: when any selector is set, body/tool-arg `brain` is ignored and D6 case 1 governs in [roadmap v18](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v18.md:137). Phase 3 then adds mismatch-`400` rows for legacy-admin on both MCP `search_thoughts` and HTTP `/ask` in [roadmap v18](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v18.md:172) and [roadmap v18](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v18.md:242).

   Those are three different contracts for the same selector:

   - admitted selector
   - ignored selector
   - malformed selector that returns `400`

   They cannot all be true at once.

   The only prior explicit legacy-admin mismatch-`400` rule I found is the metadata-patch sub-rule in D7, where body `brain` must match the effective brain on `/admin/thought/metadata`, in [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:230) and [roadmap v10](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v10.md:119). D6 case 1 itself is only ALLOW/DENY against `effectiveBrainForLegacyAdmin`, not a general read-path `400`, in [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:177) and [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:183).

   Result: two implementers can follow v18 and ship opposite behavior for the same legacy-admin read request. One will treat `brain` as a real selector. Another will ignore it. A third will reject mismatches at `400`. The doc backs all three. That is still a reject.

## Secondary Gaps

- **Phase 3 still does not name the selector-plumbing work the runtime actually needs.** The MCP read tool schemas do not currently expose a `brain` field in [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:41), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:50), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:55), or [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:92). The MCP registrations and HTTP routes just parse those shapes and dispatch in [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:895) and [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1074). The handlers still read only `accessContext.effectiveBrainId` in [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:369), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:450), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:672), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:697), and [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:709). Meanwhile `resolveAccessContext` only consumes route/query/header selectors in [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:367) and [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:378). v18's acceptance matrix assumes all of that plumbing appears, but the roadmap never names it explicitly.
- **`/admin/thought/similar` still rides on "identical to `/ask`" prose after v18 claimed that shortcut was gone.** The preamble promises concrete rows per tool and "No `identical to` prose" in [roadmap v18](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v18.md:43). Then the non-MCP section punts `/admin/thought/similar` to mirrored `/ask` rows in [roadmap v18](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v18.md:253). Smaller blast radius than v17. Same habit.

## Recommendation

Do not implement v18 as written.

Minimum rewrite before coding:

- Pick one legacy-admin rule and state it once: body/tool-arg `brain` is a real selector for read routes, or it is ignored outside the metadata patch route, or mismatches are a new explicit cross-route `400` rule.
- Add explicit Phase 3 plumbing tasks for selector support: extend MCP/body schemas with optional `brain`, define where slug/UUID resolution runs for tool/body selectors, and explain how read handlers escape the current single-`effectiveBrainId` model.
- Replace the `/admin/thought/similar` shortcut sentence with its own concrete acceptance rows.
