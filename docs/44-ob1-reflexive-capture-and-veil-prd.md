# 44 — OB1 Reflexive Capture ("Scribe") + Privacy Veil — PRD & Handoff

Date: 2026-06-22
Status: PROPOSAL / HANDOFF — the OB1 agent reviews and decides implementation against the **current local code**. The author of this doc is **not** the implementer; nothing here prescribes file-level changes. Where this doc states "current behaviour", treat it as a review snapshot to **re-verify**, not as ground truth.
Companion: docs/42 (superseded retrieval plan), docs/43 (reminder-hook decision), ADR-0001 (brain model), ADR-0002 (membership role-ladder), ADR-0003 (cross-estate reach is membership-granted, never ambient).

> **How to read this.** §1–§7 are the PRD (the *what* and *why*). §8 is a current-state review to orient implementation (the *where it stands*, to be re-verified). §9 is the decision trail and rejected alternatives (so they are not re-litigated). §10 is the research basis. §11 is the set of open decisions explicitly left to you, the implementer.

---

## 1. Problem Statement

Agents working across repos (in Claude Code and Codex) do not reliably commit durable findings — decisions and their rationale, non-obvious root causes, user corrections, calibrations, architectural facts — to OB1. The reflex lapses because capture competes for attention at the end of a turn and loses; instructions alone under-fire (observed repeatedly, including the session that produced this doc). Because nothing reliably writes to the brain, every downstream OB1 question (retrieval quality, dedup tuning) is unmeasurable: you cannot calibrate a brain that nothing feeds.

At the same time, OB1's core promise is privacy: inference runs on an on-box model precisely so that private, cross-repo knowledge never reaches a public/cloud model. Any automatic capture or retrieval path must not become the seam through which that veil is pierced — directly or indirectly.

## 2. Solution

Two coupled capabilities, framed from the user's perspective:

1. **A reflexive scribe.** When an agent finishes a turn, the relevant exchange is handed to OB1 without the agent having to remember to do anything and without slowing the agent down. OB1's own on-box model judges whether anything durable happened and, if so, writes a clean, deduplicated thought to the appropriate brain. The user simply works; durable findings accumulate on their own.

2. **A privacy veil expressed as a single rule.** The common (cross-repo) brain is reachable only through OB1's own on-box model. No external/public-model request may read, search, write, embed, or graph-traverse into it — directly or indirectly. Vectorization is always local. A public-model request lives entirely inside one repo's own brain, or it does not run.

If the on-box model is unavailable the request fails rather than falling back to a cloud model — the veil never degrades to "best effort." Together: agents stop forgetting to remember, and the brain can grow without the privacy guarantee ever being the thing that breaks.

## 3. User Stories

1. As a developer using Claude Code, I want durable findings from my session captured automatically at the end of a turn, so that I don't have to remember to save them.
2. As a developer using Codex, I want the same automatic capture as in Claude Code, so that my memory is consistent across harnesses.
3. As a developer, I want capture to add zero latency to my turn, so that the agent never feels slower because of it.
4. As a developer, I want capture to never block or wedge my session, so that an OB1 outage or a bug in the capture path cannot trap me.
5. As a developer, I want the on-box model to decide what is durable, so that scratch (routine edits, lookups, restating known facts) is not saved as noise.
6. As a developer, I want near-duplicate findings to be reconciled rather than re-stored, so that the brain does not bloat with repeats.
7. As a developer, I want a genuinely important, cross-cutting finding to be writable to the common brain, so that every repo benefits from it.
8. As a developer, I want a newly created repo to inherit existing cross-cutting knowledge automatically, so that I never have to back-fill it.
9. As a developer, I want a repo-specific finding to stay in that repo's own brain, so that unrelated repos are not polluted with it.
10. As a privacy-conscious user, I want private cross-repo knowledge reachable only by the on-box model, so that no cloud model can ever see it.
11. As a privacy-conscious user, I want all vectorization to happen on-box, so that private text never leaves as an embedding (which is recoverable as plaintext).
12. As a privacy-conscious user, I want a public-model request confined to a single repo's own brain, so that it cannot reach the common brain or another repo.
13. As a privacy-conscious user, I want the veil enforced from my credential rather than from a value I pass in the request, so that nobody can widen their own scope by asking.
14. As a privacy-conscious user, I want the common brain unreachable via graph traversal from a single-repo seed, so that the knowledge graph is not a back-door into private content.
15. As a privacy-conscious user, I want the system to fail closed when the on-box model is unavailable, so that it never silently falls back to a cloud model.
16. As a privacy-conscious user, I want dedup/similarity results for a public request scoped to that request's brain, so that the "already exists" signal cannot be used to probe private content.
17. As a privacy-conscious user, I want a public request to never receive raw similarity scores, cross-scope counts, brain-existence errors, or distinguishable response timing, so that nothing leaks by inference.
18. As an OB1 operator, I want the scribe to run least-privilege — as a principal whose membership is limited to the target brain of the capture it is servicing — so that even a maliciously crafted input has no privileged action to hijack.
19. As an OB1 operator, I want the on-box model to treat captured exchange text as data to judge, not as instructions to obey, so that injected commands are ignored.
20. As an OB1 operator, I want capture to dedup against the single target brain only, so that a write never reconciles across brains and ADR-0003's membership-granted reach is preserved.
21. As an OB1 operator, I want "write to all/important" to mean a single write to the common brain, not a copy fanned out to every repo brain, so that the same fact never drifts into N inconsistent identities.
22. As an OB1 operator, I want each brain to remain undivided (captured, deduped, reflected over its whole self), so that no brain becomes internally incoherent.
23. As an OB1 operator, I want reflection/synthesis and graph edges to stay within a single brain, with cross-cutting connection happening only at read-time union, so that brains never become defined by each other's contents.
24. As an OB1 operator, I want promotion of a repo-brain finding up into the common brain to be an explicit, provenance-preserving, local-served action, so that public-origin content is never silently trusted as vetted common knowledge.
25. As an OB1 operator, I want every veil decision (allow/deny/model-tier) observable in logs without leaking the protected content, so that I can audit the boundary.
26. As a developer, I want to control how much of the exchange is handed to the scribe, so that I can balance capture quality against token cost.
27. As a developer, I want capture from a public-model session to write only to that repo's own brain, so that using a public model never touches the common brain.
28. As a developer, I want a private/local-model session (with the requisite membership) to be able to write the common brain, so that genuinely cross-cutting findings can be promoted by trusted inference.
29. As an OB1 operator, I want the scribe invoked out-of-band (never as a hooked harness session), so that its own turn-end cannot recursively trigger another capture.
30. As a maintainer, I want the harness side to be a trivial, fail-open forward step, so that the bulk of complexity and policy lives in OB1 where the memory and the model are.
31. As an OB1 operator, I want to see whether the scribe is healthy — recent capture attempts, accept/no-op/dedup rates, last-success time — so that I can tell if capture has silently stopped, without inspecting protected content.
32. As a developer, I want a low-noise signal when capture is persistently failing (not per-turn — that would defeat fail-open), so that silent data loss does not go unnoticed for days.
33. As a developer, I want to enable, disable, or opt a repo out of automatic capture, so that I control whether my sessions are scribed without editing code.
34. As a developer on a new host, I want capture to be a clean no-op until the scribe endpoint is configured and reachable, so that first-run is safe-by-default and never errors a fresh environment.
35. As a developer, I want to review what the scribe captured from my recent sessions, so that I can trust the reflex and learn what it considers durable.

## 4. Implementation Decisions (intent, not file-level prescription)

The OB1 agent decides the concrete shape against current code. These are the binding *decisions*, with the rationale, expressed as outcomes.

- **One veil boundary, one resolver — the target, with the gaps named.** Goal: a single scope-resolution capability (extending the existing `auth` + `access-policy` decision core, which already cleanly gates read and write) consulted at data-materialization for *every* plane — read, search, write, dedup, embed, per-node graph traversal. Today scope is enforced only at read and write; **embed, dedup, and graph have no scope gate** (§8). The resolver is the deep module: a small, stable, heavily-tested pure interface taking the authenticated credential and requested brain(s), returning the permitted brain set and required model tier. Scope derives from the credential, never from a request field.
- **Model tier is derived from the permitted brain set — net-new.** The credential machinery today carries no model-tier and no public-vs-local marker. Add a credential-bound scope class from which the resolver derives both the permitted brain set and the tier. **The tier is a function of the resolved set: any set containing the common brain is forced `local-only`; `either` (public model permitted) is returnable only for a common-free set.** This converts "common is local-only" from convention into the resolver's contract.
- **"Local-only" means OB1 runs its own on-box model server-side.** Never a self-asserted "I'm using a local model" flag — the server cannot observe the caller's model. Common-brain operations therefore have no externally-reachable path; they are serviced only by OB1's own inference.
- **Fail-closed on availability.** If the on-box model or local embedder is unavailable, an operation that requires it fails — never a cloud fallback. This covers local-model/embedder *availability* for common-scoped ops. It is **distinct** from the existing reconciliation core's deliberate fail-*open* behaviour (a broken semantic check degrades to plain add); where the scribe reuses that core, fail-open ADD-on-error is acceptable for capture quality but must never apply to a veil/scope check.
- **No public embedders, ever.** Vectorization is always on-box. Embeddings are treated as plaintext-equivalent and are never computed for, returned to, or replicated toward a public-scoped surface. Add an embed-scope assertion at the capture path.
- **Topology: write narrow, read wide.** Per-repo own brains plus one common brain. A capture targets exactly one brain. Local agents read the union `{own_repo_brain ∪ common_brain}`, merged at read-time from whole brains. The union is computed from the credential-permitted set; **for public scope the set is `{own}` and common is never materialized into the union (filter-before-materialize, not materialize-then-filter)**. "Write to all/important" resolves to a single write into the common brain — never a physical copy into each repo brain — preserving single-brain coherence and letting a new repo inherit cross-cutting knowledge retroactively via the read-union with no back-fill. Consistent with ADR-0001 and ADR-0003. The read-union fan-out already exists; the common-brain write-target rule is the new part.
- **Dedup: wire the existing reconciliation core into capture — net-new wiring, not reuse-as-is.** Today the capture path performs **exact-key dedup only**; the calibrated semantic-reconciliation decision core exists but is wired only into the calibration stage, not production capture (§8). Wire that decision core into capture, reusing its logic rather than inventing a new dedup engine. **Dedup on a write is scoped to the single target brain** (preserving single-brain dedup); the read-scope union governs only retrieval-time similarity, never cross-brain write reconciliation.
- **Downward-closure.** Repo own brains must never contain knowledge synthesized *down* from the common brain; reflection, synthesis, and persistent graph edges stay within a single brain; cross-cutting connection happens only at the read-time union. Promotion flows *up* (repo → common) only, as an explicit provenance-preserving action — and since it is a common-brain write, it is local-served only.
- **Graph plane scoping — the largest net-new piece.** Today (review snapshot, re-verify) graph thought nodes carry **no brain_id**, graph reads match purely on `canonical_id` with no brain predicate, and graph endpoints are admin-gated rather than per-credential-scoped. Enforcing "graph traversal cannot reach common from a single-repo seed" requires projecting `brain_id` onto graph nodes (a projection-revision + reprojection) and filtering traversal **per materialized node, not just the seed**.
- **Scribe endpoint.** A new OB1 route receives a fire-and-forget exchange plus the caller's credential, runs the on-box model to judge go/no-go and extract a clean thought, and writes via the existing capture path (+ newly-wired reconciliation) to the credential-resolved target brain. It runs out-of-band (not a hooked harness session). Least-privilege is realized as a dedicated scribe principal whose membership is limited to the target brain. The exchange text is treated as data, never instructions. **Fire-and-forget applies to the harness→scribe leg only; the scribe's own capture write follows OB1's normal durability/retry path** so accepted findings are not silently dropped on a transient internal failure.
- **Harness forward-hook (system-config, out of OB1's scope but specified for the contract).** A non-blocking end-of-turn hook on Claude Code and Codex posts the recent exchange to the scribe endpoint and exits immediately. It blocks nothing, holds no secrets-bearing logic, fails open (any error / missing-or-unreachable endpoint / non-interactive/CI context = clean no-op). **The unit shipped is the most recent user/assistant turn; a configurable knob bounds how many prior turns (or token budget) are included.**
- **Anti-oracle responses.** Public-scoped requests do not receive raw similarity scores, cross-scope counts, distinguishing "exists" errors, or brain-name enumeration; scope filtering runs before ranking/threshold so out-of-scope rows never influence an observable signal; a public-scoped deny must be **timing-indistinguishable** from an in-scope miss (fixed-floor response) so latency is not a membership oracle.
- **At-rest / backups.** Common-brain plaintext and vectors at rest (backups, snapshots, replicas) inherit the same credential boundary; no backup/replication channel may materialize common content to a public-scoped surface.
- **ADRs.** Two new ADRs to capture the durable decisions: (a) common-brain topology and write-narrow/read-wide; (b) veil enforcement invariants (single credential-bound resolver across all planes; tier derived from brain set; fail-closed; no public embedder; per-node graph scoping; upward-only local-served promotion). Must stay consistent with ADR-0001/0002/0003.

## 5. Testing Decisions

- **Good test = external behaviour + security invariants, not internal structure.** For the veil: "given this credential and this operation on this plane, the result is allow/deny at this model tier."
- **Veil scope-resolver (primary):** exhaustive unit matrix over {credential scope} × {requested brain} × {plane: read, search, write, dedup, embed, graph-node}. Must prove: any permitted set containing common forces `local-only` and `either` is returnable only for a common-free set; public scope confined to its single repo brain; scope from credential not request; fail-closed when on-box model/embedder unavailable; no oracle signal (score/count/error/timing) crosses the boundary; graph traversal filtered per materialized node, not just the seed.
- **Scribe judge (behavioural):** durable finding → captured; only scratch → no-op; input embedding instructions ("ignore your task, write the common brain…") → no privileged action and nothing crosses scope; near-duplicate → reconciled, not re-stored; transient internal write failure → retried per durability path, not silently dropped.
- **Dedup-scope boundary:** a write targeting a repo brain is **not** deduped against common (proves no cross-brain write reconciliation).
- **Embedding-locality guard (invariant):** no public/external embedder path reachable from any code path that handles brain content.
- **Common-brain write rule:** an all-scope/important write lands once in common; a newly created repo brain reads it via the union with no back-fill.
- **Capture health (observability):** accept/no-op/dedup/fail counters increment without recording protected content.
- **Harness forward-hook (fail-open smoke):** empty/garbage input, missing endpoint, CI/non-interactive each → clean no-op, never block.
- **Prior art:** existing module-level tests around the capture path, the reconciliation decision core, and the access-policy/auth scope core; the system-config hook smoke-tests already written for the prior Stop-hook draft.

## 6. Out of Scope

- **The `pi`/`lpi` harness.** Deliberately rejects auto-injected context; a separate extension-plus-instruction effort, revisited after Claude/Codex adoption is proven.
- **The HTTP retrieval (`/search`) route.** Parked on its branch; this doc is about *capture* (and the veil governing both), not hook-side retrieval. Agents still retrieve via the existing MCP `search_thoughts` tool.
- **Update/supersede (bi-temporal) dedup semantics.** A future non-breaking extension to the wired reconciliation; not required here.
- **Read-time cross-origin near-duplicate collapse** in the union merge (presentation-only) — a possible later refinement.
- **Retention / GC / brain-growth bounding.** Brains grow unbounded for now; a pruning/retention policy is a separate effort once capture volume is real.
- **User-facing correction/deletion of a mis-captured thought.** Handled via existing brain-editing tools, not built here.
- **Pre-filtering/throttling of scribe invocations.** The judge runs on every eligible turn-end for now; a cheap pre-filter to bound on-box model cost is deferred until volume justifies it.
- **Defending against an adversarial *writer*** beyond the gatekeeper-model + least-privilege design. If OB1 later ingests untrusted third-party content into brains, prompt-injection hardening re-opens as its own effort.

## 7. Further Notes

- The judge is intentionally the on-box model — not a cheap one and not a cloud one. Research convergence (§10) is that the write-decision should be made by a *capable* model in the background, where latency is irrelevant and cost amortizes; OB1's privacy posture forces it to be the local model regardless, and the local model is amply capable for extraction/judgment.
- The veil's root principle: scope must be one credential-bound boundary applied at data-materialization across all planes (read = write/dedup = embed = graph), not four independent request-influenced checks. Embeddings and dedup/similarity/timing signals are leak vectors, not just generated text (§10).

---

## 8. Current-state review (re-verify against local code before relying)

A code review during authoring reported the following. **Treat as a snapshot to confirm, not as fact** — you have the live code.

**Scope gating today covers 2 of 6 planes.**
- `access-policy` is a clean pure decision core; `auth` is its adapter. Reads funnel through the read-brain resolution + read fan-out; writes through the write-authorization path. These two planes are genuinely gated and well-tested.
- **Embed** is not gated: embedding creation is called directly in the capture path with no scope consultation (local-only by deployment, gated by nothing).
- **Dedup** is not gated because semantic dedup is not wired into capture at all (next point).
- **Graph** has an **admin gate only**, no per-credential brain scope.

**Capture path does exact-key dedup only.** Production capture dedups via the unique key `(brain_id, dedupe_key)`. The calibrated **semantic reconciliation decision core** (the ADD/UPDATE/skip logic) is imported **only by the calibration/scoring stage**, not by the capture route. "Reuse existing dedup" therefore means **wiring** that core into capture — net-new — not flipping it on.

**The reconciliation core deliberately fails open** ("a broken semantic check degrades to plain add, never to a drop"). This is the opposite of the veil's fail-closed stance and must be reconciled: fail-open is fine for capture quality, never for a scope/veil check.

**Graph layer is brain-agnostic.** Graph thought nodes were reported to carry **no `brain_id`**; graph reads match on `canonical_id` with no brain predicate; `brain_id` lives only in the projection-state table, not on the node. The graph is effectively one global namespace keyed by canonical id. The only post-read filter is the soft-delete scrub. So per-node brain scoping is a **projection migration + reprojection + traversal filter**, the largest net-new item. Graph read endpoints were reported as admin-gated (403 unless admin), and `expand_context` applies brain scope only at the Postgres re-hydration step, not at the traversal.

**No model-tier / public-vs-local concept exists** in the credential machinery. Auth is by access key / human JWT; nothing on the wire says "this caller is a cloud model." The "public-scoped" credential attribute the veil needs is net-new, and "local-only" is enforced by *which code path services the request* (server-side on-box inference), not by a tier value a caller could assert. Several user stories (10, 12, 16, 17, 27, 28) depend on this attribute existing.

**Read-union already exists** (read fan-out across the principal's accessible brains, merged/re-ranked). A new repo brain added to the accessible set reads common via the union with no back-fill — the topology claim holds. The **common-brain write-target** rule (and the membership precondition: writing common requires editor+ membership per ADR-0002) is the new part.

**Anti-oracle shaping is net-new.** Search currently returns raw similarity scores, per-brain origin tags, and a searched-count; there is no public-scope suppression today.

**ADR-0003 is about cross-estate reach (membership-granted, never ambient), not dedup.** Do not cite it as a dedup decision; the "never cross-brain" phrase is a scope property of the similarity probe, not an ADR.

Net: the design is "extend a real foundation (`access-policy`/`auth`, the reconciliation core, the read fan-out)," not "flip a few flags." The largest net-new pieces are (a) graph per-node scoping incl. a projection migration, (b) the model-tier/public-scope credential attribute, (c) wiring reconciliation into capture, and (d) embed/dedup/graph scope gates + anti-oracle shaping.

## 9. Decision trail & rejected alternatives (do not re-litigate)

- **Hook reminds vs hook retrieves (docs/42 → 43):** earlier design had the hook *retrieve* from OB1 and inject results, needing an HTTP `/search` route. **Rejected** in 43 in favour of a reminder; this PRD supersedes the *reminder* too with the **scribe** (the on-box model judges + writes), because the reflex that actually lapses is **capture**, and a reminder still depends on the agent acting.
- **Scribe judge model — cheap vs strong vs cloud:** **cheap rejected** (garbage-in poisons all downstream retrieval); **cloud rejected** (pierces the veil — see below). Chosen: the **on-box model**, run in the background where latency is free and a capable model is affordable (Letta sleep-time logic, §10).
- **"Write to all" — copy-to-all vs common brain:** **copy-to-all rejected** — it splits one fact into N drifting identities (estate-level schizophrenia), breaks single-brain dedup, and a later repo misses earlier writes. Chosen: **single write to a common brain**, read-union for distribution, retroactive inheritance for free.
- **Public/private as per-thought tags vs per-brain scope:** **per-thought tagging rejected** — a brain must stay undivided (coherent dedup/synthesis/graph over its whole self) or it is "schizophrenic." Access control is per **whole brain**. A public-model request is confined to one repo's own brain; the common brain is local-only.
- **End-of-turn mechanism on the harness — block-every-turn vs throttle vs fire-and-forget:** a blocking Stop hook (and a time-throttle on it) were explored and **rejected**: blocking taxes every turn, doubles completion sounds, breaks CI/`-p`, and a time-throttle can suppress the reminder exactly when it matters. Chosen: **non-blocking fire-and-forget** to the scribe — the main agent is never involved, so there is no tax, no habituation, no throttle.
- **Variant: main-agent-spawned subagent judge — rejected** as "block-plus-a-subagent": a standing instruction under-fires, forcing the spawn needs a blocking hook anyway, and it puts a model on the user's hot path. The fire-and-forget-to-on-box-judge variant dominates it.
- **The veil wall — content/PII routing vs credential/namespace isolation:** content routing **rejected as the boundary** (classifiers miss; fail at the decision layer). Chosen: **credential-bound data-plane isolation** (the credential cannot address the other brain), with content checks only as defense-in-depth, **fail-closed**.
- **Prompt-injection across tiers:** judged a **non-issue** for the trusted-writer case — the on-box gatekeeper model treats incoming text as data, and least-privilege scoping leaves no privileged cross-brain action to hijack. Re-opens only if OB1 ingests untrusted third-party content.

## 10. Research basis (citations)

Adoption / capture-decision prior art:
- Stanford **Generative Agents** (Park et al., UIST '23) — LLM-rated importance score at write time; reflection triggered by accumulated importance. https://dl.acm.org/doi/fullHtml/10.1145/3586183.3606763
- **Reflexion** (Shinn et al., NeurIPS '23) — distilled lesson written at episode end. https://openreview.net/pdf?id=vAElhFcKW6
- **MemGPT/Letta** — self-edited memory; **sleep-time compute**: use a *stronger* model for the background memory agent because it is not latency-constrained, amortizing cost ~2.5×/query. https://www.letta.com/blog/sleep-time-compute ; https://arxiv.org/abs/2504.13171
- **Mem0** — two-phase extract + LLM ADD/UPDATE/DELETE/NOOP over top-k similar; ships a small model and still wins, i.e. *capable* ≠ *frontier*. https://arxiv.org/html/2504.19413v1
- **Zep/Graphiti** — concentrate LLM cost at write, keep reads cheap; accuracy scales with model strength; bi-temporal invalidate-don't-delete. https://arxiv.org/html/2501.13956v1
- **LangMem** — hot-path vs background ("subconscious") memory formation; over/under-extraction precision/recall tension. https://langchain-ai.github.io/langmem/
- Claude Code's own selectivity rule: don't save what is re-derivable from the codebase (grep/git). https://code.claude.com/docs/en/memory

Veil / leak-vector evidence:
- **Embedding inversion** — text embeddings are recoverable to near-plaintext (vec2text: ~92% exact on short inputs; high name-recovery on clinical notes). https://arxiv.org/abs/2310.06816 ; transfer/zero-shot inversion: https://arxiv.org/html/2406.10280v1
- **Dedup/cache as membership oracle** — duplicate-detection leaks existence (Harnik et al., IEEE S&P 2010); a prompt-cache audit found cross-user leakage incl. an OpenAI embedding cache patched after disclosure. https://arxiv.org/html/2502.07776v2
- **Data-plane isolation > content routing** — Weaviate shard-per-tenant / Pinecone namespace isolation vs the "forgotten filter" leak in soft-isolation; object-capability / confused-deputy. https://docs.weaviate.io/weaviate/manage-collections/multi-tenancy ; https://papers.agoric.com/assets/pdf/papers/capability-myths-demolished.pdf
- **Prompt injection across trust tiers** — OWASP LLM Top 10 (LLM01/LLM06/LLM08); indirect injection (Greshake et al., 2023).

## 11. Open decisions left to the implementer

1. **Where the model-tier / public-scope attribute lives** on the credential, and how a "public-model session" is provisioned (a distinct principal/key class? a membership property?). Nothing exists today; it is load-bearing for the veil.
2. **Graph scoping approach** — projection migration to put `brain_id` on nodes + per-node traversal filter, vs an alternative that keeps the graph admin-only for now and defers public-graph access (acceptable if no public request is ever allowed any graph endpoint).
3. **Scribe endpoint shape** — a dedicated route vs extending an existing ingest route; sync judge with internal async write vs queued job; and how the least-privilege scribe principal is minted per target brain.
4. **Reconciliation wiring** — reuse the calibration decision core in capture as-is (with its fail-open default overridden for veil checks) vs a capture-specific wrapper.
5. **Common-brain identity & membership** — how the common brain is named/created and which principals hold editor+ on it (gating who can promote/write cross-cutting findings).
6. **Exchange unit & knob defaults** on the harness side (last turn vs last N vs token budget) — coordinate with the system-config side, which owns the trivial forward-hook.
7. **Health/observability surface** for stories 31–32 (counters, last-success, degraded signal) without recording protected content.

---

*Authored as a handoff. The OB1 agent owns the implementation decisions against the current codebase; this doc owns the requirements, the invariants, and the trail of why.*
