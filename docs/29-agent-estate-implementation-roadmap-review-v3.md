# Review: Agent Estate Implementation Roadmap v3

Date: 2026-06-02
Reviewed doc: `docs/29-agent-estate-implementation-roadmap-v3.md`
Verdict: Better again. Still reject as written.

## Zoom-Out

- `local/open-brain-mcp/src/auth.mjs` is still the choke point. It has three materially different auth branches today: `human_token`, `service_key`, and `legacy_admin_key`.
- Stored service keys are not one thing. The current runtime distinguishes non-admin vs admin and brain-bound vs non-brain-bound keys, and those differences are already load-bearing.
- `local/open-brain-mcp/src/server.mjs` exposes more than MCP tools. The plan touches MCP plus `/ingest/thought`, `/ask`, `/admin/thought/metadata`, and `/admin/thought/similar`.
- Human-token behavior is not just an implementation detail. `docs/17-local-household-multitenancy-prd.md` still treats human MCP sessions as effectively single-brain per connector/session in v1.
- The legacy-admin backfill/enrichment scripts are brain-scoped on the SQL read side, but their metadata write path still has no explicit brain selector. That matters once multiple brains actually exist.

## Findings

1. **Stored `is_admin` service keys become global cross-estate superusers, which is broader than the current auth contract and weaker than the intended privacy model.**

   v3 makes `service_key, is_admin` an unconditional allow for any brain and gives it `listAccessibleBrainIds() = every brain`: `docs/29-agent-estate-implementation-roadmap-v3.md:151-169`. It also gives that branch full cross-brain metadata patch power: `docs/29-agent-estate-implementation-roadmap-v3.md:180-189`. That is a real privilege expansion from the live resolver, which today only resolves explicit stored-key brain overrides inside the principal's own household via `resolveBrainBySlugForHousehold(first.household_id, requestedBrainSlug)` and otherwise applies one `effectiveBrainId` to the request: [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:241), [docs/17-local-household-multitenancy-prd.md](/Users/luchoh/Dev/OB1/docs/17-local-household-multitenancy-prd.md:492).

   This also undercuts v3's own D3 choice that operator visibility should come from explicit estate membership on a non-admin stored key: `docs/29-agent-estate-implementation-roadmap-v3.md:90-120`. If any stored admin key now sees every brain, the estate-membership path stops being the meaningful boundary. Spouse/privacy becomes "hope nobody mints stored admin keys" instead of "the auth model prevents it."

   Rewrite gate: keep stored `is_admin` keys household-scoped like today, or explicitly declare them global and deprecate them everywhere except the bootstrap path.

2. **v3 silently changes human-token sessions from single-brain connector sessions to multi-brain default reads.**

   v3 lumps `human_token` into the same non-brain-bound branch as service keys: `docs/29-agent-estate-implementation-roadmap-v3.md:157-174`. Phase 2c then says read surfaces with no `brain` argument scope to `listAccessibleBrainIds()`: `docs/29-agent-estate-implementation-roadmap-v3.md:364-370`. That means human-token sessions go multi-brain by default.

   The existing multitenancy PRD says the opposite. In v1, human MCP sessions should still be effectively single-brain per connector/session, and brain selection should be explicit at the connector or route level: [docs/17-local-household-multitenancy-prd.md](/Users/luchoh/Dev/OB1/docs/17-local-household-multitenancy-prd.md:250), [docs/17-local-household-multitenancy-prd.md](/Users/luchoh/Dev/OB1/docs/17-local-household-multitenancy-prd.md:548).

   v3 treats human-token as a future option in D3, but it still rewires its semantics here without calling that out as a public-route design change. That is not a harmless refactor. It changes the user-facing auth contract.

   Rewrite gate: either keep human-token sessions single-brain/session-scoped, or explicitly make "human sessions default to multi-brain" a separate design decision with its sysadmin/public-route implications.

3. **The legacy-admin enrichment/backfill story still breaks on non-default brains, because the scripts are brain-scoped on read but the metadata patch path is still single-brain.**

   v3 keeps the legacy-admin `/admin/thought/metadata` path single-brain: `docs/29-agent-estate-implementation-roadmap-v3.md:180-181`, `375-380`. It also says the enrichment/backfill scripts keep working after only the env-var split: `docs/29-agent-estate-implementation-roadmap-v3.md:387-389`, `480-485`, `502-506`.

   But the scripts read one brain and write through an endpoint that still has no explicit brain selector. The enrichment and sensitivity scripts query by the caller-supplied `brain_id`: [enrich.py](/Users/luchoh/Dev/OB1/scripts/thought_enrichment/enrich.py:252), [backfill_sensitivity.py](/Users/luchoh/Dev/OB1/scripts/thought_enrichment/backfill_sensitivity.py:66). Their shared admin client then POSTs only `thought_id` plus patch fields to `/admin/thought/metadata`: [db.py](/Users/luchoh/Dev/OB1/scripts/thought_enrichment/lib/db.py:228). The server route still applies the update to `accessContext.effectiveBrainId`, and the SQL update still requires `where id = $1 and brain_id = $2`: [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:566), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1085).

   So under the v3 contract, a legacy-admin run over brain B still patches against the legacy admin's effective brain, not the scanned brain. On a non-default brain, that means "thought not found", not a successful backfill. The roadmap claims the scripts succeed, but the write path it preserves does not support that claim.

   Rewrite gate: either move these scripts to an explicit-brain stored-key path, or add an explicit brain selector to `/admin/thought/metadata` for the legacy-admin branch and test the non-default-brain case end to end.

4. **Phase 6 contradicts itself on the smoke harness contract.**

   The change list says `scripts/smoke-open-brain-running-service.sh` should read `OB1_LEGACY_ADMIN_KEY` instead of `MCP_ACCESS_KEY`: `docs/29-agent-estate-implementation-roadmap-v3.md:480-481`. The acceptance list then says the same smoke harness should also pass with `MCP_ACCESS_KEY=<repo-key>` via the `service_key` path: `docs/29-agent-estate-implementation-roadmap-v3.md:498-501`.

   The current script is single-key oriented: it reads `MCP_ACCESS_KEY`, errors if missing, and sends that one header through the MCP client: [smoke-open-brain-running-service.sh](/Users/luchoh/Dev/OB1/scripts/smoke-open-brain-running-service.sh:23), [smoke-open-brain-running-service.sh](/Users/luchoh/Dev/OB1/scripts/smoke-open-brain-running-service.sh:33), [smoke-open-brain-running-service.sh](/Users/luchoh/Dev/OB1/scripts/smoke-open-brain-running-service.sh:72), [smoke-open-brain-running-service.sh](/Users/luchoh/Dev/OB1/scripts/smoke-open-brain-running-service.sh:89). After the Phase 6 change as written, the second acceptance case is impossible unless the script gains dual-mode behavior or a second explicit entry point. One harness cannot both "only read `OB1_LEGACY_ADMIN_KEY`" and also "still pass with `MCP_ACCESS_KEY=<repo-key>`" by magic.

   Rewrite gate: choose one of three stories and write it down explicitly: legacy-admin-only smoke, dual-mode smoke with precedence rules, or separate legacy-admin and repo-key smoke harnesses.

5. **Phase 3 validates the wrong auth branch for the repo principal key.**

   Phase 3 says the per-repo service key is **not brain-bound** so the repo agent can write to both its repo brain and `agent-common`: `docs/29-agent-estate-implementation-roadmap-v3.md:427-428`. But the acceptance row then says that repo key should pass the **brain-bound-key** matrix from Phase 2a: `docs/29-agent-estate-implementation-roadmap-v3.md:438-443`. That matrix is the wrong one. The brain-bound branch is defined around `key.brain_id` and explicitly denies writes to any other brain: `docs/29-agent-estate-implementation-roadmap-v3.md:313-315`, `391-395`. The behavior Phase 3 actually wants is the non-brain-bound multi-membership branch from Phase 2c, where repo-brain defaulting and explicit `agent-common` access both work: `docs/29-agent-estate-implementation-roadmap-v3.md:397-407`.

   This is not a wording nit. If an implementer follows the acceptance literally, they either test the wrong path or accidentally brain-bind the repo key and break the common-brain write story the phase was supposed to enable.

   Rewrite gate: point Phase 3 acceptance at the non-brain-bound multi-membership matrix and add one explicit assertion that no-`brain` capture lands in the repo brain while `brain="agent-common"` still succeeds.

## Secondary Gaps

- D8 says slug resolution searches `listAccessibleBrainIds()` **exactly**, then immediately says a slug can resolve to a brain the caller cannot access and return 403: `docs/29-agent-estate-implementation-roadmap-v3.md:207-222`. Those two claims cannot both be true. Pick one resolution story.
- The phasing claims independently deployable slices, but Phase 6 explicitly depends on a Telegram wrapper change in `system-config` that this PRD does not modify: `docs/29-agent-estate-implementation-roadmap-v3.md:487-496`. That is cross-repo follow-up, not a self-contained phase.

## Recommendation

Do not implement v3 as written.

Minimum rewrite before coding:

- decide whether stored `is_admin` keys stay household-scoped or become intentionally global; do not leave D3 and D6 pulling in opposite directions;
- keep human-token sessions single-brain unless you are explicitly changing the public MCP contract;
- fix the legacy-admin enrichment/backfill path for non-default brains, or stop claiming those scripts are preserved;
- make the smoke harness contract explicit instead of half-renaming its env var and half-using it as a repo-key test;
- fix Phase 3 acceptance so it validates the non-brain-bound repo-principal path it actually provisions.
