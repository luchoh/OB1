# Review: Agent Estate Implementation Roadmap v6

Date: 2026-06-02
Reviewed doc: `docs/29-agent-estate-implementation-roadmap-v6.md`
Verdict: Best version so far. Still reject as written.

## Zoom-Out

- `local/open-brain-mcp/src/auth.mjs` is still the choke point. The live split remains `human_token`, `service_key`, and `legacy_admin_key`.
- v6 is materially cleaner than v5. The layering is clearer, `requireWrite` finally lives in the helper contract, and the slug-vs-UUID access-check story is no longer hand-wavy.
- The remaining bugs are not "broad direction" problems. They are seam failures between the roadmap's claimed end state and the runtime it cites as ground truth.
- `local/open-brain-mcp/src/server.mjs` still matters as much as the prose. The plan touches MCP, `/ingest/thought`, `/ask`, `/admin/thought/metadata`, `/admin/thought/similar`, `stats`, the smoke harness, and the enrichment scripts.
- The annoying part is that v6 is close. The dangerous part is that the remaining mismatches are exactly the kind that survive planning and then waste a week in implementation.

## Findings

1. **Phase 7 "admin-key enforcement" acts on the wrong object. It does not actually disable the live legacy-admin path.**

   v6 says D11 now has teeth because Phase 7 will deactivate or downgrade `bootstrap-admin` in `brain_access_keys`, and it claims this becomes data-layer enforcement with an end-state invariant on active admin keys: [roadmap v6](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v6.md:409), [roadmap v6](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v6.md:698). But the live legacy-admin branch does not consult `brain_access_keys` at all. The runtime reads `config.accessKey` directly from env and routes any matching request into `resolveLegacyAdminContext()` before stored-key lookup: [config.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/config.mjs:349), [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:380).

   That means Phase 7 path `(b)` is fiction as written. Marking a stored row `is_admin=false` or `is_active=false` does not reduce the privileges of `OB1_LEGACY_ADMIN_KEY` if that key is still `config.accessKey`. The bridge does not become less privileged; the runtime still treats that key as legacy admin. Even the "zero active admin keys" query is misleading, because admin capability still exists outside the table the roadmap is checking.

   Rewrite gate: either Phase 7 rotates or removes `config.accessKey` and updates the runtime to stop honoring it as legacy admin, or D11/Phase 7 must be reframed as stored-key hygiene only, not actual legacy-admin enforcement.

2. **Human-token route-only binding leaves no explicit brain-selection path for the non-MCP HTTP surfaces that v6 still puts in scope.**

   v6 correctly rejects `?brain=` and `x-brain-slug` for `human_token` at L1 and says route form is the only blessed selector: [roadmap v6](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v6.md:104), [roadmap v6](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v6.md:374). But the only concrete route form it defines is `POST /mcp/brains/:brainSlug`: [roadmap v6](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v6.md:113). The live server likewise only has a brain-qualified route for MCP, not for `/ask`, `/ingest/thought`, or `/admin/thought/similar`: [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1063), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1074), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1107), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1174).

   That creates a real gap. D4 and Phase 2c still put those non-MCP HTTP surfaces in scope: [roadmap v6](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v6.md:182), [roadmap v6](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v6.md:545). But for `human_token`, query/header are forbidden and body `brain` cannot establish `requestBrain`; it can only match one that already exists. So on non-MCP HTTP, a human-token caller has no explicit way to target a non-default brain at all. That undercuts the original PRD's allowance for an explicit server-supported override on non-MCP HTTP/admin flows: [docs/17-local-household-multitenancy-prd.md](/Users/luchoh/Dev/OB1/docs/17-local-household-multitenancy-prd.md:548).

   Rewrite gate: either add brain-qualified human-token routes for the non-MCP HTTP surfaces, or state plainly that human-token on those surfaces is default-brain-only and remove the broader cross-brain implication.

3. **The legacy-admin helper still authorizes two brains when `requestBrain` differs from default, which contradicts the roadmap's own single-brain contract.**

   D6 case 1 says legacy admin is allowed when `brainId == accessContext.requestBrain OR brainId == legacy-admin default brain`: [roadmap v6](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v6.md:234). But the same section then says `listAccessibleBrainIds({mode})` for legacy admin returns only `[requestBrain ?? legacy-admin default]`: [roadmap v6](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v6.md:276). Phase 2a's matrix also says `target ≠ requestBrain` is DENY for legacy admin: [roadmap v6](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v6.md:454). D7 and Phase 2c both rely on strict single-brain behavior for legacy-admin metadata patching: [roadmap v6](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v6.md:290), [roadmap v6](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v6.md:599). The live resolver also returns one effective brain at a time: [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:336).

   If `requestBrain` points at a non-default brain, D6 case 1 still allows the default brain too. That is two-brain authorization inside the helper while the rest of the document assumes one. The acceptance matrix does not catch it because it only compares against `requestBrain`, not against "default while requestBrain is different."

   Rewrite gate: change D6 case 1 to allow only `brainId == (requestBrain ?? legacy-admin default brain)`, then add a test proving that once a non-default route brain is selected, the default brain is denied.

## Secondary Gaps

- `GET /admin/thought/access-check?brain=...` reuses the same `brain` query name that D2 defines as an L1 selector. That is survivable for service-key scripts, but it is still a layer-boundary exception disguised as a normal query param. A different param name such as `target_brain` would keep the selector story cleaner.
- D6 `mode='write'` now explicitly allows `estate_membership.role='member'` to create in every brain of the estate: [roadmap v6](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v6.md:267). The doc itself still treats that as an open policy question later: [roadmap v6](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v6.md:781). That is a real permission choice, not a drafting detail.

## Recommendation

Do not implement v6 as written.

Minimum rewrite before coding:

- fix D11/Phase 7 so it actually disables legacy admin in the runtime, not just in `brain_access_keys`;
- add an explicit human-token override path for non-MCP HTTP routes, or narrow their contract to default-brain-only;
- repair D6 case 1 so legacy admin is truly single-brain when a non-default route brain is selected;
- decide whether estate-level `member` should really imply create rights across the whole estate, because v6 currently treats that as both settled and still open.
