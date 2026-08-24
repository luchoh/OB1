# 45 Proposal Review V8 -- Red-Team Findings

**Date:** 2026-06-24
**Reviewer:** Codex
**Reviewed target:** `docs/45-ob1-common-brain-access-proposal.md` Rev 8
**Reviewed commit:** `7a0ec08` (`develop`)

## Verdict

Rev 8 folds the v7 findings. The remaining problems are no longer "Claude missed
the boundary." The boundary is named correctly:

- pi is a distinct `local_trusted` principal, not a second key on the repo
  principal.
- `private_local` / `quarantine_review` are unreachable to cloud-bound callers
  by any grant.
- current sensitivity, writer origin, content source trust, review state,
  exposure history, caller class, authority, and sink reachability are separate
  axes.
- the policy decision is a vector, not a scalar.
- background materializers authorize against the destination sink, not against
  their internal caller identity.

That is the architecture. Freeze it.

But freeze does **not** mean "secure." It means "stop rewriting prose and make
the prose executable." The next failure mode is implementation drift: each route
implements 80% of the policy, calls it after materialization, forgets one enum,
or backfills existing rows as trusted because that made the migration pass. Same
old movie, new hat.

## Findings

### 1. HIGH -- Rev 8 still has unfrozen implementation choices hiding under "open decisions"

Rev 8 says "freeze the design," but §8 still contains decisions that change the
system shape:

- `personal` tier: map to `restricted` or drop it.
- row-flag vs two-brain.
- graph dead-for-v1 vs tier/brain partitioning.
- sidecar vs session broker vs keychain helper.
- Layer A mechanism: separate estate vs `brains.egress_class` as authorization.
- v1 invariant: forbid restricted rows in shared/cloud-accessible brains vs pull
  Layer B forward.

Some of these are not cosmetic. They decide schema, migration order, tests, and
whether v1 is safe. §9 mostly commits to `egress_class` as authorization and to
no restricted rows in shared/cloud-accessible brains, but §8 still phrases those
as open (`docs/45-ob1-common-brain-access-proposal.md:289-291`). Pick the choices before coding, or
implementation will "discover" them by accident. Accidental security design is
just improv with logs.

Required freeze gate:

- Record the chosen options in the proposal or ADRs before implementation.
- For v1: choose `brains.egress_class` as an authorization input, forbid
  `restricted` / `personal` rows outside `private_local` /
  `quarantine_review`, and keep graph dead unless the graph partition work is
  explicitly pulled forward.

Acceptance gate:

- A migration/test plan can be written without any "TBD: choose later" branch
  affecting authorization semantics.

### 2. HIGH -- `max_egress_reached` is fiction unless event sources are defined

Rev 8 correctly adds exposure history (`max_egress_reached` /
`ever_cloud_materialized`) and treats `standard -> restricted` as a
reclassification event (`docs/45-ob1-common-brain-access-proposal.md:181`). Good.

Now the hard part: what increments it?

If only normal search/list/ask responses update it, the label lies. Exposure can
happen through telemetry, graph projection, backup/export, diagnostics, error
paths, processor calls, HTTP REST, calibration exports, maintenance summaries,
operator scripts, or old artifacts created before the label existed. A
monotonic column with incomplete writers is a very confident falsehood.

Required freeze gate:

- Define "cloud materialization" as an event taxonomy before migration:
  response materialization, processor dispatch, telemetry/log write, graph
  projection, audit snapshot, backup/export, diagnostic bundle, calibration
  export, maintenance output, and HTTP/MCP parity.
- Define which events update the row, which update an artifact registry, and
  which produce only incident/audit state because the source row is not enough.
- Existing artifacts must be backfilled as "unknown exposure" or scanned and
  proven clean. Defaulting old rows to "never exposed" is laundering by
  migration.

Acceptance gate:

- A row captured `standard`, returned to a cloud-bound caller, logged, projected,
  then raised to `restricted` records prior exposure and forces artifact
  scrub/reproject/mark before local-trusted retrieval can treat it as private.

### 3. HIGH -- Capability grammar is now load-bearing and still underspecified

Rev 8 correctly splits confidentiality (`read_egress_class`) from authority
(`capabilities`, `approval_presence`, `human_confirmation_id`) at
`docs/45-ob1-common-brain-access-proposal.md:128`. It also makes maintenance operation-specific and
ids/status-only at `docs/45-ob1-common-brain-access-proposal.md:206`.

That creates a new security boundary: the capability grammar. Right now the doc
names examples, not a contract. If implementation invents capability names per
route, route handlers will drift. One route will require `owner`, another
`admin`, another `maintenance`, and the fake mustache returns for a sequel.

Required freeze gate:

- Define the exact capability vocabulary before coding:
  `read_private`, `review_quarantine`, `downgrade_tier`,
  `downgrade_brain_egress`, `export_private`, `purge_private`,
  `repair_audit`, `reconcile_projection_state`, `run_backfill`, etc.
- Define which caller classes can hold each capability.
- Define which capabilities require human confirmation, TTL, target binding,
  audit, and approved sink.
- Define a route/action matrix for MCP and HTTP. No route gets to improvise.

Acceptance gate:

- Tests fail if a route can review, downgrade, export, purge, run maintenance,
  mutate restricted rows, or project private artifacts using only `admin`,
  `owner`, `local_trusted`, or a generic maintenance bit.

### 4. MEDIUM/HIGH -- Migration/backfill order can silently choose insecure defaults

Rev 8 adds many load-bearing fields:

- `read_egress_class`
- `brains.egress_class`
- `origin_egress_class`
- `source_trust_class`
- `review_state`
- `max_egress_reached`
- constrained tier enum / DB CHECK
- extended audit actions
- sink registry / reachability labels

That is right. It is also enough rope to knit a noose.

If existing rows default to `standard`, `local_trusted`, `trusted_source`, and
`never_cloud_materialized`, the migration launders history. If existing rows
default to most restrictive everywhere without a staged rollout, the service may
brick itself and someone will "temporarily" disable the checks. Temporary, like
plutonium.

Required freeze gate:

- Use a staged migration:
  add nullable columns, backfill pessimistically, dual-write, run invariant
  scans, enable CHECKs/triggers, then enforce policy.
- Unknown values fail closed in policy, but rollout must include operator
  visibility so fail-closed does not become "comment out the guard."
- Existing rows with uncertain provenance/source/exposure must be marked
  `unknown` / `untrusted` / `possibly_exposed`, not silently trusted.

Acceptance gate:

- A clean migration from the current schema produces no row that is more
  trusted or less exposed than the system can prove.

### 5. MEDIUM/HIGH -- The policy helper must be pre-materialization, not a post-fetch conscience

Rev 8 makes §6.15 the spine and says every plane calls one SQL helper/view plus
one JS wrapper (`docs/45-ob1-common-brain-access-proposal.md:215-253`). Good. The implementation trap
is placement.

A JS wrapper after fetching content is too late for several planes:

- ranked retrieval has already counted/scored candidates;
- graph expansion has already rehydrated neighbors;
- telemetry may already have result ids;
- processors may already have received content;
- errors may already have captured upstream body/URL;
- background jobs may already have written artifacts.

The helper must prevent materialization, not merely redact after the server saw
too much. Otherwise the control works exactly where it is easiest and nowhere
where it matters. Very on brand, but no.

Required freeze gate:

- Define per-plane insertion points for the policy helper.
- SQL reads and by-id rehydration apply the predicate before ranking,
  thresholding, limit, aggregation, graph expansion, telemetry, and answer
  generation.
- Processor dispatch and capture conflict preflight call policy before any
  outbound processor request.
- Background materializers call policy before writing to graph/log/audit/backup
  sinks.

Acceptance gate:

- Instrument tests prove denied restricted/quarantined rows do not enter result
  arrays, telemetry payloads, processor requests, graph candidate sets, or audit
  snapshots. Not "redacted later." Absent.

### 6. MEDIUM -- Graph "dead for v1" needs an explicit kill switch, not a vibe

Rev 8 keeps graph as a known dangerous plane and allows v1 to keep it
admin-only-and-dead if conditions hold (`docs/45-ob1-common-brain-access-proposal.md:280`,
`docs/45-ob1-common-brain-access-proposal.md:301`). Fine as a v1 shortcut.

But "dead" must be a testable deployment state:

- no cloud-held key is graph admin;
- legacy admin is not reachable from harnesses;
- Neo4j credentials are not in repo/env/tool output;
- graph REST routes do not materialize private data;
- graph projection does not write private/restricted previews into a
  cloud-reachable sink.

Required freeze gate:

- Add a single graph exposure flag/config posture for v1, documented and tested.
- If graph is enabled for cloud-bound callers, pull graph partitioning and
  policy-threading into v1. No halfway bridge made of adjectives.

Acceptance gate:

- From a clean cloud-agent shell and cloud-bound key, graph neighbors,
  source-lineage, why-connected, graph-assisted ask, Neo4j direct access, and
  graph-derived telemetry/artifacts cannot reveal private/restricted content,
  ids, counts, or cross-brain entity edges.

### 7. MEDIUM -- ADRs are now part of the security boundary, not paperwork

Rev 8 explicitly depends on ADR amendments (`docs/45-ob1-common-brain-access-proposal.md:284`):

- ADR-0002: a second server-derived subtractive mechanism beyond brain-level
  DENY.
- ADR-0003: capability-per-key.
- ADR-0001 pt 5: pi is a distinct local-trusted principal.
- ADR-0001 pt 6: `OB1_REPO_KEY` / `OB1_OPERATOR_ACCESS_KEY` split.

Until those land, Rev 8 conflicts with the current written model. That matters
because future agents will read the ADRs and "simplify" the code back to the old
model. Documentation drift is how security bugs get tenure.

Required freeze gate:

- Patch ADR-0001/0002/0003 before or with the first implementation PR.
- Treat implementation PRs that contradict those ADR patches as rejected.

Acceptance gate:

- A reviewer can read ADRs + `CONTEXT.md` without reading this review history
  and still derive the same authorization model.

## Freeze Recommendation

Freeze Rev 8 as the **design baseline**. Do not run a ninth prose red-team loop
unless implementation discovers a contradiction that changes the boundary.

Freezing means:

- no more architecture rewrites in `docs/45`;
- open choices above get resolved into ADR/design decisions;
- the ~30 accumulated acceptance gates become an executable test matrix;
- implementation starts with migrations, central policy helper, graph posture,
  and route/action capability matrix.

Do **not** freeze it as "approved secure." That would be delusional, and we have
already met the quota. Freeze it as: "this is coherent enough to implement, and
security now depends on code, tests, migrations, and operational proof."

## First Implementation Slice

The smallest non-theatrical slice:

1. ADR patches for principal boundary, subtractive egress auth, and
   capability-per-key.
2. Schema migration skeleton with fail-closed enum domains and pessimistic
   backfill plan.
3. Central policy helper + JS wrapper with unit tests for the four policy
   quadrants in §6.15.
4. v1 graph posture: explicitly disabled to cloud-bound callers, with negative
   tests.
5. Route/action capability matrix for MCP and HTTP before route patches start.

After that, implement route enforcement. In that order. Otherwise the code will
be an archaeological dig by Friday.
