# PRD: Architecture Deepening — Thought Store, Membership Decision, Projection Planner, Capture Client, Test Harness

Date: 2026-06-11
Status: IMPLEMENTED 2026-06-12 — all five modules landed, verified, and
(runtime) deployed to prod; see Outcome at the end of this document
Owner: Runtime / Ingest / Verification
Companion: ADR-0001 (agent estate), v24 PRD (canonical agent-estate semantics),
docs/32 (thought-delete decision, D1–D9), docs/33 (thought-delete rollout runbook)

## Summary

A refactoring-and-testing PRD derived from a full architecture review
(2026-06-11). No schema changes, no new features. Behavior is preserved
except three deliberate, ADR-backed amendments to v24 semantics that came
out of the design grilling for the Access policy module (ADR-0002 role
ladder, ADR-0003 estate-bound reach and bound-key retirement — see the
module's implementation decisions). Five
modules are extracted or created so that the runtime's highest-risk invariants
— the ADR-0001 membership matrix, soft-delete invisibility, audit emission,
and graph projection — become testable through small, stable interfaces
instead of only through a fully booted server against live Postgres + Neo4j.

The review's core finding: the runtime currently has **no automated test
suite** (`npm run check` is syntax validation only). The soft-delete /
restore / purge feature (M1–M5) and multi-brain fanout landed with zero
regression coverage; the only acceptance tests are the agent-estate Python
tests hitting a live server. The architecture work below exists to make the
missing tests cheap to write — the refactors and the tests are one deliverable,
not two.

## Problem Statement

The operator maintains a personal-brain runtime that guards real privacy
boundaries: estate memberships, brain-level DENY overrides, soft-deleted
thoughts that must never resurface, and an append-only audit trail. Today,
none of these guarantees can be verified without deploying and manually
probing a live system, because:

- The Thought lifecycle (capture, soft-delete, restore, purge, metadata
  patch) is implemented as SQL embedded directly in HTTP handlers. What
  "delete a Thought" promises is discoverable only by reading CTEs.
- The ADR-0001 allow/deny decision (brain membership × estate membership ×
  DENY override) is encoded in nested SQL inside the auth module. The
  question "does estate ADMIN override brain DENY?" has no test that
  answers it.
- The invariant "a deleted Thought is invisible" is enforced by roughly ten
  separate `deleted_at` filters across three runtime files plus eight SQL
  functions, and by a graph-side scrub function invoked at seven call
  sites. Every new read path must independently remember the rule.
- The graph projection planner — the most intricate logic in the runtime
  (chat-export parsing, claim/entity extraction, artifact lineage) — is
  pure data transformation, but it is buried in a 2,500-line module coupled
  to the Neo4j driver, so it can only be exercised by running a live
  projection.
- Each ingest pipeline (Telegram, chat export, dictation, documents)
  re-implements the Capture payload, dedupe-key conventions, retry policy,
  and HTTP wrapper. The Capture contract exists only implicitly, learned
  by each pipeline separately and verified only by failing at the runtime.

The cost is concrete: features ship with manual runbook verification instead
of regression tests, every privacy-relevant change carries unbounded risk,
and both human and AI maintainers must read whole files to learn what any
one operation means.

## Solution

Extract five deep modules, each hiding a large amount of behavior behind a
small, stable interface, and write tests that cross exactly those
interfaces:

1. **Thought store** — one module owning the Thought lifecycle verbs and
   every SQL statement touching the thoughts and thought-audit tables.
   Transport handlers (HTTP routes and MCP tools) become thin adapters.
   Postgres-side soft-delete visibility lives inside this module's read
   interface.
2. **Access policy** — a pure module encoding the full v24 decision
   surface: scope derivation, selector verdicts, action authorization
   under the ADR-0002 role ladder, caller-shape rules, and read fanout.
   A small adapter fetches membership rows from Postgres; the decisions
   themselves need no database.
3. **Projection planner** — a pure function from a Thought row to a
   projection plan (nodes and edges as plain data). The graph module splits
   along its natural seams: driver/session management, graph reads (with
   soft-delete scrubbing applied at one seam), the planner, and the
   projector loop.
4. **Capture client** — one shared Python module providing payload
   construction, dedupe-key conventions, and a single retry policy for all
   ingest pipelines. Pipelines become adapters feeding sources into it.
5. **Runtime test harness** — `node:test`-based wiring so that pure-module
   tests run with no infrastructure and Thought-store tests run against a
   dedicated test database, integrated into the package scripts.

The result: the interface is the test surface. The membership matrix, the
tombstone-invisibility rule, audit emission, purge authorization, and
projection shapes all become provable in seconds, and the manual checks in
the thought-delete rollout runbook become standing regression tests.

## User Stories

1. As the operator, I want the ADR-0001 membership matrix encoded in one
   pure function with an exhaustive test, so that I can answer "who can
   touch which brain" by reading one place instead of three SQL fragments.
2. As the operator, I want a regression test proving that a brain-level
   DENY row blocks access even when an estate membership allows it, so
   that the spouse-privacy property ADR-0001 exists for is continuously
   verified.
3. As the operator, I want a test that captures a Thought, soft-deletes
   it, and re-queries search, list, similar, and ask, so that tombstone
   leaks are caught before deploy instead of by manual probing.
4. As the operator, I want purge authorization (service key + admin +
   principal identity, bare legacy key refused) verified by tests, so
   that hard erasure can never silently widen.
5. As the operator, I want tests asserting that every delete, restore, and
   purge writes exactly one audit row with correct actor attribution, so
   that the audit trail required by ADR-27 is trustworthy.
6. As the operator, I want delete and restore idempotency tested (a second
   delete reports already-deleted and adds no audit row), so that retries
   and double-clicks cannot corrupt history.
7. As an estate owner, I want membership semantics to be executable
   documentation, so that granting or denying a principal has predictable,
   provable effect before I touch production rows.
8. As a repo principal, I want Capture, search, and ask to keep their
   existing wire contracts unchanged through this refactor, so that no
   client, skill, or bridge needs to change.
9. As a runtime maintainer, I want the Thought lifecycle verbs behind one
   interface, so that adding a future surface (bulk operation, CLI) reuses
   the same verbs instead of copying CTEs.
10. As a runtime maintainer, I want transport handlers to be thin
    adapters, so that reading a handler tells me parse → authorize → call
    store, and nothing else.
11. As a runtime maintainer, I want Postgres-side deleted-thought
    filtering concentrated in the Thought store's reads, so that a new
    read path cannot forget the rule.
12. As a runtime maintainer, I want graph-side soft-delete scrubbing
    applied at a single seam through which all graph reads pass, so that
    a new graph read operation is scrubbed by construction.
13. As a runtime maintainer, I want the projection planner to take a
    Thought row and return plain node/edge data, so that I can assert on
    projection shapes in unit tests with no Neo4j.
14. As a runtime maintainer, I want the restore → re-projection path
    covered by planner-level tests, so that the M4 behavior (restored
    Thoughts reappear in the graph) cannot silently regress.
15. As a runtime maintainer, I want the graph module split into
    driver/session management, reads, planner, and projector loop, so
    that no single file requires holding 2,500 lines to change safely.
16. As a runtime maintainer, I want canonical Thought-id parsing to exist
    in exactly one place, so that the id format can evolve without a
    cross-file audit.
17. As an ingest pipeline author, I want a shared Capture client with
    payload construction and dedupe-key conventions, so that a new
    capture source gets the contract for free instead of reverse-
    engineering sibling pipelines.
18. As an ingest pipeline author, I want one retry policy in the Capture
    client, so that reliability behavior is uniform instead of two
    retries here and four with backoff there.
19. As an ingest pipeline author, I want the distilled-versus-source
    stamping centralized in the Capture client, so that the retrieval-role
    vocabulary cannot drift between pipelines.
20. As the operator, I want the Capture client to be the single place that
    grows the explicit brain parameter when ADR-0001 capture routing
    reaches the pipelines, so that the rollout touches one module, not
    five scripts.
21. As a runtime maintainer, I want a test harness with no new framework
    dependency, so that running tests is one package script and pure
    tests finish in milliseconds.
22. As a runtime maintainer, I want Thought-store tests to run against a
    dedicated test database with fixture tenants, so that tests never
    touch production brains and respect the repo's no-destructive-SQL
    guard rail.
23. As a reviewer, I want future runtime features to land with tests
    crossing the new modules' interfaces, so that the soft-delete
    pattern — six commits, zero tests — does not repeat.
24. As a coding agent working in this repo, I want modules small enough
    to read whole and named for their domain concepts, so that I can
    navigate by meaning instead of by grep.
25. As the operator, I want the manual verification steps in the
    thought-delete rollout runbook expressed as standing tests, so that
    every future deploy gets the M1–M5 safety checks without a human
    walking the runbook.
26. As a runtime maintainer, I want graph projection eval cases backed by
    fast plan-level assertions where possible, so that structural
    regressions are caught without a live-Neo4j eval run.
27. As the operator, I want every ambiguity discovered during extraction
    surfaced as an explicit question and resolved by decision (with an
    ADR when load-bearing), never silently — so that refactoring cannot
    masquerade as an accidental semantics change. (Three such decisions
    were made for the Access policy: ADR-0002 and ADR-0003.)

## Implementation Decisions

- Five modules: Thought store, Access policy, Projection planner,
  Capture client, Runtime test harness. All are extractions or additions;
  none changes wire contracts, tool names, or schema. ADR-0001 semantics
  are preserved except where ADR-0002/ADR-0003 deliberately amend them.
- **Thought store** owns the lifecycle verbs — capture/upsert, soft-delete,
  restore, purge, metadata patch, per-brain stats — and is the only module
  issuing lifecycle SQL against the thoughts and thought-audit tables.
  Ratified read-only exceptions (2026-06-12): the ANN match RPCs in the
  retrieval subsystem (tombstone-filtered in-database, migration 011) and
  the graph projector's candidate scan (a thoughts join keyed on projection
  revision + graph database — projector bookkeeping, not lifecycle). If
  literal sole-reader purity is ever wanted, the store can grow a typed
  candidate-rows reader; recorded as an option, not a commitment. Each verb
  requires an explicit brain identity in its interface (defense in depth:
  the store never infers scope). Audit emission and idempotency are
  internal guarantees of the verbs, not caller obligations. The existing
  atomic CTE approach (mutation + audit row in one statement) is preserved
  as the implementation.
- Transport (HTTP routes and MCP tool registrations) keeps its current
  surface, including the deliberate D9 asymmetry that delete/restore/purge
  are HTTP-only and never MCP tools. Handlers shrink to: validate input,
  resolve access context, call a store verb, format the response.
- **Access policy** (designed in full in the 2026-06-11 grilling session)
  owns the entire pure decision surface: scope derivation (accessible and
  lookup sets), selector resolution, action authorization, caller-shape
  rules, and read fanout. Its verdicts are data with semantic kinds —
  allow (carrying the audit actor descriptor), not-found, denied,
  ambiguous, selector-conflict — and the transport adapter owns the
  mapping to HTTP statuses. Actions are the five concrete verbs (read,
  write, delete, restore, purge); rules behind the seam may coarsen.
  A thin rows-adapter performs the fetch; the existing SQL-side scope
  queries are replaced by fetch-then-decide.
- Three deliberate semantic amendments to v24, decided with live-data
  verification and recorded as ADRs, land with this module:
  the enforced monotone role ladder (ADR-0002: viewer ⊂ editor ⊂ owner;
  estate member ⊂ admin; purge stays key-shape-gated); estate-bound
  admin-key reach with all selector resolution unified onto one scope
  path (ADR-0003: cross-estate reach is membership-granted, never
  ambient; the bare legacy key remains the only global actor for now);
  and retirement of the brain-bound-key naming clamp (key brain binding
  is a default-brain hint only). An estate membership deny row is
  treated as absent membership (fail-closed). All other v24 semantics —
  including the legacy admin key's delete/restore blast radius — are
  encoded as-is, made visible as tested decision-table rows.
- **Soft-delete visibility** is not a sixth module: on the Postgres side
  it is a property of the Thought store's read interface; on the graph
  side, all graph read operations pass through one scrubbing seam instead
  of each read invoking the scrub function itself. The SQL functions from
  the soft-delete read-path migration remain the in-database enforcement;
  the store is their only caller.
- **Projection planner**: input is a Thought row (content, metadata,
  structured columns, deleted-at); output is a projection plan — plain
  data listing nodes and edges. Tombstoned Thoughts produce a deletion
  plan. Two adapters sit at the seam: the live projector writes plans to
  Neo4j; tests assert on plans directly. The graph module splits into
  driver/session management, graph reads, the planner, and the projector
  loop; the duplicated canonical-id parsing consolidates as part of this
  split.
- **Capture client** is one Python module shared by the Telegram bridge,
  chat-export ingest, dictation import, and document import: payload
  construction (content, metadata, source, dedupe key, retrieval role,
  occurred-at), per-source dedupe-key conventions in one registry, one
  retry policy, one header/auth convention. Pipelines keep their own
  source-specific extraction and become adapters into the client. The
  client's interface is shaped to accept an explicit brain parameter when
  ADR-0001 capture routing lands, but this PRD does not add that
  parameter to the wire calls.
- **Runtime test harness** uses the Node built-in test runner — no new
  test framework dependency. Pure-module tests require no services.
  Thought-store tests require a Postgres database dedicated to tests with
  fixture estates/brains/principals, following the existing acceptance
  fixtures' naming discipline; tests never run against production data.
  The harness is wired into the package scripts alongside the existing
  syntax check.
- Rollout is incremental: each module lands with its tests in the same
  change; the existing acceptance tests and smoke scripts must pass
  before and after each step. The Access policy lands in two stages:
  first the pure module plus its full table/scenario suite with nothing
  calling it (provably inert), then the auth-module rewire carrying the
  acceptance-test extensions and an explicit list of the known behavior
  deltas (the ADR-0002/ADR-0003 amendments), verified against dev.

## Testing Decisions

- A good test crosses the module's interface and asserts external
  behavior — what the caller observes — never internal structure. Callers
  and tests cross the same seam; if a test needs to reach past the
  interface, the module is the wrong shape.
- All five modules get tests:
  - **Access policy**: two layers. An exhaustive table-driven core —
    caller shape × brain membership (none/viewer/editor/owner/deny) ×
    estate membership (none/member/admin/deny-row) × action (read,
    write, delete, restore, purge) → verdict, with expectations drawn
    from a compact decision table, never from re-implemented logic.
    Plus named scenario tests that read as executable ADR documentation
    (spouse privacy, operator visibility, deny-override, legacy blast
    radius) and carry the selector semantics (not-found vs denied vs
    ambiguous, selector conflicts). This is the smallest,
    highest-value suite in the PRD.
  - **Thought store**: against the test database — capture/dedupe
    conflict behavior; soft-delete then invisibility across every read
    verb; restore visibility; purge with strict precondition checks;
    audit-row emission with actor attribution; idempotency (repeat
    delete/restore adds no audit rows); stats excluding tombstones.
  - **Projection planner**: per-source plan shapes (chat conversation,
    email, document, dictation, claim/entity metadata); tombstone rows
    produce deletion plans; restored rows produce full re-projection
    plans; malformed metadata degrades without fabricating data.
  - **Capture client**: payload contract (required fields, metadata
    structure, retrieval-role stamping), dedupe-key conventions per
    source, retry policy behavior against a fake server.
  - **Harness itself**: proven by hosting the above; package script runs
    pure suites by default and database suites when the test database is
    configured, skipping cleanly (with an explicit skip message) when it
    is not.
- Prior art in this repo: the agent-estate acceptance tests (live-service
  HTTP tests with fixture tenants and self-skip guards) remain the
  outermost layer and the pattern for any new acceptance cases; the
  document-import state tests and telegram-review workflow tests are the
  pattern for pure unit suites; the smoke scripts remain deploy-time
  verification and are unchanged.
- The verification gaps found in the review map to suites as follows:
  tombstone leaks, purge authorization, delete/restore authorization, and
  DENY-in-fanout are covered by the membership-decision and Thought-store
  suites; projector delete/re-projection is covered at plan level by the
  planner suite, with live graph behavior remaining a runbook item until
  an integration environment exists.

## Out of Scope

- Any wire-contract, tool-name, or schema change. No migrations. Behavior
  changes beyond the three ADR-backed amendments (ADR-0002, ADR-0003).
- The household → estate rename (already tracked in CONTEXT.md / ADR-0001).
- Re-litigation of v24 decisions beyond those amendments, including D9
  (no MCP delete tools, no bulk/delete-by-query) and the legacy admin
  key's documented delete/restore blast radius (its retirement is a
  separate roadmap item, gated on provisioning a named admin key for ops).
- Retrieval ranking redesign or graph-retrieval policy tuning — owned by
  the existing eval program.
- Retry/resilience for LLM and embedding upstream calls in the runtime.
- A registration table unifying MCP tools and HTTP routes.
- CI pipeline infrastructure (runners, workflows); this PRD ends at
  locally runnable package scripts.
- New capture features (explicit brain parameter on pipeline calls,
  author-session stamping in pipelines) — the Capture client is shaped
  for them but they land with their own work.
- Live Neo4j integration tests for the projector loop (manual runbook
  verification continues until a disposable graph test environment
  exists).

## Further Notes

- Suggested sequencing: Access policy first (smallest, pure,
  highest risk reduction), then Thought store + visibility seam, then the
  graph split + planner, then the Capture client. The harness lands with
  whichever module goes first.
- This PRD deliberately pairs each refactor with its tests; landing the
  refactors without the tests reproduces the current problem with nicer
  file names.
- ADR alignment: nothing here contradicts ADR-0001; the membership
  decision module makes it executable. The D-numbered decisions in the
  thought-delete decision doc (docs/32) are preserved as written.

### Findings inventory (evidence snapshot, 2026-06-11)

Preserved from the architecture review so the rationale survives; line
numbers will drift.

- Runtime totals: ~7,800 source lines; graph module 2,504 lines; server
  module 1,593; retrieval 1,069; auth 636. `npm run check` is
  `node --check` syntax validation only — no test suite exists for the
  runtime.
- Thought lifecycle SQL embedded in transport handlers: upsert, metadata
  patch, soft-delete, restore, purge, and stats all live in the server
  module as inline SQL/CTEs.
- ADR-0001 decision logic in SQL: the accessible/lookup scope computation
  is a nested CASE across brain and estate membership tables; destructive
  authorization re-encodes owner/estate-admin rules as separate EXISTS
  checks elsewhere in the auth module.
- Soft-delete invariant scatter: ~10 `deleted_at is null` WHERE clauses
  across server, retrieval, and graph modules; 8 SQL functions in the
  read-path migration; graph-side scrub function invoked at 7 call sites
  across 4 read operations.
- Feature-landing discipline: soft-delete M1–M5 (6 commits) and
  multi-brain fanout landed with zero tests; only agent-estate v24 landed
  with acceptance tests.
- Untested CRITICAL behaviors at review time: membership DENY resolution
  (including estate-allow × brain-deny), tombstone invisibility across
  read paths, purge authorization strictness, delete/restore
  authorization, audit emission/idempotency.
- Ingest duplication: four near-identical HTTP wrappers for the capture
  endpoint; five hand-rolled payload builders; retrieval-role string
  literals stamped in 10+ locations; two divergent retry policies; DB
  connection resolution implemented three ways (asyncpg, psql subprocess,
  bash).
- Existing strengths to preserve: single access-context entry point in
  the auth module; graph retrieval policy as a real seam (default +
  file adapters) with an eval program; handlers shared between HTTP and
  MCP surfaces.

## Outcome (closeout, 2026-06-12)

All five modules landed within two days of the PRD, each in two stages
(inert module + suite, then rewire), each independently verified before
landing, with three deliberate ADR-backed semantic amendments and zero
unplanned behavior changes.

| Module | Landed as | Tests |
|--------|-----------|-------|
| 1. Access policy | `src/access-policy.mjs` + auth.mjs adapter (ADR-0002/0003) | 73 pure |
| 2. Thought store | `src/thought-store.mjs`; server.mjs −393 lines | 17 DB-backed |
| 3. Projection planner + graph split | `projection-planner` / `graph-driver` / `graph-reads` (one scrub seam) / `graph-projection`; graph.mjs 2,504 → 42-line facade | 25 pure |
| 4. Capture client | `recipes/shared_capture.py`; four pipelines became adapters | 19 + 6 equivalence (golden, proven against both old and new builders) |
| 5. Test harness | materialized along the way: `npm test` (115) + acceptance (21) + Python suite (79) | — |

Scoreboard against the problem statement: the runtime went from zero
tests to 115 in-process + 21 acceptance; the ADR-0001 permission matrix,
tombstone invisibility, audit emission, purge authorization, and
projection shapes are all provable in seconds; lifecycle SQL exists in
exactly one module; graph reads are scrubbed by construction; the
capture contract lives in one Python module. Runtime deployed to prod
2026-06-12 (docs/37; pin drift closed at system-config d9c782f) and
verified live. Pipeline changes are repo-only (not Nix-deployed) —
long-running ingest services (telegram bridge) pick them up on their
next restart; one-shot scripts on next run.

Residual items, tracked outside this PRD: legacy env key retirement
(gated on a named ops admin key); `household` → `estate` rename;
live-Neo4j projector integration environment; the store-as-sole-
thoughts-reader option recorded in Implementation Decisions.
