# PRD: OB1 Retrieval Observability And Policy Governance

Date: 2026-04-01
Status: Implemented on feature branch
Owner: Retrieval / Runtime / Memory Quality

## Summary

Add a local-only observability and governance layer around OB1 retrieval so policy changes are measurable, reviewable, and auditable without changing the canonical memory architecture.

The target outcome is:

- retrieval events are visible in append-only local logs
- graph retrieval policy revisions are recorded with provenance
- candidate policy changes can be evaluated offline against fixed OB1 cases
- operators can improve retrieval quality without silent heuristic drift

This is a runtime and evaluation proposal only.
It is **not** a proposal to add agent proxies, client interception, auto-wiring, plugin ecosystems, or third-party client integrations.

## Problem

OB1 already has meaningful retrieval structure:

- PostgreSQL remains canonical storage
- retrieval is brain-scoped
- graph-assisted retrieval is policy-driven
- the graph retrieval policy is already a mutable artifact
- retrieval quality can already be evaluated with fixed case sets

Current gaps:

- policy edits are weakly audited
- retrieval behavior is only partially visible after the fact
- there is no append-only operator trail for why a policy changed
- there is no small governance loop connecting:
  - live retrieval behavior
  - policy revisions
  - offline evaluation

That means retrieval quality work is still too dependent on:

- manual experimentation
- ad hoc terminal history
- human memory of what changed

In a secure local environment, that is the wrong tradeoff.
We need stronger traceability without adding invasive new runtime surfaces.

## Goals

- Make retrieval behavior inspectable with local-only append-only telemetry.
- Make graph retrieval policy changes auditable with revision history.
- Provide a disciplined offline evaluation loop for candidate policy changes.
- Preserve the current canonical architecture:
  - PostgreSQL canonical
  - Neo4j derived
  - local embedding service canonical
  - local inference service canonical
- Keep all observability artifacts local to the runtime host.
- Minimize operational complexity.
- Make it easy to disable or reduce logging if a deployment has stricter privacy requirements.

## Non-Goals

- Adding OpenClaw, Claude Desktop, ChatGPT, or any other client integration
- Agent proxying or prompt interception
- Background RL, model fine-tuning, or scheduled training
- Replacing PostgreSQL with a sidecar memory store
- Introducing a second canonical retrieval engine
- Logging full raw prompts by default
- Adding a new external service for observability
- Adding a new always-on daemon beyond the existing OB1 runtime

## Product Position

This feature is not "memory evolution in the wild."

It is:

- retrieval observability
- policy governance
- evaluation discipline

The product value is operational confidence, not automation theater.

After this ships, an operator should be able to answer:

- what retrieval strategy was active when this answer was produced?
- what policy revision introduced this scoring behavior?
- did the new policy actually improve fixed-case evaluation?
- did graph-assisted retrieval help or hurt on the questions we care about?

without guessing.

## Open Brain Alignment

This proposal fits Open Brain because it strengthens the system OB1 already is:

- a grounded memory runtime
- a canonical local storage layer
- a provenance-first retrieval system

It does **not** try to turn OB1 into:

- an agent shell
- a universal plugin host
- a hidden man-in-the-middle for client traffic

The memory and retrieval logic stays inside OB1.
Observability is added around that logic, not around external agents.

## Current-State Baseline

Relevant existing pieces:

- local runtime and HTTP surface in [local/open-brain-mcp/README.md](/Users/luchoh/Dev/OB1/local/open-brain-mcp/README.md)
- graph retrieval policy artifact in [local/open-brain-mcp/src/graph-retrieval-policy.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/graph-retrieval-policy.mjs)
- graph-assisted retrieval logic in [local/open-brain-mcp/src/retrieval.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/retrieval.mjs)
- graph retrieval evaluator in [local/open-brain-mcp/evals/eval-graph-retrieval.py](/Users/luchoh/Dev/OB1/local/open-brain-mcp/evals/eval-graph-retrieval.py)
- multibrain enforcement in [local/open-brain-mcp/migrations/005_household_multitenancy.sql](/Users/luchoh/Dev/OB1/local/open-brain-mcp/migrations/005_household_multitenancy.sql)

This proposal should build directly on those pieces.

## Core Decisions

### 1. Observability artifacts are local append-only files

Do not add Redis, Kafka, OpenTelemetry collectors, or external logging services.

Use local append-only JSONL artifacts for:

- retrieval telemetry
- policy revision history
- optional evaluation reports

Reason:

- consistent with secure local deployment
- operationally simple
- easy to inspect with standard shell tools
- easy to back up or rotate

### 2. Policy remains a human-owned artifact

The graph retrieval policy file remains the mutable source artifact.

Do not allow runtime self-modification of the active policy in v1.

Reason:

- auditability matters more than autonomy
- reviewable edits are safer than hidden heuristics
- OB1 already has a working artifact-and-eval pattern

### 3. Telemetry defaults to low-sensitivity payloads

By default, retrieval telemetry should prefer:

- query hash
- query length
- short preview or redacted preview
- result ids
- counts
- policy version
- retrieval strategy

Do not default to storing full raw questions or full evidence text.

Reason:

- secure environment
- lower leakage risk
- enough information for tuning without full content capture

### 4. Offline evaluation remains the promotion gate

A candidate policy should be considered better only if it improves fixed evaluation cases.

Live telemetry can suggest where to investigate.
It should not, by itself, auto-promote policy changes.

Reason:

- telemetry is descriptive, not authoritative
- fixed evaluation prevents regression theater
- deterministic replay is easier to review

### 5. Brain isolation remains mandatory

Any retrieval telemetry must stay brain-aware.

Telemetry records must include the active `brain_id` or equivalent scoped identifier.
They must never merge retrieval behavior across brains by accident.

Reason:

- OB1 already uses `brain_id` as the storage and retrieval boundary
- observability that crosses those boundaries would create an audit bug

## Security Constraints

These constraints are mandatory, not advisory.

### 1. No client interception

Do not add:

- transparent agent proxies
- client auto-wiring
- prompt interception layers
- shell hooks that silently redirect LLM traffic

Any future client integration, if ever proposed, must be a separate PRD and explicit user decision.

### 2. No new public network surface by default

This proposal should not require:

- new public ports
- new reverse-proxy routes
- inbound webhooks
- external dashboards

Preferred model:

- existing OB1 runtime process
- local filesystem artifacts
- offline evaluation commands

### 3. No raw secret capture

Telemetry must never record:

- access keys
- bearer tokens
- auth headers
- upstream credentials
- environment variable values

### 4. No raw evidence capture by default

Do not log:

- full evidence excerpts
- full retrieved row content
- full question text

unless an operator explicitly enables a higher-detail mode for local debugging.

### 5. Explicit retention and rotation

Telemetry files must be:

- local
- documented
- safe to rotate
- non-canonical

No product logic should depend on old telemetry files remaining forever.

### 6. No silent policy activation

A new policy revision must only become active through an explicit file edit or equivalent explicit operator action.

Offline eval may recommend a policy.
It must not silently activate one.

## Proposed Scope

### Scope A: Retrieval Telemetry

Add append-only JSONL records for:

- `search_thoughts`
- `ask_brain`
- graph expansion within graph-assisted retrieval
- optional `expand_context`

Each record should capture:

- timestamp
- event type
- auth source class
- `brain_id`
- requested brain slug if present
- retrieval strategy
- graph-assisted flag
- graph policy version if applicable
- query hash
- query preview policy mode
- query length
- threshold
- requested count
- returned count
- fallback usage
- selected result ids
- selected result retrieval roles
- graph added ids
- graph hop limit
- elapsed milliseconds
- success or error

### Scope B: Policy Revision History

Add append-only policy revision history whenever the graph retrieval policy artifact changes.

Each revision record should capture:

- timestamp
- policy file path
- policy version field
- stable hash of normalized policy JSON
- optional operator-supplied reason
- full normalized policy payload

### Scope C: Offline Evaluation Loop

Add a simple policy governance workflow:

1. edit candidate policy JSON
2. run fixed evaluator against current cases
3. compare baseline vs candidate
4. keep candidate only if it improves agreed metrics
5. record the accepted revision

This should remain command-line-driven in v1.

### Scope D: Operator Documentation

Document:

- where artifacts live
- how to inspect them
- how to rotate them
- how to compare policy revisions
- how to run candidate evaluation

## Event Schema

### Retrieval Event

Suggested JSONL schema:

```json
{
  "timestamp": "2026-04-01T18:30:00Z",
  "event_type": "ask_brain_retrieval",
  "payload": {
    "auth_source": "service_key",
    "brain_id": "00000000-0000-0000-0000-000000000000",
    "brain_slug": "lucho",
    "query_sha256": "abc123...",
    "query_preview": "What did I decide about...",
    "query_preview_mode": "truncated",
    "query_length": 41,
    "retrieval_strategy": "distilled-first",
    "fallback_used": true,
    "graph_assisted": true,
    "graph_policy_version": 1,
    "match_threshold": 0.4,
    "requested_count": 6,
    "returned_count": 6,
    "result_ids": [
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222"
    ],
    "result_retrieval_roles": [
      "distilled",
      "source"
    ],
    "graph_added_ids": [
      "33333333-3333-3333-3333-333333333333"
    ],
    "graph_max_hops": 2,
    "elapsed_ms": 182,
    "success": true
  }
}
```

### Policy Revision Event

Suggested JSONL schema:

```json
{
  "timestamp": "2026-04-01T18:40:00Z",
  "event_type": "graph_retrieval_policy_revision",
  "policy_hash": "def456...",
  "policy_path": "/path/to/graph-retrieval-policy.json",
  "policy_version": 1,
  "reason": "increase entity exact-match bonus after holdout failures",
  "policy": {
    "version": 1,
    "default_max_hops": 2,
    "default_added_rows": 6,
    "ranking": {
      "entity_anchor_exact_bonus": 180
    }
  }
}
```

### Evaluation Report

Suggested report shape:

```json
{
  "timestamp": "2026-04-01T18:45:00Z",
  "baseline_policy_hash": "aaa...",
  "candidate_policy_hash": "bbb...",
  "case_count": 24,
  "mean_score_baseline": 0.71,
  "mean_score_candidate": 0.78,
  "accepted_cases_baseline": 15,
  "accepted_cases_candidate": 19,
  "decision": "candidate_better",
  "notes": [
    "Improved exact entity match behavior",
    "No regression in source-lineage questions"
  ]
}
```

## Data Location

Recommended local-only artifact directory:

- `local/open-brain-mcp/.runtime/`

Initial files:

- `local/open-brain-mcp/.runtime/retrieval-events.jsonl`
- `local/open-brain-mcp/.runtime/graph-retrieval-policy.history.jsonl`
- optional generated evaluation reports under:
  - `local/open-brain-mcp/.runtime/evals/`

These artifacts are:

- runtime-local
- non-canonical
- safe to delete after rotation
- not a replacement for stored thoughts or graph projection state

They should remain ignored by git.

## Runtime Behavior

### Telemetry Write Path

For each eligible retrieval operation:

1. resolve access context
2. execute retrieval
3. build a low-sensitivity event payload
4. append one JSONL record
5. return normal response

Failure rule:

- telemetry failure must not break retrieval
- it should log locally and degrade open

Reason:

- observability must not become a production dependency for core recall

### Policy Revision Detection

When the graph retrieval policy is loaded:

1. normalize the policy object
2. compute stable hash
3. compare with last recorded hash
4. if changed, append one revision record

This gives revision history without introducing a separate policy database.

## Evaluation Workflow

### Baseline Workflow

1. operator edits candidate graph retrieval policy JSON
2. operator runs the fixed evaluator
3. evaluator produces comparable summary output
4. operator decides whether to keep the candidate
5. accepted policy remains the active artifact

### Evaluation Inputs

Use existing OB1 assets first:

- current graph retrieval evaluator
- current graph retrieval case set
- current ask-brain A/B evaluation assets where relevant

If new cases are needed, they should be added as explicit repo artifacts, not hidden ad hoc samples.

### Promotion Rule

In v1, policy promotion remains manual.

A candidate should only be accepted if:

- it improves the agreed score
- it does not introduce obvious regressions on accepted cases
- the change rationale is understandable

## Rollout Phases

### Phase 1: Append-Only Policy History

Add:

- local policy revision history file
- stable hash normalization
- operator docs for inspection and rotation

Success criteria:

- policy changes produce an auditable local revision trail
- no behavior change to retrieval itself

### Phase 2: Low-Sensitivity Retrieval Telemetry

Add:

- append-only retrieval JSONL events
- logging for `search_thoughts`
- logging for `ask_brain`
- logging for graph expansion metadata

Success criteria:

- operators can inspect real retrieval behavior locally
- telemetry does not expose secrets
- telemetry does not block retrieval on write failure

### Phase 3: Offline Governance Workflow

Add:

- a documented compare-and-keep workflow
- optional report output for baseline vs candidate policy
- documentation for review expectations

Success criteria:

- policy tuning becomes repeatable
- accepted changes are tied to explicit reports

### Phase 4: Tighten Case Coverage

Add or refine eval cases for:

- source-lineage retrieval
- graph expansion precision
- decision/preference questions
- scoped answer correctness

Success criteria:

- policy changes are judged against product-relevant failure modes

## Acceptance Criteria

- A local operator can see a history of graph retrieval policy revisions.
- A local operator can inspect retrieval telemetry without reading application source.
- Retrieval telemetry is brain-scoped and does not merge activity across brains.
- Telemetry does not record secrets.
- Telemetry failure does not fail user retrieval.
- Policy governance remains explicit and manual in v1.
- No new public service or client integration is required.

## Risks

- even truncated query previews may still expose sensitive context
- append-only files can grow without rotation discipline
- operators may overfit policies to the current case set
- telemetry volume may become noisy if every retrieval path logs too much detail
- teams may mistake observability artifacts for canonical memory data

## Mitigations

- make raw-query logging opt-in, not default
- support easy rotation and document it
- keep evaluation on fixed cases, not telemetry anecdotes
- prefer one event per high-level retrieval operation
- document clearly that runtime JSONL artifacts are non-canonical

## Open Questions

- should query preview default to `none`, `hashed_only`, or `truncated`?
- should telemetry be fully disabled by default on the stable public service and enabled only for local development?
- should evaluation reports live in `.runtime/evals/` or be written only when an explicit output path is provided?
- should policy revision reasons be passed through an env var, a CLI flag, or remain optional in v1?

## Recommendation

Proceed with:

- Phase 1 policy history
- Phase 2 low-sensitivity retrieval telemetry
- Phase 3 documented offline governance

Do **not** expand scope into:

- client integrations
- hidden interception layers
- self-modifying policies
- automated policy promotion

The right first step is disciplined observability around the retrieval system OB1 already has.
