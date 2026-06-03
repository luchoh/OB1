# Review: Agent Estate Implementation Roadmap v19

Date: 2026-06-03
Reviewed doc: `docs/29-agent-estate-implementation-roadmap-v19.md`
Verdict: Best version so far. Still reject as written.

## Zoom-Out

- The live runtime still resolves tenancy up front into one request-scoped `accessContext` in [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:367). For legacy-admin, that currently becomes a single `effectiveBrainId` in [auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs:336).
- The read handlers and MCP tools then just consume that resolved brain in [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:360), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:426), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:663), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:694), [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:707), and the MCP registrations in [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:895).
- So the roadmap's real job is still boring and unforgiving: keep selector admissibility, selector normalization, and access checks in one coherent order, and keep the acceptance contract self-contained enough that implementers do not have to reverse-engineer it from older versions. v19 is cleaner, but it still slips on both points.

## Findings

1. **v19 still contains a legacy-admin ordering contradiction: D19 says apply D7a before D8, while Phase 3 requires D8 normalization first.**

   D7a's new legacy-admin contract says body/tool-arg `brain` must match `effectiveBrainForLegacyAdmin` or the request returns `400` in [roadmap v19](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v19.md:97). D19 then makes that ordering explicit: selector admissibility first, **D7a if legacy-admin**, **D8 next**, D6 last in [roadmap v19](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v19.md:184).

   Phase 3 says something else. The new schemas admit `brain` as an optional `z.string()` carrying a **slug or UUID** in [roadmap v19](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v19.md:214). The handler checklist then says `parse args.brain -> resolve via D8 -> ... Apply D7a for legacy-admin` in [roadmap v19](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v19.md:246).

   Those are not equivalent. Example: legacy-admin request with L1 selecting `ob1`, and body/tool-arg `brain` carrying the UUID of that same brain. Under D19's order, D7a has to decide match vs mismatch **before** slug/UUID normalization. Under the handler checklist's order, D8 normalizes first and D7a compares canonical values after that. One path can reject the request as malformed `400`; the other can accept it as a redundant confirmation. That is exactly the kind of failure-class drift these docs keep creating.

   Rewrite gate: pick one canonical order and state it once. The defensible order is `D2/D9 admissibility -> D8 normalize explicit selector -> D7a canonical-ID equality check for legacy-admin -> D6 access`. Right now the doc says both.

2. **v19 still is not a self-contained superseding roadmap; it imports whole acceptance sections from v18 and v17, recreating the same drift path it claims to remove.**

   The front matter says v19 "Supersedes: v1-v18" in [roadmap v19](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v19.md:9). The pitch says "One canonical place per topic" and "Other sections reference that topic by D-number instead of restating its rule" in [roadmap v19](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v19.md:33).

   Phase 3 does not actually do that. It says the MCP read tables are the "same tables as v18" in [roadmap v19](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v19.md:275), `/ask` acceptance is unchanged from v18 in [roadmap v19](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v19.md:296), and capture/metadata are unchanged from v17 in [roadmap v19](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v19.md:269). The inherited v17 sections then punt further back to v15/v16 in [roadmap v17](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v17.md:158), [roadmap v17](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v17.md:204), and [roadmap v17](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v17.md:231).

   That is still a transitive contract, not a superseding one. The reader has to pull older docs and mentally patch them with D7a. Which is funny, since the whole stated problem is "the same rule is repeated in multiple sections with subtle drift." v19 reduces the drift on-page and then reintroduces it off-page.

## Secondary Gaps

- **The new plumbing checklist still misstates what is already landed.** It marks `captureThoughtSchema` and `updateThoughtMetadataSchema` as "already done in commit `b8ef895`" in [roadmap v19](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v19.md:213) and [roadmap v19](/Users/luchoh/Dev/OB1/docs/29-agent-estate-implementation-roadmap-v19.md:217). In the current runtime, neither schema has a `brain` field in [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:29) and [server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs:66). I also checked `git show b8ef895 -- local/open-brain-mcp/src/server.mjs`; that commit adds structured metadata patch columns, not selector support. So the checklist is better than v18, but it is still not authoritative enough to use as a gate without manual re-verification.

## Recommendation

Do not implement v19 as written.

Minimum rewrite before coding:

- Align D19 and Phase 3 on one legacy-admin pipeline. If D7a compares canonical brain identity, D8 has to run before it.
- Make v19 self-contained. Inline the actual Phase 3 acceptance tables it claims to supersede, or stop calling it a superseding roadmap and frame it honestly as a delta against v18/v17.
- Fix the plumbing checklist's done/not-done status so it reflects the current branch instead of an aspirational reading of `b8ef895`.
