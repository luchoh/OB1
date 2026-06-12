# PRD: Retrieval SQL Correctness + Semantic Reconciliation at Capture

Date: 2026-06-12
Status: DRAFT — needs-triage
Owner: Runtime / Ingest / Retrieval
Companion: docs/24 (upstream port survey), docs/25 (upstream port roadmap),
docs/34 (architecture deepening — capture client, thought store, test
harness), docs/27 (thought audit log ADR), ADR-0001 (agent estate),
ADR-0002 (role ladder), ADR-0003 (estate-bound reach)

## Summary

Three sequenced work packages derived from a deep comparison against
upstream `NateBJones-Projects/OB1` `main` (2026-06-12, 78 commits ahead of
our last sync point):

1. **Migration 013 — retrieval SQL correctness.** Port the upstream
   `enhanced-thoughts` correctness fixes that apply to our migrations:
   `STABLE` markings on read-only functions, `NOT EXISTS` anti-join, and
   rank-formula coalesce defaults that match the declared column defaults.
2. **Similarity probe — measurement and threshold calibration.** A
   read-only tool that quantifies how much semantic near-duplication
   actually exists in our brains, using our embedding model. Its output is
   both the go/no-go evidence for package 3 and the calibration data for
   its thresholds.
3. **Semantic reconciliation at capture.** A flag-gated reconciliation
   stage in the capture path that classifies each incoming thought as
   `add`, `skip`, `append_evidence`, or `create_revision` against
   semantically similar existing thoughts — a reimplementation of upstream
   smart-ingest's reconciliation semantics, adapted to our local runtime
   (no merge from upstream is possible; we reimplement).

Packages 1 and 2 are unconditional. Package 3 is conditional on package 2
showing meaningful near-duplicate inflow, and ships logging-only before it
is allowed to drop anything.

## Problem Statement

The brain accumulates near-duplicate thoughts. The same fact arrives
through different ingest pipelines (Telegram capture, chat-export import,
dictation, document distillation) or through repeated capture of slightly
reworded content. Our dedupe key catches *identity* duplicates — the same
Telegram message, the same conversation record — but two thoughts that say
the same thing in different words both get stored. Over time this degrades
retrieval: search returns several variants of one fact, ask-brain context
windows fill with redundancy, and nobody knows which variant is current.

Separately, the upstream community repo fixed several correctness bugs in
the retrieval SQL that our migrations inherited or independently
reproduced: read-only functions left at default `VOLATILE` (blocking
planner optimizations), a `NOT IN (subquery)` anti-join (NULL-hazardous
pattern), and ranking-formula fallback defaults that disagree with the
declared column defaults (`importance` falls back to 5 where the column
default is 3; `quality_score` falls back to 0.50 on a 0–100 scale). These
are latent today but they are correctness debt sitting in the hottest read
path we have.

Finally: we do not actually know how bad the near-duplication problem is.
Upstream's reconciliation thresholds (skip above 0.92 cosine similarity,
reconcile in the 0.85–0.92 band) were tuned for OpenAI
`text-embedding-3-small`. We embed with a different model whose similarity
distribution is unknown to us. Adopting the feature without measuring first
risks the worst failure mode this feature has: silently discarding real
thoughts.

## Solution

From the brain owner's perspective:

- Retrieval behaves the same as today, but the SQL underneath is marked
  and structured correctly, so ranking fallbacks are consistent with the
  schema and the planner can do its job.
- A probe report tells the owner, per brain, how many thought pairs sit in
  each similarity band under our embedding model, with concrete pairs to
  eyeball — so the decision to enable reconciliation (and at which
  thresholds) is made on evidence, not on thresholds tuned for someone
  else's embedding model.
- Once enabled, capturing a thought that the brain already knows does not
  create a duplicate. If the incoming thought is an exact or near-exact
  restatement, capture succeeds but points at the existing thought. If the
  existing thought is richer, the incoming capture is attached to it as
  corroborating evidence. If the incoming thought is richer, it becomes a
  new thought that records what it supersedes. Every such decision is
  recorded in an append-only audit so nothing ever disappears
  unexplained.
- All of this is off by default and per-request opt-in capable, so the
  four production ingest pipelines keep their current behavior until the
  owner deliberately turns reconciliation on — and even then, "skip"
  starts as a logged recommendation, not a drop.

## User Stories

1. As a brain owner, I want read-only retrieval functions marked with their
   true volatility, so that the query planner can cache and optimize plans
   for my most frequent queries.
2. As a brain owner, I want the lexical-search ranking formula's fallback
   defaults to match the schema's column defaults, so that thoughts without
   explicit importance or quality scores are ranked consistently with
   thoughts that carry the default values.
3. As a maintainer, I want the anti-join in lexical search written as
   `NOT EXISTS` rather than `NOT IN (subquery)`, so that the query is
   NULL-safe by construction and survives future schema changes that might
   introduce nullable join columns.
4. As a maintainer, I want the SQL fixes delivered as a new migration
   rather than edits to historical migrations, so that already-provisioned
   databases converge to the same state as fresh installs.
5. As a brain owner, I want a measurement report of semantic
   near-duplication across my brains before any reconciliation logic
   ships, so that I can decide whether the feature is worth its risk on
   evidence rather than assumption.
6. As a brain owner, I want the probe to show me actual candidate pairs in
   each similarity band, so that I can judge with my own eyes what "0.88
   similar" means under our embedding model.
7. As a maintainer, I want the probe to derive calibrated skip/reconcile
   thresholds from our real data, so that we never inherit thresholds
   tuned for a different embedding model.
8. As a brain owner, I want the probe to be strictly read-only against the
   thoughts store, so that running it carries zero risk to my data.
9. As a brain owner, I want capture of a semantically near-identical
   thought to avoid creating a duplicate row, so that retrieval stops
   returning several variants of the same fact.
10. As a brain owner, I want a near-duplicate capture that adds nothing new
    to be recorded as corroborating evidence on the existing thought, so
    that repeated encounters with a fact strengthen it instead of
    cluttering the brain.
11. As a brain owner, I want a capture that improves on an existing thought
    to become a new thought that records which thought it supersedes, so
    that the brain converges on the best version of each fact without
    losing history.
12. As a brain owner, I want every reconciliation decision recorded in an
    append-only audit with the similarity score and reason, so that I can
    always answer "why was this capture skipped/attached/superseded?"
13. As a brain owner, I want reconciliation to be off by default and
    enabled per deployment (and overridable per request), so that nothing
    about today's production behavior changes until I opt in.
14. As a brain owner, I want skip decisions to run in a logging-only mode
    first (decision recorded, thought still stored), so that I can review
    what *would* have been dropped before allowing anything to be dropped.
15. As an ingest pipeline operator (Telegram, chat export, dictation,
    document distillation), I want capture retries to remain idempotent
    under reconciliation, so that a retried request after a 5xx never
    creates a second revision or a second evidence entry.
16. As an ingest pipeline operator, I want the capture response to state
    the reconciliation outcome (decision, matched thought, similarity), so
    that pipelines and their logs can distinguish "stored new" from
    "matched existing".
17. As a repo principal (agent) writing through the MCP tools, I want
    reconciliation decisions scoped to the brain I am writing to, so that
    similarity against thoughts in other brains or estates never
    influences — or leaks through — my capture (ADR-0003: no ambient
    cross-estate reach).
18. As a brain owner, I want a capture that fails its semantic check
    (embedding store unreachable, similarity query error) to fall back to
    plain capture rather than guessing, so that reconciliation degrades to
    today's behavior, never to data loss.
19. As a maintainer, I want the reconciliation decision logic to be a pure
    function with no database or network inside, so that its full decision
    table is testable in milliseconds.
20. As a maintainer, I want the reconciliation thresholds to be
    configuration, not constants, so that recalibration after an embedding
    model change is an operational act rather than a code change.
21. As a brain owner, I want superseded thoughts to remain readable and
    restorable, so that a wrong `create_revision` decision is recoverable
    — supersession is a link, not a delete.
22. As a maintainer, I want reconciliation to respect the existing
    role ladder (ADR-0002) — reconciliation runs only within a capture the
    caller was already authorized to make, and never mutates thoughts the
    caller could not otherwise write to.
23. As a sysadmin, I want enabling/disabling reconciliation to be a config
    change with no migration or deploy coupling, so that rollback is
    instant if production pipelines misbehave.
24. As a maintainer, I want the verification script to cover the new
    functions and tables, so that a prod bump can confirm the runtime and
    schema agree before traffic hits them.
25. As a brain owner, I want within-batch duplicates (the same fact
    extracted twice from one document import) reconciled with the same
    semantics as cross-batch duplicates, so that bulk imports do not
    self-pollute.

## Implementation Decisions

**Sequencing and gating.** Three packages, strictly ordered. Package 1
(SQL fixes) has no dependencies. Package 2 (probe) has no dependencies but
its report gates package 3: if near-duplicate inflow is negligible
(guideline: under 1–2% of recent captures with a confirmed-duplicate
band match), package 3 is shelved and this PRD is closed with the
measurement as its outcome. Package 3 additionally ships in two stages:
logging-only (all decisions recorded, all thoughts stored) and enforcing
(skip/append/revise take effect), with the promotion between them a
config change made after reviewing the logged decisions.

**Package 1 — Migration 013.** A single new migration redefines the
current (latest) versions of the read-only retrieval functions with:
`STABLE` volatility on every read-only function (semantic search, recent
listing, stats, lexical search, thought connections); the lexical-search
anti-join rewritten as `NOT EXISTS`; ranking fallbacks made consistent
with the declared column defaults (importance default 3, quality score
default 50 on a 0–100 scale). No signature changes, no behavior changes
for non-NULL data. Historical migrations are not edited.

**Package 2 — Similarity probe.** A standalone read-only script (in the
repo's scripts area, runnable against dev and prod databases) that, per
brain: samples recent thoughts, computes pairwise nearest-neighbor
similarity using the existing vector index and the brain's stored
embeddings, and emits a report with (a) the similarity distribution,
(b) counts per candidate band, (c) a reviewable sample of concrete pairs
per band, and (d) recommended skip/reconcile thresholds with the evidence
behind them. The probe must not depend on package 3 existing. Its
recommended thresholds become the initial configuration values for
package 3.

**Package 3 — Reconciler.** Three pieces:

- *Decision core.* A pure function mapping (identity-dedup outcome,
  semantic match set with similarities and content lengths, configured
  thresholds) to a decision — `add`, `skip`, `append_evidence`, or
  `create_revision` — plus a machine-readable reason. Decision semantics
  follow upstream smart-ingest: above the skip threshold the thought is a
  duplicate; in the reconcile band, the richer side wins (existing richer →
  append evidence to it; incoming richer → new thought superseding it);
  below the band it is a plain add. Failure semantics differ deliberately
  from upstream: where upstream fails closed (skip on error), we fall back
  to plain `add` with the error recorded — in a personal memory system,
  storing a duplicate is recoverable; dropping a thought is not.
- *Schema (migration 014).* A nullable supersedes link from a thought to
  the thought it replaces, and an append-only reconciliation-decision
  audit table (decision, matched thought, similarity, reason, actor,
  timestamp) following the existing thought-audit pattern. Supersession
  never deletes, hides, or mutates the superseded thought in this PRD.
- *Capture wiring.* The reconciliation stage runs inside the thought
  store's capture operation, after identity dedup resolves and before the
  insert, scoped to the target brain. It is gated by a deployment-level
  config flag (default off) with a per-request override. The capture
  response gains optional reconciliation fields (decision, matched thought
  id, similarity); the existing response contract is unchanged when the
  flag is off. Idempotency: revision rows derive their dedupe key from the
  source capture's dedupe key, so a retried request converges on the same
  revision row instead of minting a second one; evidence appends are keyed
  the same way and deduplicate on retry.

**Authorization.** Reconciliation introduces no new access semantics. It
runs only inside an already-authorized write (ADR-0002 editor or above on
the target brain), reads candidate matches only from that brain, and
writes evidence/supersedes links only to rows in that brain. ADR-0003
estate boundaries are untouched.

**Embedding contract.** The reconciler uses the embedding already computed
by the capture path — no additional model calls. The 1536-dimension
contract is unchanged. If the embedding model ever changes, the probe is
re-run and thresholds recalibrated before reconciliation is re-enabled;
this is recorded as an operational rule, not enforced in code.

**What we deliberately do not port from upstream smart-ingest.** The
document→atomic-thoughts LLM extractor, the ingestion jobs/items ledger,
the dry-run HTTP job API, and the Edge-Function budget machinery. Our
module-4 capture client and pipeline adapters already own extraction and
transport; logging-only mode covers the dry-run need; our caps live in the
pipelines.

## Testing Decisions

A good test asserts externally observable behavior through a stable
interface — what a caller can see — never the internals that produce it.
Prior art in this repo: the access-policy decision-table suite (pure,
exhaustive over the input matrix, no I/O) and the thought-store suite
(DB-backed against the dev database, fixture-prefixed, audit-asserting).

All four modules get tests:

- *Reconciler decision core* — pure decision-table tests covering the full
  matrix: identity-dedup hit, no semantic match, match above skip
  threshold, match in the reconcile band with existing richer / incoming
  richer / equal lengths, match below band, empty embedding, similarity
  lookup failure (must yield `add` with error reason), and threshold
  boundary values. This is the risky logic and gets the most cases.
- *Capture wiring* — DB-backed tests in the existing thought-store suite:
  flag off ⇒ byte-identical behavior to today (regression guard for the
  four production pipelines); flag on ⇒ each decision path verified
  end-to-end including the audit row, the supersedes link, evidence
  attachment, and retry idempotency (same request twice ⇒ one outcome).
- *Migration 013 functions* — DB-backed assertions that the redefined
  functions return results identical to the previous definitions on
  fixture data, carry the expected volatility markings in the catalog, and
  that the rank formula treats explicit-default and absent values
  identically.
- *Similarity probe* — unit tests for sampling, banding, and report
  generation with injected data; one DB-backed smoke test that it runs
  read-only (no writes observed) against the dev database.

## Out of Scope

- **Retrieval handling of superseded thoughts** (down-ranking or filtering
  them in search/ask paths). Without it, supersession is recorded but not
  yet exploited; it is the natural phase 2 once reconciliation data
  exists.
- **Graph projection of supersession** (a SUPERSEDES edge in Neo4j and its
  planner support).
- **Backfill reconciliation of existing thoughts** — this PRD only
  reconciles new captures; deduplicating the historical corpus is a
  separate effort that the probe report will size.
- **Porting upstream's document extraction, ingestion-job ledger, or
  dry-run job API** (covered by existing module-4 pipelines and
  logging-only mode).
- **Any change to the embedding model or dimension contract.**
- **Cross-brain or cross-estate reconciliation** — explicitly forbidden,
  not deferred (ADR-0003).
- **Editing historical migrations.**

## Further Notes

- Upstream evidence base: smart-ingest reconciliation engine and
  enhanced-thoughts fixes on `NateBJones-Projects/OB1` `main` at the time
  of the 2026-06-12 comparison. The `upstream` remote is configured in the
  working repo for future reference. Upstream's thresholds (0.92 skip /
  0.85 reconcile) are for a different embedding model and are explicitly
  *not* adopted as defaults; the probe decides ours.
- Upstream's richness heuristic is raw content length. We adopt it
  initially for fidelity and simplicity; if logged decisions show it
  misjudging, replacing the heuristic is a decision-core-only change.
- The reconciliation audit table deliberately mirrors the thought-audit
  design (docs/27): append-only, trigger-protected, queryable per brain.
- Risk register: (a) threshold miscalibration → mitigated by probe-first
  sequencing, logging-only stage, and add-on-error semantics; (b) capture
  path regression → mitigated by default-off flag and the flag-off
  regression suite; (c) retry double-writes → mitigated by derived dedupe
  keys for revisions and evidence; (d) latency — one indexed similarity
  query per capture, negligible against the embedding call already in the
  path.
