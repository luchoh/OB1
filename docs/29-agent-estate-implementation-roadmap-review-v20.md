# Review: Agent Estate Implementation Roadmap v20

Date: 2026-06-03
Reviewed doc: `docs/29-agent-estate-implementation-roadmap-v20.md`
Verdict: Best version so far. Still reject as written.

## Zoom-Out

- The live runtime still resolves tenancy up front into one request-scoped `accessContext` in [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:367). For legacy-admin, that currently becomes a single `effectiveBrainId` in [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:336).
- Handler surfaces then just consume that bound brain. MCP tool registration lives in [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:889), and the read/write/admin HTTP routes dispatch through the same `accessContext` in [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:1063).
- v20 is materially better because it finally centralizes the pipeline order and inlines most of Phase 3. The remaining failures are at the precise seam that has been unstable all along: how selector normalization interacts with failure classes, and whether the doc is actually self-contained enough to implement without cross-reading old versions.

## Findings

1. **v20 makes the legacy-admin mismatch-`400` rows unreachable, because D8 still returns `403` before D7a gets a chance to emit `400`.**

   D7a says a legacy-admin body/tool-arg `brain` that resolves to a different UUID than `effectiveBrainForLegacyAdmin` must return `400` in [roadmap v20](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v20.md:126). D19 then fixes the order: Step 3 runs D8 normalization first, and Step 5 runs the D7a equality check later in [roadmap v20](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v20.md:229) and [roadmap v20](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v20.md:244). The problem is that D8 is still defined as a lookup **plus** `checkBrainAccess({mode:'read'})`, returning `403` on lookup-hit-but-denied in [roadmap v20](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v20.md:157).

   For legacy-admin, D6 case 1 allows only `brainId == effectiveBrainForLegacyAdmin` in [roadmap v20](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v20.md:89). So take the simplest explicit-mismatch case: no L1 selector, legacy-admin default brain = A, body/tool-arg `brain` points to existing brain B. Step 3 resolves B globally, then D8's embedded read check compares B against `effectiveBrainForLegacyAdmin` and returns `403` before Step 5 ever runs. But the acceptance tables expect `400` for exactly that case in capture, metadata patch, search, `/ask`, and `/admin/thought/similar` in [roadmap v20](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v20.md:387), [roadmap v20](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v20.md:416), [roadmap v20](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v20.md:438), [roadmap v20](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v20.md:485), and [roadmap v20](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v20.md:502).

   So the doc still has two incompatible failure classes for the same request. This time it is not because D19 and Phase 3 disagree on order. It is because D19's new order is incompatible with D8's unchanged behavior.

2. **The acceptance tables still collapse slug and UUID cases even though D8 assigns different statuses to them, so multiple `404` rows are wrong or under-specified.**

   v20 explicitly says the new `brain` field is a `z.string()` carrying a slug or UUID in the Phase 3 plumbing checklist in [roadmap v20](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v20.md:332). D19 Step 3 also treats slug and UUID as distinct normalization paths in [roadmap v20](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v20.md:229). D8 then assigns different failure classes: slug not found in lookup scope can be `404`, while an existing but inaccessible UUID is `403` in [roadmap v20](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v20.md:157) and [roadmap v20](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v20.md:163). The `/admin/thought/access-check` table even gets this right by splitting slug and UUID rows in [roadmap v20](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v20.md:520).

   But other acceptance tables do not. They use one placeholder row and pin it to `404`, for example `service_key, is_admin` with `<in-OTHER-household>` and `service_key, brain-bound` with `<other>` in capture and `search_thoughts` in [roadmap v20](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v20.md:391), [roadmap v20](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v20.md:393), [roadmap v20](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v20.md:441), and [roadmap v20](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v20.md:443). Those rows are only true for slug inputs outside lookup scope. If the caller passes the UUID of an existing but inaccessible brain, D8 says `403`, not `404`.

   That means the doc still does not give a stable exact status contract for explicit `brain` inputs. It just moved the ambiguity from "which layer wins?" to "which input shape did the author mean?"

## Secondary Gaps

- **v20 still is not fully self-contained, despite saying it genuinely supersedes v1-v19.** The headline claim is at [roadmap v20](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v20.md:9). But Phase 2 still says the implementation order and acceptance matrix from v15/v17/v18/v19 stand, and tells the reader to see those docs for the full rows in [roadmap v20](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v20.md:313). That is better than v19 because Phase 3 is inlined, but the doc still is not honestly standalone.

## Recommendation

Do not implement v20 as written.

Minimum rewrite before coding:

- Fix the legacy-admin pipeline by choosing one of two real options:
  - change D8 so Step 3 is normalize-only for legacy-admin and does not run the read-access check before Step 5, or
  - keep D8 unchanged and admit that legacy-admin explicit-mismatch requests return `403`, not `400`.
- Split every explicit-`brain` acceptance row that depends on D8 into slug and UUID cases wherever the statuses diverge.
- Remove the "genuinely self-contained" claim unless Phase 2 acceptance is also inlined into v20.
