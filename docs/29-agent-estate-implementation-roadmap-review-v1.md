# Review: Agent Estate Implementation Roadmap v1

Date: 2026-06-02
Reviewed doc: `docs/29-agent-estate-implementation-roadmap.md`
Verdict: Reject as written. The direction is sound. The rollout plan is not.

## Zoom-Out

- `local/open-brain-mcp/src/auth.mjs` is the tenancy choke point. It resolves a Principal into one `effectiveBrainId` today, from either a human token, a stored service key, or the legacy admin key.
- `local/open-brain-mcp/src/server.mjs` exposes more than MCP tools. The live read/write surfaces are MCP plus `/ingest/thought`, `/ask`, `/admin/thought/metadata`, `/admin/thought/similar`, and `/graph/*`.
- PostgreSQL is the authority. `thoughts` are brain-scoped, `brain_access_keys` can still be brain-bound, and brain/principal slugs are only unique inside one estate/household.
- `local/open-brain-mcp/src/retrieval.mjs` and the SQL RPCs are strictly single-brain today. `local/open-brain-mcp/src/observability.mjs` also assumes one effective brain per request.
- Neo4j is a projection, not the source of truth. Its query surfaces are canonical-id driven and currently admin-only because graph scoping is not safe yet.
- Current callers include smoke scripts and backfill tooling, not just agents reading MCP tool schemas.

## Findings

1. **Phase 1 reintroduces estate-level deny semantics that ADR-0001 explicitly rejected.**

   Roadmap lines `55-75` create `estate_memberships.is_deny`. ADR-0001 says the model is estate-level allow plus brain-level deny override, and that estate-level deny does not exist: `docs/adr/0001-agent-estate-brain-model.md:42-46`. Phase 2's access check in the roadmap never defines what an estate deny row means: `docs/29-agent-estate-implementation-roadmap.md:107-121`. That leaves an auth state the code can neither ignore safely nor enforce consistently.

   Rewrite gate: drop `is_deny` from `estate_memberships`; keep deny semantics on `brain_memberships` only.

2. **The roadmap pulls graph tools into Phase 2 without the graph scoping work that current multitenancy rules require.**

   The roadmap adds `brain` to `graph_neighbors`, `source_lineage`, `why_connected`, and `expand_context`: `docs/29-agent-estate-implementation-roadmap.md:85-87`. The repo's multitenancy PRD says graph features must stay disabled for non-admin multitenant requests until graph scoping exists: `docs/17-local-household-multitenancy-prd.md:632-641`. The server currently enforces exactly that: `local/open-brain-mcp/src/server.mjs:427-429` and `773-776`. The graph queries themselves are global-canonical-id lookups, not brain-filtered queries: `local/open-brain-mcp/src/graph.mjs:1467-1480`, `1708-1805`, `1926-2047`, `2050-2088`. Shipping Phase 2 as written risks cross-brain leakage or false cross-estate paths.

   Rewrite gate: keep graph tools admin-only until graph nodes/edges are brain-qualified or every graph query can constrain by brain safely.

3. **The backward-compatibility story does not match the auth path the local runtime actually uses.**

   The roadmap says behavior stays unchanged because "accessible brains is currently 1" and the bootstrap-admin principal owns one brain: `docs/29-agent-estate-implementation-roadmap.md:136-140`. The runtime does not usually resolve local `MCP_ACCESS_KEY` through a stored principal first. `resolveAccessContext` checks `key === config.accessKey` and routes that request through the legacy admin path before stored-key lookup: `local/open-brain-mcp/src/auth.mjs:367-381`. That legacy path is principal-less and global: `local/open-brain-mcp/src/auth.mjs:336-364`. The smoke flow and local scripts use `MCP_ACCESS_KEY` directly: `scripts/smoke-open-brain-running-service.sh:23-35` and `72-90`. Phase 2 therefore needs an explicit policy for legacy admin searches and writes, or the "no behavior change" claim is fiction.

   Rewrite gate: define legacy-admin semantics separately from repo-principal semantics, and add acceptance tests for both.

4. **Phase 2 only updates MCP tool arguments, but several live HTTP/admin surfaces remain single-brain and will fail in the new model.**

   The roadmap claims no writer is forced to change and the default-brain rule covers them: `docs/29-agent-estate-implementation-roadmap.md:229-242`, `285-286`. That is not true for `/admin/thought/metadata`. The handler updates by both `thought_id` and `accessContext.effectiveBrainId`: `local/open-brain-mcp/src/server.mjs:623-645`, `1085-1100`. If the target thought lives in `agent-common` but the caller's default brain is the repo brain, the patch becomes "thought not found." Existing repo tooling already depends on that endpoint: `scripts/thought_enrichment/lib/db.py:204-264`, `scripts/backfill-chat-claim-typing.py:172-192`, `scripts/thought_enrichment/README.md:12-18`. The same blind spot exists for `/ingest/thought`, `/ask`, `/admin/thought/similar`, and `/graph/*`, which all still resolve through one `effectiveBrainId`.

   Rewrite gate: either extend Phase 2 to every HTTP surface that reads or writes thoughts, or explicitly mark those paths unsupported and remove the "no writer changes" claim.

5. **Brain resolution semantics are underspecified. There are already three selectors, and accessible slugs are not globally unique.**

   Today the runtime already supports `POST /mcp/brains/:brainSlug`, plus `?brain=` and `x-brain-slug`: `local/open-brain-mcp/README.md:140-143`, `local/open-brain-mcp/src/auth.mjs:227-239`, `local/open-brain-mcp/src/server.mjs:1174-1180`. The roadmap adds a fourth selector at the tool-argument layer: `docs/29-agent-estate-implementation-roadmap.md:85-99`. It never says what happens when route, header/query, and tool arg disagree. It also never defines the ambiguity rule once one principal can access multiple estates. Brain slugs are only unique within an estate/household: `docs/17-local-household-multitenancy-prd.md:330-332`. ADR-0001 intentionally picks short slugs like `ob1` and `system-config`: `docs/adr/0001-agent-estate-brain-model.md:72-78`. That is fine until an operator can see two estates with the same slug.

   Rewrite gate: pick one canonical selector, hard-error on mixed selectors, and define how ambiguity is handled across estates.

6. **Multi-brain read results still have no brain origin, so callers cannot safely interpret or follow up on them.**

   ADR-0001 says multi-brain reads should carry per-row `brain_id` and `brain_slug`: `docs/adr/0001-agent-estate-brain-model.md:84-88`. The roadmap does not call out those response-shape changes. Current search/list/ask responses do not include brain origin. `evidenceCitation()` omits it, `search_thoughts` returns raw retrieval rows without it, and `list_thoughts` returns rows from a single-brain RPC: `local/open-brain-mcp/src/server.mjs:204-229`, `378-386`, `694-704`. In the planned repo-brain plus common-brain model, that makes focused follow-up queries, audits, and metadata patches guesswork.

   Rewrite gate: make `brain_id` and `brain_slug` part of the Phase 2 response contract for search/list/ask, and define cross-brain aggregation semantics for `stats`.

## Secondary Gaps

- The roadmap's acceptance criteria never prove the human operator path works end to end. The goal is operator visibility via the `luchoh` principal: `docs/29-agent-estate-implementation-roadmap.md:27-29`, `33-35`. The acceptance section only tests service-key behavior and shell env rollout: `docs/29-agent-estate-implementation-roadmap.md:254-286`.
- `observability.mjs` still logs one `brain_id` and one `brain_slug` per request: `local/open-brain-mcp/src/observability.mjs:127-133`. The roadmap mentions extra counters, but not the payload-shape change required for multi-brain reads.

## Recommendation

Do not implement this roadmap as written.

Rewrite Phase 1 and Phase 2 first. The minimum safe rewrite is:

- remove estate-level deny rows;
- define legacy-admin behavior separately from repo-principal behavior;
- cover HTTP/admin surfaces, not just MCP tool schemas;
- keep graph tools admin-only until graph scoping exists;
- define one brain selector and one ambiguity rule;
- add `brain_id` and `brain_slug` to multi-brain read results and test the human operator path.
