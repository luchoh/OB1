# Review: Agent Estate Implementation Roadmap v5

Date: 2026-06-02
Reviewed doc: `docs/29-agent-estate-implementation-roadmap-v5.md`
Verdict: Best version so far. Still reject as written.

## Zoom-Out

- `local/open-brain-mcp/src/auth.mjs` is still the tenancy choke point. The live branch split remains `human_token`, `service_key`, and `legacy_admin_key`.
- v5 is materially cleaner than v4 because it finally names the layers instead of pretending selectors, session context, and edit rules are the same thing.
- The remaining bugs are still seam bugs. They live where the document claims to be most disciplined: session binding, selector resolution, and handler authorization.
- `local/open-brain-mcp/src/server.mjs` still matters as much as the roadmap prose. The plan touches MCP routes, `/ingest/thought`, `/ask`, `/admin/thought/metadata`, `/admin/thought/similar`, `stats`, the smoke harness, and the enrichment scripts.
- The doc is now close enough that the failures are more annoying than dramatic. That does not make them safe.

## Findings

1. **v5 still does not define a real human-token session boundary. It describes session-brain binding, but the live runtime model is request-scoped and v5 still accepts per-request selectors.**

   D9 says human-token sessions are connector/route-bound, that `sessionBrain` is set once per session, and that callers must open a new session to target another brain: [roadmap v5 D9](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v5.md:324). But D2 still allows query string and `x-brain-slug` at L1 for all callers: [roadmap v5 D2](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v5.md:137). The live runtime resolves access context on every HTTP request from route/query/header, then builds a fresh MCP server and transport for that request: [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:227), [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:367), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1162), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1174).

   So the document's "set once per session" language is not attached to any actual server-side state. A human-token client can still switch brains across requests by changing the L1 selector, especially through query/header on `/mcp` or the non-MCP HTTP routes. That is exactly the contract v5 claims to have removed, and it still conflicts with the v1 guidance that human MCP brain selection should be connector- or route-level, not hidden in per-request headers: [docs/17-local-household-multitenancy-prd.md](/Users/luchoh/Dev/OB1/docs/17-local-household-multitenancy-prd.md:250), [docs/17-local-household-multitenancy-prd.md](/Users/luchoh/Dev/OB1/docs/17-local-household-multitenancy-prd.md:548).

   Rewrite gate: either make human-token selection truly route-only and reject query/header for that auth source, or explicitly describe the request-scoped model you are actually implementing instead of calling it a session boundary.

2. **The new `/admin/thought/access-check` endpoint cannot satisfy v5's own selector rules and error semantics at the same time.**

   D13 says the preflight route resolves `brain` "to a UUID via D8" and returns 403 for callers that cannot even read the brain: [roadmap v5 D13](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v5.md:398). Phase 2a acceptance then requires `GET /admin/thought/access-check?brain=<inaccessible>` to return 403: [roadmap v5 Phase 2a](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v5.md:464). But D8 says non-legacy resolution uses `listAccessibleBrainIds()` exactly and returns 404 when the slug is not in that accessible set: [roadmap v5 D8](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v5.md:313). Phase 6 also says the scripts will call the endpoint with `brain=<UUID>`: [roadmap v5 Phase 6](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v5.md:697).

   That is three different stories jammed together:

   - inaccessible slug via D8 should be 404, not 403;
   - inaccessible UUID is not actually defined by D8, because D8 only specifies slug resolution;
   - returning 403 for inaccessible brains requires either bypassing D8 or adding a second UUID/global-resolution path that the doc never specifies.

   The "not an enumeration oracle" mitigation is also backwards as written. If you globally resolve to produce 403, you distinguish inaccessible from nonexistent. If you resolve only over the accessible set, you get 404 and the endpoint cannot produce the advertised 403 at all.

   Rewrite gate: split slug and UUID handling explicitly, then choose one failure contract for inaccessible targets. Do not keep claiming "resolves via D8" and "returns 403 for inaccessible" in the same design.

3. **Capture authorization is still not defined at the core helper layer. The document invents `requireWrite` halfway through Phase 2c after already defining the helper contract and test matrix without it.**

   D6 defines `checkBrainAccess(accessContext, brainId, requireEdit)` as the core L4 helper: [roadmap v5 D6](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v5.md:234). Phase 2a implements that helper, `listAccessibleBrainIds`, `listEditableBrainIds`, and the access-check endpoint, again with no write-mode branch in the contract or matrix: [roadmap v5 Phase 2a](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v5.md:464). Then Phase 2c hits capture and abruptly changes the model: "Hmm — clarification" introduces `checkBrainAccess({requireWrite: true})` because create semantics are not edit semantics, and says the Phase 2a matrix is extended: [roadmap v5 Phase 2c](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v5.md:533).

   That is not a small drafting blemish. `capture_thought` and `/ingest/thought` are primary write surfaces. Whether estate-member, brain-member, human-token, or admin callers may create in a brain is a first-order permission rule, not a late note in the handler phase. As written, the roadmap does not pin the create-authority table in one canonical place before downstream route behavior depends on it.

   Rewrite gate: define `requireWrite` in D6 and Phase 2a before Phase 2c uses it, with the full branch matrix for every auth source. If you do not want a third mode, then stop introducing one mid-phase and reuse an existing permission mode consistently.

## Secondary Gaps

- D5 says legacy and single-brain `stats` keep today's shape "exactly," but the proposed response adds a new top-level `scope` field and moves single-brain counters to top-level keys like `total` and `embedded`: [roadmap v5 D5](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v5.md:198). The live server currently returns `overview` as a nested object plus `top_sources`, `top_types`, and `top_people`: [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:707). That is a response-contract change, not "exactly preserved," and there is no explicit acceptance row for compatibility.
- D11 is still policy, not enforcement. The schema and resolver continue to allow household-wide stored `is_admin=true` keys: [roadmap v5 D11](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v5.md:377), [005_household_multitenancy.sql](/Users/luchoh/Dev/OB1/local/open-brain-mcp/migrations/005_household_multitenancy.sql:83). The CLI refusing by default is useful, but it does not actually close the footgun.

## Recommendation

Do not implement v5 as written.

Minimum rewrite before coding:

- make the human-token model honest: either route-only/session-bound with rejected query/header selectors, or explicitly request-scoped;
- rewrite `/admin/thought/access-check` so slug vs UUID resolution and 403 vs 404 behavior are defined once and consistently;
- move create authorization into the core helper contract and matrix before any handler logic depends on it;
- stop claiming the `stats` legacy shape is unchanged if you are adding `scope` and flattening `overview`.
