# 45 Proposal Review V6 -- Red-Team Findings

**Date:** 2026-06-24
**Reviewer:** Codex
**Reviewed target:** `docs/45-ob1-common-brain-access-proposal.md` Rev 6

## Verdict

Rev 6 folded the v5 findings for real. The doc now owns the hard parts:
`egress_class` as an authorization input, v1 no-shared-restricted invariant,
graph-assisted `ask` as a separate materialization plane, sidecar lease
semantics, quarantine review, datastore RBAC, and one effective policy spine.

So the remaining critique is narrower. Annoying progress. It happens.

The remaining holes:

1. The v1 no-shared-restricted invariant is not a one-table DB constraint; it is
   an access-graph invariant that can be broken later by grants/admin reach.
2. v1 depends on caller trust class, but `read_egress_class` is still described
   as a v2 feature.
3. `effective_egress = most_restrictive(...)` re-conflates confidentiality and
   trust after the doc correctly says "read tier != trust."
4. Cloud-origin provenance is only specified for answer generation, not raw
   search/list/similar/graph outputs that agents also consume.
5. Background materializers like graph projection need a destination/sink class,
   not only a caller class.
6. `brains.egress_class` is now a security label, but its own downgrade path is
   not protected.

No architectural reversal. Mostly places where Rev 6 says the right words but
still needs the boring invariant shape nailed down. Naturally, the boring part
is where the leaks live.

## Findings

### 1. HIGH -- The v1 no-shared-restricted invariant is access-graph state, not a simple row constraint

Rev 6 fixes the v5 phasing bug by saying v1 must structurally forbid
`restricted`/`personal` rows in any cloud-accessible/shared brain while the
shared-brain row clamp remains v2
(`docs/45-ob1-common-brain-access-proposal.md:259`). Correct direction.

But "cloud-accessible" is not a stable property of `thoughts`. It is derived
from the access graph: brain memberships, estate memberships, stored-admin
home-estate reach, key/principal class, and `brains.egress_class`.

Runtime evidence:

- `deriveScope` admits a brain through explicit brain grant, estate membership,
  or stored-admin home-estate reach
  (`local/open-brain-mcp/src/access-policy.mjs:280`,
  `local/open-brain-mcp/src/access-policy.mjs:283`,
  `local/open-brain-mcp/src/access-policy.mjs:286`,
  `local/open-brain-mcp/src/access-policy.mjs:291`).
- Unscoped reads then fan out across `scope.accessible`
  (`local/open-brain-mcp/src/access-policy.mjs:410`).
- The proposal itself recognizes the estate/admin path
  (`docs/45-ob1-common-brain-access-proposal.md:79`).

Abuse path:

At time T1, a brain is `private_local` and holds `restricted` rows. At time T2,
someone adds an estate membership, stored admin key, explicit brain grant, or
changes `egress_class`. The rows did not change, so a `thoughts` CHECK still
passes. The brain just became cloud-accessible after the fact. Congratulations,
the invariant was true yesterday.

Required fix:

- Enforce the invariant at every edge that can change reachability:
  `thoughts.sensitivity_tier`, `brains.egress_class`, `brain_memberships`,
  `estate_memberships`, `brain_access_keys`, principal trust class, and admin
  reach.
- If DB-level enforcement is too ugly, require a runtime migration/provisioning
  gate that fails startup, CI, and deployment when the graph violates the
  invariant. Not a one-time test. Continuous.
- Prefer the simpler rule for v1: only `private_local` brains may hold
  `restricted` rows, and `private_local` brains are unreachable to cloud-bound
  callers by construction.

Acceptance gate:

Create a `private_local` brain with a `restricted` row. Then attempt to add a
cloud-bound explicit brain grant, estate grant, stored-admin reach path, or
egress-class downgrade. Each operation must fail or leave the row unreadable to
cloud-bound callers across search/list/ask/stats/by-id/graph/HTTP.

### 2. HIGH -- v1 still needs caller trust class even if the row clamp is v2

Rev 6 keeps `read_egress_class` as the Layer B row clamp and calls it a flagged
capability-per-key feature (`docs/45-ob1-common-brain-access-proposal.md:115`,
`docs/45-ob1-common-brain-access-proposal.md:124`). Phasing still says the
shared-brain `read_egress_class` row clamp lands in v2
(`docs/45-ob1-common-brain-access-proposal.md:260`).

But v1 now depends on knowing whether a caller is cloud-bound:

- `private_local` brains are excluded from scope for cloud-bound callers
  (`docs/45-ob1-common-brain-access-proposal.md:193`).
- Review endpoints are local-trusted only
  (`docs/45-ob1-common-brain-access-proposal.md:173`).
- The sidecar injects pi as local-trusted
  (`docs/45-ob1-common-brain-access-proposal.md:176`).
- The effective policy function includes `caller.read_egress_class`
  (`docs/45-ob1-common-brain-access-proposal.md:202`,
  `docs/45-ob1-common-brain-access-proposal.md:208`).

Current runtime evidence:

- Stored-key auth currently selects key brain id, admin flag, and principal id,
  but no key egress/trust class (`local/open-brain-mcp/src/auth.mjs:379`).
- Access actor data has auth source, principal id, and admin flag, but no egress
  class (`local/open-brain-mcp/src/access-policy.mjs:104`).

Abuse path:

Implementation follows the phasing literally: row clamp waits for v2, so
`read_egress_class` migration/context waits too. v1 then tries to exclude
`private_local` from "cloud-bound callers" without a first-class caller class.
The code falls back to `isAdmin`, principal slug, route shape, or vibes. We
have seen this movie. It has a clown and a database.

Required fix:

Split the concepts:

- v1 must introduce a minimal caller trust class: `local_trusted` vs
  `cloud_bound`, default `cloud_bound`, carried in access context for all caller
  shapes.
- v2 can still add the shared-brain row-level clamp that uses that class.
- If the intended v1 rule is "only pi's principal is local_trusted; everything
  else is cloud_bound," state it and test it.

Acceptance gate:

Every v1 route that names, lists, searches, mutates, reviews, projects, or
maintains a `private_local` brain must make its decision from an explicit caller
trust class, not admin status, key variable names, or route conventions.

### 3. HIGH -- One scalar `effective_egress` conflates confidentiality with trust

Rev 6 correctly says "Read tier != trust"
(`docs/45-ob1-common-brain-access-proposal.md:167`). Then §6.15 puts brain
egress class, row tier, review state, origin taint, requested operation, and
caller class into one `most_restrictive(...)` `effective_egress`
(`docs/45-ob1-common-brain-access-proposal.md:198`,
`docs/45-ob1-common-brain-access-proposal.md:202`).

That is too flat.

Why it breaks:

- `cloud_origin + standard` should be visible to cloud and pi, but marked
  untrusted (`docs/45-ob1-common-brain-access-proposal.md:172`).
- `cloud_origin + restricted + reviewed` may be visible to local-trusted callers
  but still cloud-origin for trust decisions.
- `review_state` may block materialization entirely for quarantine, but after
  review it should not wash origin.
- A row can be safe to read but unsafe to use for side effects.

A single "most restrictive egress" value encourages the implementation to treat
integrity labels as confidentiality labels. That either over-blocks useful
cloud-origin standard content or, worse, under-specifies trust once content is
allowed through. Different failure, same spreadsheet.

Required fix:

Make the policy output a vector, not a scalar:

```text
policy_decision = {
  can_materialize,
  redaction_level,
  processor_sink_allowed,
  trust_level,
  side_effect_allowed,
  audit_required,
  provenance_fields_required
}
```

The inputs can stay centralised. The output needs separate confidentiality and
integrity dimensions.

Acceptance gate:

A test matrix must prove these cases are distinct:

- `cloud_origin + standard`: materializes, provenance required, not trusted for
  side effects.
- `cloud_origin + restricted + unreviewed`: does not materialize except review.
- `cloud_origin + restricted + reviewed`: local materialization allowed, origin
  remains cloud-origin, side-effect trust still bounded.
- `local_trusted + restricted`: local materialization and local processing
  allowed, cloud materialization denied.

### 4. MEDIUM/HIGH -- Provenance marking must cover raw tool outputs, not only `answerFromEvidence`

Rev 6 handles `cloud_origin + standard` mostly in the answer path: carry
origin/trust into local-trusted evidence objects and tell the answer prompt that
cloud-origin evidence is data, not instructions
(`docs/45-ob1-common-brain-access-proposal.md:172`).

That misses the rest of the API surface. Agents do not only use `ask_brain`.
They use `search_thoughts`, `list_thoughts`, `similar`, graph expansion, REST,
and raw tool results. Those can become prompts or operational inputs outside
`answerFromEvidence`.

Runtime evidence:

- `similar` returns `evidenceCitation(row)` fields plus brain id/slug, with no
  origin/trust field today (`local/open-brain-mcp/src/server.mjs:609`,
  `local/open-brain-mcp/src/server.mjs:611`).
- `list_thoughts` returns raw rows from `list_recent_thoughts` as `thoughts`
  (`local/open-brain-mcp/src/server.mjs:642`,
  `local/open-brain-mcp/src/server.mjs:659`,
  `local/open-brain-mcp/src/server.mjs:663`).
- `evidenceCitation` emits summary/excerpt/source/type but no origin/trust state
  today (`local/open-brain-mcp/src/server.mjs:265`,
  `local/open-brain-mcp/src/server.mjs:276`,
  `local/open-brain-mcp/src/server.mjs:277`).

Abuse path:

A cloud harness writes standard poison. pi calls `search_thoughts` or
`list_thoughts`, not `ask_brain`, then acts on the returned content. The answer
prompt never ran, so "data, not instructions" never helped. The row was
cloud-safe to disclose and still locally toxic. Subtle. Stupid. Effective.

Required fix:

- Include `origin_egress_class`, `last_writer_egress_class`, `review_state`, and
  derived `trust_level` in every local-trusted read result, not only answer
  evidence.
- For cloud-bound outputs, include enough provenance for audit without leaking
  private labels or private brain existence.
- Document that all agent-facing consumers must treat cloud-origin rows as
  untrusted data even outside `ask_brain`.

Acceptance gate:

The same cloud-origin standard row retrieved through `search_thoughts`,
`list_thoughts`, `similar`, `ask_brain`, `expand_context`, and HTTP returns
consistent provenance/trust metadata, and no route emits raw cloud-origin
content to local-trusted callers without the trust marker.

### 5. MEDIUM/HIGH -- Background materializers need sink/audience policy, not caller policy

§6.15 centralises policy around caller, row, brain, and operation
(`docs/45-ob1-common-brain-access-proposal.md:198`,
`docs/45-ob1-common-brain-access-proposal.md:202`). That works for request
handlers. It is insufficient for background jobs and artifact writers.

Runtime evidence:

- Graph projection scans thoughts from Postgres and writes graph data without a
  request caller (`local/open-brain-mcp/src/graph-projection.mjs:62`,
  `local/open-brain-mcp/src/graph-projection.mjs:71`).
- Thought nodes include summary and content preview
  (`local/open-brain-mcp/src/projection-planner.mjs:1232`,
  `local/open-brain-mcp/src/projection-planner.mjs:1241`,
  `local/open-brain-mcp/src/projection-planner.mjs:1242`).
- Graph reads are currently admin-gated, but graph storage itself is a
  persistent derived artifact (`local/open-brain-mcp/src/server.mjs:730`).

Abuse path:

A background projector runs as an internal/local-trusted process. If the policy
uses "caller" and the caller is internal, projection is allowed. It writes
private summaries/previews into Neo4j. Later, a graph route, backup, diagnostic
bundle, or compromised graph credential exposes them. The problem was never the
projector's caller; it was the sink's audience.

Required fix:

Add sink context to the policy:

```text
sink = {
  type: graph_projection | telemetry | audit | backup | response | processor,
  egress_class,
  readers,
  retention,
  cloud_agent_reachable
}
```

Background jobs must authorize against the destination store and its reachable
audience, not against an internal caller identity.

Acceptance gate:

Graph projection, telemetry, purge/review audit, diagnostics, backups, and
processor calls each pass an explicit sink class into the policy helper. A
private row cannot be projected into a graph/log/audit store readable by a
cloud-bound caller even when the projector runs locally.

### 6. MEDIUM -- `brains.egress_class` is now a security label; downgrading it must be protected

Rev 6 elevates `brains.egress_class` into an authorization input
(`docs/45-ob1-common-brain-access-proposal.md:28`,
`docs/45-ob1-common-brain-access-proposal.md:190`,
`docs/45-ob1-common-brain-access-proposal.md:193`). That means changing it from
`private_local` to `repo`/`public` can expose an entire brain. It is a
brain-level declassification event.

The proposal protects row-level `sensitivity_tier` downgrade with a dedicated
local-trusted owner/publish capability, audit row, and human confirmation
(`docs/45-ob1-common-brain-access-proposal.md:150`,
`docs/45-ob1-common-brain-access-proposal.md:151`). It does not state the same
for brain-level egress-class downgrade.

Abuse path:

An operator route, migration, seed script, direct SQL patch, or future admin UI
changes a brain from `private_local` to `repo`. All its rows keep their old
tiers, but scope derivation, telemetry redaction, graph eligibility, stats, and
fanout semantics now change for the whole brain. One column update becomes
"publish brain." Neat trick. Bad trick.

Required fix:

- Treat `brains.egress_class` as a security label.
- Upgrades to more restrictive classes may be simple.
- Downgrades require local-trusted owner capability, explicit human
  confirmation, full audit, and an invariant scan of all rows/artifacts.
- Unknown or invalid brain class fails closed.
- Direct SQL/import paths must use a controlled DB function or fail CI.

Acceptance gate:

Attempting to downgrade a brain from `private_local`/`quarantine_review` to
`repo`/`public` fails unless performed through the protected local-trusted
transition path; the transition records audit and refuses if rows/artifacts
would violate the effective policy.

### 7. MEDIUM -- Review audit can become the new private-content dump

Rev 6 correctly says the quarantine-review endpoint must audit old/new review
state, old/new tier, origin taint, reviewer, reason, and evidence shown
(`docs/45-ob1-common-brain-access-proposal.md:173`). That "evidence shown" field
is itself private-derived content.

The doc has a general private-derived artifact-store rule
(`docs/45-ob1-common-brain-access-proposal.md:195`,
`docs/45-ob1-common-brain-access-proposal.md:196`), but the new review audit is
high-risk enough to bind explicitly. Otherwise the review endpoint is clean and
the audit table becomes the dumpster fire with timestamps.

Required fix:

- Review audit stores only hashes/ids by default; full evidence snapshots go to
  the operator-only private artifact sink if truly needed.
- Review audit retention and export rules are explicit.
- Cloud-bound callers cannot read review audit rows, counts, old_state blobs, or
  exported review bundles.
- Redaction policy is tested for purge audit and review audit together.

Acceptance gate:

Approving a quarantined row writes audit metadata without placing raw private
content or full evidence snapshots in a cloud-agent-readable table/file/export.

## Acceptance Tests To Add

Add these on top of the Rev 6 inherited gates:

1. Access-graph invariant: after restricted rows exist, attempts to add a
   cloud-bound brain grant, estate grant, admin-home reach path, or brain-class
   downgrade fail or leave the rows unreadable.
2. Caller trust class: v1 authorization decisions for `private_local`,
   review-state transitions, sidecar injection, and maintenance use an explicit
   caller trust field; missing/unknown defaults cloud-bound.
3. Policy vector: confidentiality and trust decisions are separate for
   cloud-origin standard, cloud-origin restricted unreviewed, cloud-origin
   restricted reviewed, and local-trusted restricted rows.
4. Provenance everywhere: cloud-origin standard rows carry trust/provenance
   markers through search, list, similar, ask, expand_context, graph-assisted
   ask, and HTTP.
5. Sink policy: graph projection, telemetry, audit, diagnostics, backups, and
   processor dispatch each pass an explicit sink/audience class into policy.
6. Brain egress downgrade: `private_local` to `repo`/`public` fails without
   protected local-trusted transition, audit, and invariant scan.
7. Review audit redaction: quarantine approval does not write raw private
   evidence into cloud-agent-readable audit rows, files, exports, or telemetry.

## Bottom Line

Rev 6 is no longer flailing. The core shape is viable.

The next failure mode is subtler: treating dynamic access state as static row
state, treating trust labels as egress labels, and treating internal background
jobs as safe because they have no user-facing caller. That is where the next
leak comes from if this moves into implementation unchanged.
