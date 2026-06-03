# Review: Agent Estate Implementation Roadmap v10

Date: 2026-06-03
Reviewed doc: `docs/29-agent-estate-implementation-roadmap-v10.md`
Verdict: Best version so far. Still reject as written.

## Zoom-Out

- The load-bearing seams are still [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:227), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:566), and the unchanged D8 slug-vs-UUID contract [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:246).
- v10 did fix the two real v9 bugs. It now makes `/admin/thought/metadata` run `mode='edit'` on the no-body path too [roadmap v10](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v10.md:82), and it restores the stored-admin household-wide L1 carve-out [roadmap v10](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v10.md:149).
- The remaining problem is smaller but still blocking: the roadmap still cannot decide whether an inaccessible slug on an L1 selector is a hidden `404` or a disclosed `403`. D8 says one thing. The merged Phase 2 matrix still says both.

## Findings

1. **Phase 2 still contradicts unchanged D8 on inaccessible-slug status codes, so the L1 selector contract is not actually settled.**

   v10 says D8 is unchanged [roadmap v10](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v10.md:127). The spelled-out D8 contract is still: `resolveBrainSlug` returns UUID, `404`, or `409`, and a slug not in the accessible set is `404`; only UUID-not-in-accessible-set is `403` [roadmap v7](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v7.md:246). That matters because the live L1 selectors are slugs: query `brain` and header `x-brain-slug` are both read as slug strings in [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:227).

   D17 then defines per-auth-source accessible-brain sets for L1 authorization [roadmap v10](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v10.md:149). But the merged Phase 2 matrix still assigns `403` to multiple query-slug cases that are exactly "slug not in accessible set": `service_key, is_admin` with `?brain=<in-OTHER-household>` [roadmap v10](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v10.md:248), `service_key, brain-bound` with `?brain=<other>` [roadmap v10](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v10.md:250), `service_key, non-brain-bound, estate-only` with `?brain=<brain-in-OTHER-estate>` [roadmap v10](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v10.md:253), and `brain-deny + estate-allow` with `?brain=<denied-brain>` [roadmap v10](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v10.md:255). The same table then says any non-legacy `?brain=<slug-not-in-accessible>` should be `404` [roadmap v10](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v10.md:256).

   That is not a minor wording slip. It is the public contract for the same selector mechanism. Brain-bound `?brain=<other>` is, by D17's own table, a slug outside the accessible set `[key.brain_id]` [roadmap v10](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v10.md:157). Estate-only `?brain=<brain-in-OTHER-estate>` is the same. Brain-deny overriding estate-allow is the same. v10 still asks the implementer to return both `403` and `404` for the same class of slug selector failure.

   The current runtime is already split here, which is why the doc needed to clean it up instead of mirror it. Stored-key slug lookup first does a household-scoped slug resolution and returns `404` on miss [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:291), but a brain-bound mismatch after resolution returns `403` [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:299). v10 claims D8 is unchanged while also preserving parts of the live branch behavior. It still has not chosen one rule.

   Rewrite gate: pick one slug-selector contract and make D8, D17, and the Phase 2 matrix say the same thing. If L1 slug selectors follow D8, then all inaccessible-slug cases above become `404`. If the roadmap wants branch-specific `403` disclosure, then D8 is not unchanged and must be rewritten explicitly.

## Secondary Gaps

- **The new "L4 always runs on write surfaces" rule is only canon-tested for metadata, not for capture.** D7 now generalizes the seam fix to every write surface: `/admin/thought/metadata` uses `mode='edit'`, and `/ingest/thought` / `capture_thought` use `mode='write'` every time [roadmap v10](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v10.md:92). But Phase 3 only adds new closure tests for metadata [roadmap v10](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v10.md:299), while the capture path is still just "same as v9" [roadmap v10](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v10.md:271). The live `handleCaptureThought()` still blindly writes to `accessContext.effectiveBrainId` [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:312). If an implementer patches metadata correctly but forgets the same L4 gate on capture, the current acceptance set may not catch it.

## Recommendation

Do not implement v10 as written.

Minimum rewrite before coding:

- Unify the L1 slug-selector status contract. Right now D8 says inaccessible slug = `404`, while the merged Phase 2 matrix still hard-codes several `403` rows for inaccessible slugs.
- Add one capture-path closure test mirroring Finding 1: a principal with read-only estate access binds `?brain=<target>` and omits body `brain` on `/ingest/thought`, and the request must fail `mode='write'` rather than silently writing to `effectiveBrainId`.
