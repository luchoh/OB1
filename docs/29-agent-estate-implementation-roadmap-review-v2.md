# Review: Agent Estate Implementation Roadmap v2

Date: 2026-06-02
Reviewed doc: `docs/29-agent-estate-implementation-roadmap-v2.md`
Verdict: Better than v1. Still reject as written.

## Zoom-Out

- `local/open-brain-mcp/src/auth.mjs` is still the tenancy choke point. It has three real auth branches today: `human_token`, `service_key`, and `legacy_admin_key`.
- Stored service keys are not all equivalent. The current schema and resolver support keys that are principal-scoped **and** optionally brain-bound via `brain_access_keys.brain_id`.
- `local/open-brain-mcp/src/server.mjs` exposes more than MCP tools. The live surfaces are MCP plus `/ingest/thought`, `/ask`, `/admin/thought/metadata`, `/admin/thought/similar`, and `/graph/*`.
- `local/open-brain-mcp/src/retrieval.mjs` and the SQL RPCs are single-brain today. Multi-brain behavior is not just a search change; it changes auth, selector resolution, response shape, telemetry, and write-surface semantics together.
- Repo shell env matters operationally. Several local scripts blindly read `MCP_ACCESS_KEY`, so Phase 4 changes which auth branch they use whether the PRD admits it or not.

## Findings

1. **Phase 2 drops the existing `brain_access_keys.brain_id` restriction, which widens stored-key privileges beyond the current auth contract.**

   The new helper sketch only models legacy-admin bypass plus principal memberships and estate memberships: `docs/29-agent-estate-implementation-roadmap-v2.md:268-293`. The tool/HTTP phase then treats stored keys as free to target any accessible brain: `docs/29-agent-estate-implementation-roadmap-v2.md:343-376`. But the current resolver enforces a separate credential-level restriction: if a stored key has `brain_access_keys.brain_id` set and is not admin, requests to any other brain are rejected with 403, and that key-bound brain becomes the fallback effective brain: `local/open-brain-mcp/src/auth.mjs:241-317`. The underlying multitenancy PRD also says normal service keys should be bound to exactly one brain when possible: `docs/17-local-household-multitenancy-prd.md:387-407`.

   This is not theory. Under the v2 helper shape, a brain-bound stored key would suddenly inherit every brain its principal can access through estate membership unless the implementation adds a second restriction layer back in. That is a real privilege expansion, and the acceptance section never tests it.

2. **Explicit slug resolution is still inconsistent with estate-based access, so cross-estate brains can be searchable by default but unselectable explicitly.**

   Phase 2a says `listAccessibleBrainIds()` for stored keys is the union of explicit brain allows plus all brains in estates where the principal has estate membership, minus denies: `docs/29-agent-estate-implementation-roadmap-v2.md:287-293`. Phase 2b then defines slug lookup for stored keys as only the union of the principal's own estate plus brains with explicit membership rows: `docs/29-agent-estate-implementation-roadmap-v2.md:326-329`. Those are not the same set.

   The bug shows up the moment a principal has access to estate B through an `estate_memberships` row alone. A no-`brain` search would include estate B's brains, because Phase 2a says they are accessible. An explicit `brain="<slug-in-estate-B>"` capture or search would fail slug resolution, because Phase 2b does not search that estate unless there is also a direct `brain_memberships` row. The acceptance case at `docs/29-agent-estate-implementation-roadmap-v2.md:334-336` implicitly assumes the opposite.

3. **The operator path is still not coherently specified: human-token access is omitted, while the “existing access key” path is explicitly single-brain.**

   A stated goal is operator visibility into all agent brains via estate membership: `docs/29-agent-estate-implementation-roadmap-v2.md:61-69`. But the concrete design and acceptance logic only spell out stored-key behavior and legacy-admin behavior: `docs/29-agent-estate-implementation-roadmap-v2.md:120-146`, `268-337`, `382-409`. The current human-token resolver is still household-scoped for slug lookup and direct-membership-scoped for authorization: `local/open-brain-mcp/src/auth.mjs:159-224`. The broader repo auth model also expects a first-class human request path, not just service keys: `docs/17-local-household-multitenancy-prd.md:462-490`.

   v2 then makes it worse by claiming the operator can search across the agent estate's brains using their “existing access key”: `docs/29-agent-estate-implementation-roadmap-v2.md:426-434`. But D3 explicitly defines the legacy admin key path as single-brain and says multi-brain defaults do not apply there: `docs/29-agent-estate-implementation-roadmap-v2.md:133-141`. So the doc still does not answer the only question that matters operationally: does operator cross-estate visibility land via human token, via a new stored key for `luchoh`, or via legacy admin? Right now the roadmap gestures at all three and commits to none.

4. **Phase 4 and Phase 6 contradict each other. Once `.envrc` flips `MCP_ACCESS_KEY`, repo-local scripts stop using the legacy-admin path.**

   D3 and Phase 6 both rely on several scripts staying on the legacy-admin branch: `docs/29-agent-estate-implementation-roadmap-v2.md:129-132`, `456-476`. Phase 4 then says that inside `/Users/luchoh/Dev/OB1`, `MCP_ACCESS_KEY` should resolve to the OB1 repo principal's stored key, not the legacy admin key: `docs/29-agent-estate-implementation-roadmap-v2.md:436-447`.

   The scripts themselves do not have a separate admin-key env var. They just read `MCP_ACCESS_KEY` from the shell and send it: `scripts/smoke-open-brain-running-service.sh:20-23`, `72-90`; `scripts/thought_enrichment/enrich.py:185-188`. After Phase 4, running those scripts from the OB1 repo shell will route them through `service_key`, not `legacy_admin_key`. That means:

   - the “smoke script unchanged” acceptance no longer proves the legacy-admin branch;
   - `scripts/thought_enrichment/*` no longer “still hits one brain” by default;
   - the doc's no-regression story depends on an execution environment it is actively removing.

   This needs a real split such as `OB1_LEGACY_ADMIN_KEY` for admin scripts, or the PRD needs to stop pretending the repo shell keeps exercising the legacy path.

5. **`/admin/thought/metadata` is not just a bug fix in v2; it becomes a deliberate cross-brain write surface for non-admin repo principals, without a separate authorization decision.**

   The doc says edit/delete capabilities are out of scope: `docs/29-agent-estate-implementation-roadmap-v2.md:71-77`. Then it expands `/admin/thought/metadata` so stored-key callers can patch any thought in any accessible brain: `docs/29-agent-estate-implementation-roadmap-v2.md:158-165`, `372-376`, `497-500`. The current route is not admin-gated at all; it simply resolves any valid access context and performs the update against `effectiveBrainId`: `local/open-brain-mcp/src/server.mjs:623-645`, `1085-1100`.

   Under Phase 4, repo principal keys live in `.envrc`. Under Phase 2c, those same keys gain cross-brain metadata patch power across the common brain if they have access. That is a real write-surface expansion for agents, not a harmless removal of a 404 footgun. If that is intended, it needs to be called what it is: a new agent-side edit capability with its own authorization policy and audit requirements. Right now the PRD treats it as a minor semantic shift and punts the real control to future ADR-27 work.

## Secondary Gaps

- Phase 2b says tool-arg vs session-brain disagreement is detected “in Phase 3”: `docs/29-agent-estate-implementation-roadmap-v2.md:321-329`. But Phase 3 is provisioning, not tool execution. The sequencing is sloppy enough to hide deployability assumptions.
- The acceptance matrix never covers a stored key with `brain_access_keys.brain_id` set. That is the exact branch most likely to regress if the helper is implemented from this PRD literally.

## Recommendation

Do not implement v2 as written.

The minimum rewrite before coding is:

- carry `brain_access_keys.brain_id` through the new access helper and add explicit tests for brain-bound stored keys;
- make slug resolution operate over the **same** accessible-brain set that default multi-brain reads use;
- pick one operator path and write it down explicitly: human token, stored operator key, or legacy admin, then test that path end to end;
- separate repo principal keys from legacy-admin script keys before Phase 4, or stop claiming those scripts are unchanged;
- treat `/admin/thought/metadata` as a write-surface expansion that needs an explicit authorization decision, not just a compatibility fix.
