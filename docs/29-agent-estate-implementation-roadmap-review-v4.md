# Review: Agent Estate Implementation Roadmap v4

Date: 2026-06-02
Reviewed doc: `docs/29-agent-estate-implementation-roadmap-v4.md`
Verdict: Better than v3. Still reject as written.

## Zoom-Out

- `local/open-brain-mcp/src/auth.mjs` is still the tenancy choke point. The real branches remain `human_token`, `service_key`, and `legacy_admin_key`.
- v4 is materially cleaner because it finally separates three different questions that v3 kept mixing together: default read scope, edit scope, and selector resolution.
- The remaining bugs are at the seams between those questions: `/admin/thought/metadata`, human MCP session semantics, and repo-shell env routing for operator scripts.
- `local/open-brain-mcp/src/server.mjs` still matters as much as the roadmap prose. The plan touches MCP tools, `/ingest/thought`, `/ask`, `/admin/thought/metadata`, `/admin/thought/similar`, the smoke harness, and the enrichment scripts.
- Any design that depends on "run this from outside the repo shell" or "just don't mint that kind of key" is not a permission model. It is folklore with extra steps.

## Findings

1. **The new legacy-admin `brain` selector for `/admin/thought/metadata` contradicts v4's own access-check helper, so the advertised non-default-brain fix is not actually represented in the auth model.**

   v4 says the legacy-admin branch stays single-brain by definition in D6: [roadmap v4 D6](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v4.md:150). That helper only allows `legacy_admin_key` when `brainId == effectiveBrainId`: [roadmap v4 D6](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v4.md:153). Then D7 and Phase 2c say `/admin/thought/metadata` gets a new body `brain` selector so legacy admin can patch a non-default brain by passing `brain=<slug>`: [roadmap v4 D7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v4.md:191), [roadmap v4 Phase 2c](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v4.md:429). The acceptance block explicitly expects `WITH brain=<slug> -> 200`: [roadmap v4 acceptance](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v4.md:447).

   Those claims do not line up. In the live route, access context is resolved before the request body is parsed, and legacy-admin `effectiveBrainId` only comes from route/query/header brain selection, not a body field: [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:336), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1085). v4 never updates D2 or D6 to make body `brain` part of the auth selector model. So either the implementation follows D6 and still denies the non-default-brain patch, or it special-cases this endpoint and legacy admin is no longer "single-brain by definition." Pick one story.

   Rewrite gate: either promote the metadata body `brain` field into the auth-selector model and rewrite D6 accordingly, or drop the claim that legacy admin can patch a non-default brain through body `brain` alone.

2. **Human-token sessions are still per-call brain-switchable, which violates the v1 "single-brain per connector/session" contract.**

   v4 fixes the default-read behavior, but not the actual contract. D9 says human-token sessions stay single-brain only when no `brain` is specified, and then immediately allows them to target other brains via the `brain` argument: [roadmap v4 D9](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v4.md:238). D2 also formalizes tool-arg brain selection and disagreement handling: [roadmap v4 D2](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v4.md:96). Phase 2c acceptance then tests exactly that path for humans: `search with brain="agent-common"` succeeds: [roadmap v4 human acceptance](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v4.md:479).

   The existing multitenancy PRD says human MCP sessions should still be effectively single-brain per connector/session in v1, and that brain selection should be explicit at the connector or route level, not hidden in arbitrary per-tool headers: [docs/17-local-household-multitenancy-prd.md](/Users/luchoh/Dev/OB1/docs/17-local-household-multitenancy-prd.md:250), [docs/17-local-household-multitenancy-prd.md](/Users/luchoh/Dev/OB1/docs/17-local-household-multitenancy-prd.md:548). v4 still changes that. It just changes it with a nicer default.

   Rewrite gate: for `human_token`, keep MCP brain selection at the route/connector/session layer only, or explicitly declare that v1 human MCP is now per-call brain-switchable and treat that as a public-contract change.

3. **The enrichment migration still collides with repo `.envrc`, and its acceptance checks do not verify what they claim.**

   Phase 4 says that inside a repo shell, `MCP_ACCESS_KEY` resolves to the repo principal key: [roadmap v4 Phase 4](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v4.md:524). Phase 6 then picks option `(a)` and says the enrichment scripts should use `MCP_ACCESS_KEY=<operator stored key>`: [roadmap v4 Phase 6](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v4.md:555). Those two statements only coexist if the operator runs the scripts outside the repo shell or manually overrides `MCP_ACCESS_KEY` first. The roadmap never promotes that requirement to a first-class contract, even though the scripts live in the repo and are naturally run from there.

   The acceptance logic is also fake in the unglamorous way. `enrich.py` and `backfill_sensitivity.py` only check that `MCP_ACCESS_KEY` exists on `--apply`; they do not verify that it is the operator key or that it is authorized for the target brain up front: [enrich.py](/Users/luchoh/Dev/OB1/scripts/thought_enrichment/enrich.py:185), [backfill_sensitivity.py](/Users/luchoh/Dev/OB1/scripts/thought_enrichment/backfill_sensitivity.py:44). `--status` does not use the key at all, so `--status works against operator stored key` proves nothing: [enrich.py](/Users/luchoh/Dev/OB1/scripts/thought_enrichment/enrich.py:292). The shared admin client just posts patches and fails row by row: [db.py](/Users/luchoh/Dev/OB1/scripts/thought_enrichment/lib/db.py:228). In a repo shell, `MCP_ACCESS_KEY` is already set to the repo key, so the promised clear startup error for a missing or unauthorized operator key will not happen. You get partial processing and a pile of patch failures instead.

   Rewrite gate: give these scripts a dedicated operator-key input such as `OB1_OPERATOR_ACCESS_KEY`, or require an explicit CLI override, and add a startup auth preflight against the requested `--brain-id` before any rows are processed.

## Secondary Gaps

- v4 still preserves household-wide stored `is_admin` keys: [roadmap v4 D6](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v4.md:159), [005_household_multitenancy.sql](/Users/luchoh/Dev/OB1/local/open-brain-mcp/migrations/005_household_multitenancy.sql:83). That means spouse privacy is still one `is_admin=true, brain_id=null` key away from collapse inside `local-household`. v4 no longer creates such keys, but it also does not deprecate or constrain them.
- D5 says the legacy single-brain `stats` shape is preserved when `scope="single"`: [roadmap v4 D5](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v4.md:144). The roadmap never defines a `scope` input or an acceptance row for that shape, so the compatibility claim is underspecified.

## Recommendation

Do not implement v4 as written.

Minimum rewrite before coding:

- align the legacy-admin metadata-brain flow with the actual auth-selector model instead of splitting D6 and D7 into incompatible stories;
- keep human MCP sessions route/connector-scoped, or explicitly admit the public contract changed;
- split operator-script auth from repo-shell `MCP_ACCESS_KEY`, then add an upfront brain-authorization preflight for enrichment/backfill scripts;
- decide whether stored household-scoped `is_admin` keys remain legal long term, because they still bypass the clean estate-membership privacy story.
