# Review: Agent Estate Implementation Roadmap v13

Date: 2026-06-03
Reviewed doc: `docs/29-agent-estate-implementation-roadmap-v13.md`
Verdict: Closer. Still reject as written.

## Zoom-Out

- The live policy choke point is the access-context layer, not the route table. Today both the human principal path and the stored access key path still resolve requested slugs household-wide before applying membership denial in [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:106), [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:159), and [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:241). That is exactly the behavior D8/D18 is trying to replace.
- Every brain-scoped surface hangs off that same access context: capture, ask, metadata patch, similar-thought lookup, and graph routes all call `resolveAccessContext(...)` before acting in [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1063). So a bad slug-visibility rule becomes an estate-wide behavior bug, not a cute corner case.
- The domain contract around grants is otherwise coherent. ADR-0001 defines two grant paths, `brain_memberships` and `estate_memberships`, with brain-level deny override in [ADR-0001](/Users/luchoh/Dev/OB1/docs/adr/0001-agent-estate-brain-model.md:31). `CONTEXT.md` defines the common brain as an agent-estate brain shared via explicit `brain_memberships` in [CONTEXT.md](/Users/luchoh/Dev/OB1/CONTEXT.md:52). v7's provisioning contract says repo principals do not get agent-estate `estate_memberships`; cross-repo visibility is via explicit `brain_memberships` only in [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:562).

## Findings

1. **D8 and D18 still assert opposite rules for denied-brain slug visibility, so v13 has not actually chosen a single policy.**

   D8 says non-admin non-brain-bound and `human_token` lookup scope is `brainMemberships ∪ (brains in estates with estate_memberships)` in [roadmap v13](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v13.md:69). It then says the remaining case where slug lookup resolves but step 2 denies is the brain-level deny override: `brain-deny + estate-allow` still resolves the slug through the estate membership and returns `403` in [roadmap v13](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v13.md:125). Phase 2 repeats that contract as executable acceptance rows in [roadmap v13](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v13.md:231) and [roadmap v13](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v13.md:253).

   D18 says the opposite. For those same auth sources, visibility "tracks the same set as access" and `lookup scope = access set` in [roadmap v13](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v13.md:189). The inherited D17 text that v13 keeps by reference still defines access as `brain-allow ∪ estate-allow − brain-deny` in [roadmap v12](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v12.md:150). That excludes the denied brain from access while D8 still keeps it slug-visible through estate lookup.

   Those two statements cannot both be true:

   - If `brain-deny + estate-allow` should resolve by slug and return `403`, then lookup scope is broader than access.
   - If `lookup scope = access set`, then that denied brain must not resolve by slug and should return `404`.

   v13 fixed the earlier "same agent-estate sibling brain" leak, but it left the deeper rule unresolved. Right now the document still contains two incompatible confidentiality models and asks the implementer to guess which sentence matters more. That is how bad auth behavior ships.

## Secondary Gaps

- **v13 narrows human-token slug visibility relative to the older household PRD, but never cleanly says that contract is superseded.** `docs/17` says the human MCP route resolves `:brain_slug` inside the authenticated principal's household and returns `403` when the slug exists in that household but the principal cannot use it in [docs/17](/Users/luchoh/Dev/OB1/docs/17-local-household-multitenancy-prd.md:565). v13 now says `human_token` visibility tracks explicit grants only in [roadmap v13](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v13.md:70) and [roadmap v13](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v13.md:189), which narrows that older rule to `404` for same-household-but-not-granted brains. The live human path still behaves the old way today in [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:201). If v13 intends to supersede `docs/17` for humans too, say it plainly. If not, D18's `human_token` rule is wrong.

## Recommendation

Do not implement v13 as written.

Minimum rewrite before coding:

- Pick one denied-brain slug policy and state it consistently. Either keep the `brain-deny + estate-allow` `403` path and rewrite D18 to admit lookup can exceed access, or make D18 true and change the denied-brain slug cases to `404`.
- Stop inheriting D17 by implication if D18 depends on it. Inline the actual accessible-set rule in v13 so the reader does not have to diff old versions to discover whether deny rows are in or out.
- If `human_token` is now explicit-grants-only for slug visibility, explicitly mark the older household-wide `403` contract in `docs/17` as superseded for this estate model.
