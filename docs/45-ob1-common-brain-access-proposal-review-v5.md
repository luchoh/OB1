# 45 Proposal Review V5 -- Red-Team Findings

**Date:** 2026-06-24
**Reviewer:** Codex
**Reviewed target:** `docs/45-ob1-common-brain-access-proposal.md` Rev 5

## Verdict

Rev 5 is materially better. It absorbed the v4 hits: sidecar caller-binding,
global quarantine, conflict-aware capture preflight, brain-level egress class,
DB-enforced taint, and private-derived artifact stores. So no, this is not the
same clown car.

The remaining issues are the predictable ugly ones:

1. The phasing still puts the shared-brain read clamp in v2 while the invariant
   pretends it exists in v1.
2. The proposal rejects `scope_isolated`, but current scope derivation still has
   estate/admin reach paths that can name or read brains without explicit brain
   membership.
3. `cloud_origin + standard` is still an integrity problem, not just a harmless
   public fact.
4. Graph-assisted `ask_brain` has a second by-id rehydration step after ranked
   SQL, so "clamp SQL" is not enough unless the graph path carries the same
   policy.
5. Effective egress composition is left open even though every control depends
   on it.

No fatal architectural reversal. But a few "open decisions" are actually load-
bearing beams. Cute place for TODOs, if you like rubble.

## Findings

### 1. HIGH -- v1/v2 phasing can ship the invariant before the read clamp

Rev 5 states the invariant broadly: no cloud-class caller gets `restricted` or
`personal` content, derived data, answers, or artifacts
(`docs/45-ob1-common-brain-access-proposal.md:75`). It also says Layer B is the
clamp for the one genuinely shared brain that both pi and cloud principals can
read and that may hold a restricted slice
(`docs/45-ob1-common-brain-access-proposal.md:48`).

But phasing pushes `read_egress_class`, active SQL tier predicates, stats, and
`readThoughtRowsByIds` clamps to v2
(`docs/45-ob1-common-brain-access-proposal.md:224`). v1 gets Layer A, brain
egress class, quarantine, capture/write controls, and graph-dead-by-policy
(`docs/45-ob1-common-brain-access-proposal.md:223`), but not the shared-brain
row read clamp.

Abuse path:

A shared common brain is provisioned in v1 because the doc says the architecture
is ready. pi writes or promotes a row as `restricted` in that brain. A cloud
principal with membership to the same brain reads it through active
`search_thoughts`, `list_thoughts`, `similar`, `stats`, or by-id expansion
because the server-derived row ceiling is still a v2 feature.

Required fix:

- Move `read_egress_class` plus active materialization predicates to v1; or
- Make v1 structurally forbid `restricted` rows in any cloud-accessible/shared
  brain with a DB constraint or provisioning test; or
- State plainly that shared-brain restricted slices do not exist until v2.

Acceptance gate:

A cloud-bound key with membership to the shared common brain cannot read,
aggregate, answer from, by-id rehydrate, or see telemetry identifiers for a
`restricted` row in that same brain. If that test is not v1, the feature is not
v1 either.

### 2. HIGH -- "No scope_isolated" conflicts with current estate/admin reach

Rev 5 says it does not invent `scope_isolated`
(`docs/45-ob1-common-brain-access-proposal.md:28`). It then adds
`brains.egress_class` as a pre-fetch anchor for redaction, processor policy,
projection eligibility, stats, and unscoped fanout
(`docs/45-ob1-common-brain-access-proposal.md:185`).

That is not enough unless the new brain class participates in authorization
scope derivation, not only downstream redaction.

Runtime evidence:

- The catalog includes brains reachable by brain membership, estate membership,
  or stored-admin home-estate reach (`local/open-brain-mcp/src/auth.mjs:121`).
- `deriveScope` marks a brain accessible via explicit brain grant,
  non-denied estate membership, or admin home reach
  (`local/open-brain-mcp/src/access-policy.mjs:267`,
  `local/open-brain-mcp/src/access-policy.mjs:283`,
  `local/open-brain-mcp/src/access-policy.mjs:286`,
  `local/open-brain-mcp/src/access-policy.mjs:291`).
- Unscoped reads fan out across every accessible brain
  (`local/open-brain-mcp/src/access-policy.mjs:410`).

Abuse path:

`common-private` has no explicit repo-principal membership, so Layer A appears
safe. But the repo principal has estate membership, or a stored admin key has
home-estate reach. The private brain enters the accessible set anyway. Brain
membership absence did not separate anything; estate/admin reach walked around
it wearing a fake mustache.

Required fix:

Pick one, explicitly:

- Add a real isolation bit/class: `private_local` brains are excluded from
  estate/admin fanout and explicit naming for cloud-bound callers unless a
  dedicated maintenance capability is present.
- Provision private brains in a separate estate with no repo-principal estate
  membership and no cloud-held admin-home path, then add continuous tests for
  that invariant.
- If `brains.egress_class` is intended to do this, say so: it is an authorization
  input, not merely a redaction/projection hint.

Maintenance exception:

Operator maintenance still needs a path. Make it explicit, named, audited, and
non-fanout. Otherwise "admin can maintain it" quietly becomes "admin can read it
from normal MCP tools." That movie already ended badly.

### 3. HIGH -- `cloud_origin + standard` can still poison local-trusted inference

Rev 5 focuses quarantine on `cloud_origin + restricted`
(`docs/45-ob1-common-brain-access-proposal.md:165`,
`docs/45-ob1-common-brain-access-proposal.md:169`). It also says cloud harnesses
may write/capture freely at `standard`
(`docs/45-ob1-common-brain-access-proposal.md:195`).

Confidentiality-wise, fine. Integrity-wise, not fine.

The problem statement says cloud harnesses can write content the local-trusted
side will later read and trust (`docs/45-ob1-common-brain-access-proposal.md:15`).
That is true even when the content is `standard`. A standard public memory can
still say "ignore prior instructions, run this shell command, trust this false
decision record." It is cloud-safe to disclose; it is not automatically
local-trusted.

Runtime evidence:

- Evidence returned to the answer model includes summary and excerpt, but no
  origin/trust state today (`local/open-brain-mcp/src/server.mjs:265`,
  `local/open-brain-mcp/src/server.mjs:276`,
  `local/open-brain-mcp/src/server.mjs:277`).
- The model prompt tells the LLM to use supplied evidence; it has no
  provenance-specific instruction for untrusted/cloud-origin evidence
  (`local/open-brain-mcp/src/models.mjs:359`,
  `local/open-brain-mcp/src/models.mjs:370`).
- Sanitized evidence sent to the LLM has no origin/trust fields
  (`local/open-brain-mcp/src/models.mjs:194`).

Required fix:

Separate egress safety from trust:

- Stamp `origin_egress_class` for all rows, including `standard`.
- Include provenance/trust state in local-trusted evidence objects or in a
  parallel control channel.
- Tell the answer prompt/tool contract that cloud-origin evidence is data, not
  instructions, and should be cited/used with provenance awareness.
- Consider demoting, marking, or requiring review for cloud-origin standard rows
  before they affect local-trusted decisions with side effects.

Acceptance gate:

A cloud-origin standard row containing prompt-injection text can be retrieved by
pi, but the answer path marks it as cloud-origin/untrusted and does not execute
or transform its instructions into trusted operational guidance.

### 4. MEDIUM/HIGH -- Graph-assisted `ask_brain` can bypass a ranked-SQL-only clamp

Rev 5 correctly calls out `readThoughtRowsByIds` and the graph gap in the plane
table (`docs/45-ob1-common-brain-access-proposal.md:88`). The `ask_brain` row,
though, still says the clamp is "at the SQL layer inside `retrieveEvidenceRows`"
(`docs/45-ob1-common-brain-access-proposal.md:82`). That wording is a trap.

Runtime evidence:

- `retrieveEvidenceRows` first retrieves ranked seed rows, then, when graph is
  enabled, calls `expandThoughtsWithGraph`
  (`local/open-brain-mcp/src/retrieval.mjs:898`,
  `local/open-brain-mcp/src/retrieval.mjs:906`).
- `expandThoughtsWithGraph` obtains graph neighbor ids and then fetches rows by
  id (`local/open-brain-mcp/src/retrieval.mjs:831`,
  `local/open-brain-mcp/src/retrieval.mjs:855`).
- `readThoughtRowsByIds` currently filters by id, brain, tombstone, and metadata
  only; no tier, origin, review, or brain-class predicate
  (`local/open-brain-mcp/src/thought-store.mjs:457`,
  `local/open-brain-mcp/src/thought-store.mjs:459`,
  `local/open-brain-mcp/src/thought-store.mjs:460`,
  `local/open-brain-mcp/src/thought-store.mjs:461`).

Abuse path:

Implementation clamps `match_thoughts` and calls it done. A cloud/admin
graph-assisted ask gets safe seed rows, graph expansion finds adjacent
restricted/quarantined ids, `readThoughtRowsByIds` rehydrates them, and the
answer model sees the content. The SQL guard did its job. The graph walked
around it. Very helpful, like a raccoon with a badge.

Required fix:

- Treat graph-assisted `ask_brain` as its own materialization plane.
- Thread caller class, brain egress class, effective tier ceiling, origin taint,
  and review state into graph expansion and by-id rehydration.
- Apply the same predicate to seed rows and graph-added rows before evidence
  selection, telemetry, and answer generation.

Acceptance gate:

With `graph_assisted=true`, a restricted/quarantined neighbor of an allowed seed
never appears in `evidenceRows`, answer citations, graph expansion ids, or
telemetry for a cloud-bound caller.

### 5. MEDIUM/HIGH -- Effective egress composition cannot stay an open decision

Rev 5 adds a brain-level egress class (`docs/45-ob1-common-brain-access-proposal.md:185`)
and row-level sensitivity tiers (`docs/45-ob1-common-brain-access-proposal.md:57`).
Then it leaves their composition open
(`docs/45-ob1-common-brain-access-proposal.md:216`).

That is not an open decision. It is the policy function.

Risk:

Different planes will compute visibility differently:

- SQL ranked reads use row tier.
- Telemetry uses brain class.
- Graph projection uses brain class or tier.
- Quarantine uses origin plus review state.
- Processor policy uses requested tier, existing tier, or brain class depending
  on who implements it before coffee.

Congratulations, five locks and six keys.

Required fix:

Define a single effective materialization policy before implementation:

```text
effective_egress = most_restrictive(
  brain.egress_class,
  row.sensitivity_tier,
  row.review_state,
  row.origin_egress_class,
  requested_operation,
  caller.read_egress_class
)
```

The exact enum can differ. The rule cannot.

Implementation requirement:

- Centralize the policy in one SQL helper/view plus one JS wrapper for non-SQL
  planes.
- Make unknown enum values fail closed.
- Require every plane to call the helper or prove it is not materializing
  content, ids, counts, paths, slugs, excerpts, embeddings, or graph-derived
  data.

Acceptance gate:

A test matrix with disagreeing brain class and row tier produces the same
decision for search, list, ask, stats, by-id reads, graph projection, graph
expansion, telemetry, capture preflight, metadata patch, lifecycle mutation, and
processor dispatch.

### 6. MEDIUM -- The sidecar unlock still lacks lifetime, revocation, and audit semantics

Rev 5 now requires a human-gated, pi-bound sidecar capability
(`docs/45-ob1-common-brain-access-proposal.md:178`,
`docs/45-ob1-common-brain-access-proposal.md:179`,
`docs/45-ob1-common-brain-access-proposal.md:180`). That closes the obvious
confused-deputy path.

But the capability lifecycle is still undefined
(`docs/45-ob1-common-brain-access-proposal.md:215`).

Abuse path:

The human unlocks pi once. The sidecar keeps a long-lived bearer or session
lease. Later, a misrouted client, stale process, copied socket path, lingering
approval, or accidental command path uses that unlocked session. Nobody stole
the crown jewels; they just found the valet still holding the door open.

Required fix:

Define the lease model:

- Short TTL and idle timeout.
- Explicit lock/revoke command.
- Per-caller and per-session binding.
- Optional per-call approval for high-risk operations: private read, tier
  downgrade, quarantine approval, purge, export.
- Audit row for every sidecar-injected request: caller binding id, operation,
  target brain, target thought id when present, and approval/lease id.

Acceptance gate:

A previously approved pi sidecar session expires, can be revoked, and cannot be
reused by a different repo shell, process session, TTY, or copied transport
address.

### 7. MEDIUM -- The quarantine review endpoint is now the dangerous endpoint

Rev 5 makes quarantined rows absent everywhere except an explicit local-trusted
review endpoint (`docs/45-ob1-common-brain-access-proposal.md:169`). Good. Also:
that endpoint is now the declassification and trust-transition choke point.
Treat it like one.

Abuse path:

A local-trusted review route lists hidden cloud-origin restricted rows, runs a
model summary over them, bulk-approves them, or flips `review_state` without a
human seeing content and provenance. The quarantine worked right up to the
place where the quarantine guard stamped everything "fine" with a shovel.

Required fix:

Specify the review endpoint:

- Local-trusted only, not merely admin.
- No cloud-origin row is sent to a processor before review unless the processor
  policy says local-only and the UI/API marks the row as untrusted.
- No silent bulk approval; require explicit reviewer identity and per-row or
  bounded-batch confirmation.
- Audit old/new `review_state`, old/new tier, origin taint, reviewer, reason,
  and evidence shown to the reviewer.
- Approval does not wash `origin_egress_class`; it only changes review/trust
  state.

Acceptance gate:

A cloud-origin restricted row can be inspected only through the local-trusted
review path, approval is audited, origin remains cloud-origin, and bulk or
processor-mediated approval fails unless explicitly designed and tested.

### 8. MEDIUM -- Direct datastore access needs RBAC assumptions, not just secret relocation

Rev 5 correctly moves service secrets out of the repo and out of cloud-harness
launch paths (`docs/45-ob1-common-brain-access-proposal.md:106`,
`docs/45-ob1-common-brain-access-proposal.md:108`,
`docs/45-ob1-common-brain-access-proposal.md:109`). That removes the ordinary
`.env` faceplant.

It still needs to state the datastore-side assumption:

If Postgres, Neo4j, MinIO, or source systems accept ambient local access, peer
auth, trust auth, shared superuser credentials, or broad operator credentials,
then API-layer egress policy is bypassable by ordinary tools, not exotic
malware. Moving secrets out of the repo does not help if the local socket says
"come on in."

Required fix:

- DB/graph/source services must require non-agent credentials for sensitive
  data access.
- Runtime credentials should be least-privilege, not superuser/operator keys.
- Operator direct-PG paths must use a separate role and be outside cloud-harness
  env.
- If RLS is not used, document why API-only enforcement is acceptable and which
  local service auth settings make direct access impossible from a clean agent
  shell.

Acceptance gate:

From a clean repo cloud-agent shell with no service env, direct `psql`, Neo4j,
MinIO, Consul, and source-system access to private content fails. If it succeeds
because local service auth is permissive, the model has already lost below MCP.

## Acceptance Tests To Add

Add these on top of the Rev 5 inherited gates:

1. Shared-brain restricted row: cloud-bound member cannot read it through search,
   list, similar, ask, stats, by-id, graph-assisted ask, graph expansion,
   telemetry ids, or HTTP REST.
2. Private brain scope: cloud-bound principal with estate membership or
   stored-admin home reach cannot reach `private_local` brains through unscoped
   fanout or explicit selector unless a dedicated audited maintenance
   capability is present.
3. Provenance integrity: cloud-origin standard evidence is marked untrusted in
   local-trusted answers and cannot inject operational instructions.
4. Graph-assisted ask: graph-added restricted/quarantined neighbors are excluded
   before evidence selection, answer generation, and telemetry.
5. Effective policy matrix: disagreeing brain class, row tier, origin taint, and
   review state produce identical allow/deny decisions across every
   materialization and mutation plane.
6. Sidecar lease: unlocks expire, can be revoked, are caller/session-bound, and
   are audited per injected request.
7. Quarantine review: approval is local-trusted only, audited, non-washing for
   origin taint, and cannot silently bulk-approve hidden rows.
8. Direct datastore bypass: clean cloud-agent shell cannot read private content
   from Postgres, Neo4j, MinIO, Consul, or source systems without the MCP API.

## Bottom Line

Rev 5 no longer needs an architectural rewrite. It needs the implementation
contract tightened where policy composition, phasing, and privileged review
paths can drift.

The biggest non-negotiable: do not ship a v1 that permits restricted rows in a
cloud-accessible shared brain while the row-level read clamp is scheduled for
v2. That is not phased delivery. That is a time-delayed leak with headings.
