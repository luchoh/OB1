# Review: Agent Estate Implementation Roadmap v22

Date: 2026-06-03
Reviewed doc: `docs/29-agent-estate-implementation-roadmap-v22.md`
Verdict: Best version so far. Still reject as written.

## Zoom-Out

- The live runtime still resolves selector and access together inside `resolveHumanAccessContext`, `resolveStoredAccessKeyContext`, and `resolveLegacyAdminContext`, then hands handlers one `accessContext.effectiveBrainId` in [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:200), [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:291), and [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:336). Handlers and MCP tools then execute against that bound brain in [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:889) and [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1063).
- v22 improves the v21 draft by explicitly admitting the eager-deny behavior that already exists in `auth.mjs`, and by adding the missing non-MCP query/header rows the prior review asked for.
- The remaining problem is that the new rows are not actually consistent with the canonical legacy-admin rules. v22 fixed the missing table coverage, then used that extra surface area to introduce a wrong contract.

## Findings

1. **v22 breaks legacy-admin L1 semantics on non-MCP HTTP: it says `?brain=<slug-of-other>` on `/ask` is a deny, but D7a and the live resolver say that L1 selector becomes the effective brain and should succeed.**

   D2 admits query and header L1 selectors for `legacy_admin_key` in [roadmap v22](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v22.md:54). D7a then defines `effectiveBrainForLegacyAdmin(accessContext)` as the **L1-resolved brain** if a route/query/header selector is present and admissible in [roadmap v22](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v22.md:116). Current runtime does exactly that: `resolveLegacyAdminContext(requestedBrainSlug)` resolves the requested slug globally and sets `effectiveBrainId` to that requested brain in [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:336).

   But §3.7 now says this for `/ask`:

   - `legacy_admin_key ?brain=<slug-of-default>` -> scope `[default]`
   - `legacy_admin_key ?brain=<slug-of-other>` -> `400`

   in [roadmap v22](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v22.md:161). The rationale is worse than the row: it claims D6 case 1 would DENY, then says "OR equivalently 403; pin to **400** for D7a consistency." Same row, two statuses, neither coherent.

   That DENY cannot happen under the doc's own rules. Once `?brain=<slug-of-other>` is admitted and resolved at L1, that brain **is** `effectiveBrainForLegacyAdmin`. D6 case 1 therefore ALLOWs, not DENYs. D7a does not rescue this, because D7a's mismatch rule is only about **body/tool-arg L3** mirroring the effective brain, not about L1 choosing a non-default brain in the first place in [roadmap v22](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v22.md:120).

   So v22's new fix row is not just under-specified. It is wrong on its face and contradicts both the canonical D7a model and the current resolver implementation. An implementer following §3.7 would break legacy-admin cross-brain selection on non-MCP routes.

## Secondary Gaps

- **`/admin/thought/similar` is still not actually inlined, despite v22 claiming that it is.** §3.8 says concrete rows "MUST be present" and that the section "inlines them rather than referencing §3.7", then immediately says they are omitted for brevity and should be copied verbatim in implementation in [roadmap v22](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v22.md:194). Same old problem, just written more honestly this time.
- **The write-route L1 selector contract is still under-specified.** D2 admits query/header selectors for `service_key` and `legacy_admin_key` generally in [roadmap v22](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v22.md:54), but v22 only expands `/ask` and `/admin/thought/similar`. It explicitly leaves capture, metadata patch, search, list, ask, and stats otherwise unchanged from v21 in [roadmap v22](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v22.md:148). So non-MCP write routes still do not have concrete query/header acceptance rows even though the selector model says those inputs are admissible.

## Recommendation

Do not implement v22 as written.

Minimum rewrite before coding:

- Fix the legacy-admin non-MCP L1 rows. `?brain=<slug-of-other-existing-brain>` should scope to that brain and succeed, not invent a D6 deny that the doc's own D7a definition makes impossible.
- Actually inline the `/admin/thought/similar` table, or stop claiming that §3.8 does.
- Add concrete query/header acceptance rows for `/ingest/thought` and `/admin/thought/metadata` if D2 really means those L1 selectors are admitted on non-MCP write routes too.
