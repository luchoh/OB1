# 45 Proposal Review V7 -- Red-Team Findings

**Date:** 2026-06-24
**Reviewer:** Codex
**Reviewed target:** `docs/45-ob1-common-brain-access-proposal.md` Rev 7

## Verdict

Rev 7 folded the v6 findings cleanly. The proposal now has the right major
shape: caller trust class in v1, access-graph invariant decomposition, policy
vector, sink dimension, provenance on all read planes, protected brain-class
downgrade, and bounded review audit.

So the remaining problems are not "Claude missed the architecture." They are
contract gaps that will become bugs if implementation starts tomorrow:

1. `private_local` explicit-grant semantics contradict themselves.
2. Current sensitivity labels do not record past exposure, so `standard ->
   restricted` is not actually fail-safe.
3. Sink reachability is dynamic, just like brain reachability.
4. The maintenance capability can become the new admin read path.
5. The count oracle is still open even though the invariant forbids derived
   leakage.
6. `side_effect_allowed` is only an annotation unless downstream tools enforce
   it.
7. `local_trusted` conflates "may receive bytes" with "may approve trust
   transitions."
8. `origin_egress_class` tracks writer egress, not source/content adversariality.

No architectural reversal. But these are not cosmetic. They decide whether the
system is enforceable or just a very literate suggestion.

## Findings

### 1. HIGH -- `private_local` explicit-grant semantics contradict themselves

Rev 7 says `egress_class` excludes `private_local` / `quarantine_review` brains
from estate/admin fanout and naming by cloud-bound callers, but leaves them
"reachable only by an explicit brain grant or the named non-fanout maintenance
capability" (`docs/45-ob1-common-brain-access-proposal.md:197`).

Then §9 says `private_local` is unreachable to cloud-bound callers "regardless
of any brain/estate/admin grant" (`docs/45-ob1-common-brain-access-proposal.md:285`).

Those are different systems.

Runtime evidence:

- Current scope derivation treats an explicit brain grant as sufficient for
  accessibility (`local/open-brain-mcp/src/access-policy.mjs:280`,
  `local/open-brain-mcp/src/access-policy.mjs:282`,
  `local/open-brain-mcp/src/access-policy.mjs:291`).
- Estate grants and admin home reach are also sufficient today
  (`local/open-brain-mcp/src/access-policy.mjs:283`,
  `local/open-brain-mcp/src/access-policy.mjs:286`).
- Unscoped reads fan out over `scope.accessible`
  (`local/open-brain-mcp/src/access-policy.mjs:410`).

Abuse path:

The implementation follows line 197 and allows explicit grants to name
`private_local` brains. A cloud-bound principal receives an explicit grant,
maybe by migration, seed, operator mistake, or future UI. The v1 invariant says
restricted rows live only in `private_local`, but now a cloud-bound explicit
grant can reach them. The estate/admin bypass got fixed; the explicit-grant
bypass walked through the front door with a lanyard.

Required fix:

- Define the rule unambiguously: cloud-bound callers cannot reach
  `private_local` / `quarantine_review` brains by explicit grant, estate grant,
  admin reach, selector, or fanout.
- If explicit grants are allowed, then they must require `local_trusted` caller
  class or a dedicated maintenance capability that does not materialize normal
  read results.
- Land the ADR change in v1. This is no longer a v2 nicety: `egress_class` is a
  new subtractive authorization input alongside DENY.

Acceptance gate:

A cloud-bound principal with an explicit `brain_memberships` grant to a
`private_local` brain cannot name it, fan out to it, read it, stat it, graph it,
or mutate it except through the explicitly-scoped maintenance path.

### 2. HIGH -- `standard -> restricted` needs exposure history, not just a new label

Rev 7 repeats that raising a label is the fail-safe direction
(`docs/45-ob1-common-brain-access-proposal.md:153`). It also says cloud harnesses
keep full standard-tier read and write
(`docs/45-ob1-common-brain-access-proposal.md:252`,
`docs/45-ob1-common-brain-access-proposal.md:253`).

That means a row can be read by a cloud harness, returned in tool output,
included in telemetry, projected into graph, backed up, or sent to processors
while it is `standard`. If it is later raised to `restricted`, the current label
protects future reads only. It does not erase past egress. Time remains
annoyingly linear.

Abuse path:

A sensitive thought is captured as default `standard`, read by Codex, logged in
retrieval telemetry, and projected into a cloud-reachable artifact. Later pi or
an operator notices and raises it to `restricted`. The proposal now treats it as
local-only. But the content already left. Worse, local inference may now treat
it as clean private evidence even though cloud saw it while it was standard.

Required fix:

- Add exposure history separate from current sensitivity:
  `max_egress_reached`, `ever_cloud_materialized`, or equivalent.
- A `standard -> restricted` transition is not just "safe raise"; it is a
  reclassification event. It must trigger artifact scrub/reprojection, telemetry
  retention handling, backup/export review, and possibly incident marking.
- Local-trusted retrieval should be able to distinguish "restricted and never
  cloud-exposed" from "restricted now, but previously cloud-exposed."
- The same rule applies to derived artifacts: changing the source row does not
  automatically reclassify or purge its graph/log/audit/backup copies.

Acceptance gate:

Create a `standard` row, read/project/log it through a cloud-accessible path,
then raise it to `restricted`. The system records the past exposure, scrubs or
marks derived artifacts, and does not present the row as never-exposed local
private evidence.

### 3. MEDIUM/HIGH -- Sink reachability is dynamic too

Rev 7 correctly adds a sink dimension to the policy helper
(`docs/45-ob1-common-brain-access-proposal.md:221`,
`docs/45-ob1-common-brain-access-proposal.md:231`,
`docs/45-ob1-common-brain-access-proposal.md:236`). That fixes the naive
"internal projector is trusted" mistake.

But `sink.cloud_agent_reachable` is not static. A graph DB, telemetry directory,
backup bucket, audit export, or diagnostics path can become cloud-agent-readable
after private artifacts already exist.

Runtime evidence:

- Graph projection writes Thought summaries and content previews into Neo4j
  (`local/open-brain-mcp/src/projection-planner.mjs:1232`,
  `local/open-brain-mcp/src/projection-planner.mjs:1241`,
  `local/open-brain-mcp/src/projection-planner.mjs:1242`).
- The projector fetches source rows without a request caller
  (`local/open-brain-mcp/src/graph-projection.mjs:62`,
  `local/open-brain-mcp/src/graph-projection.mjs:71`).

Abuse path:

At T1, graph projection is considered private and receives restricted previews.
At T2, Neo4j credentials land in an agent env, a graph REST route is opened, a
backup is exported into the repo, or a diagnostics bundle captures the graph.
Write-time policy was correct at T1. The sink became reachable at T2. Same bug
class as access graph drift, now with more moving parts. Lovely.

Required fix:

- Treat sink class and sink reachability as security labels with protected
  downgrade/relocation paths.
- Any transition that makes a sink more cloud-reachable must scan existing
  artifacts and refuse, purge, redact, or reclassify before the transition.
- Add continuous invariant scans for artifact stores, not only brains/rows.
- Add a registry of private-derived sinks with owner, path/DSN, reader class,
  retention, backup/export policy, and cloud-agent reachability.

Acceptance gate:

After restricted artifacts exist in graph/telemetry/audit/backup, attempts to
make that sink cloud-agent-readable fail until the artifacts are removed,
redacted, or explicitly declassified.

### 4. MEDIUM/HIGH -- The maintenance capability can become the new read bypass

Rev 7 routes `private_local` upkeep through a named, audited, non-fanout
maintenance capability for purge/reconcile/backfill
(`docs/45-ob1-common-brain-access-proposal.md:79`,
`docs/45-ob1-common-brain-access-proposal.md:197`). That is necessary. It is
also dangerous.

The proposal does not yet define what maintenance may return. If "maintenance"
can list target rows, show content, return counts, run graph expansion, emit
diagnostics, or export old state, it becomes a private read API with a fake
mustache. Again with the mustache.

Runtime evidence:

- Current stats returns per-brain counts and top sources/types/people
  (`local/open-brain-mcp/src/server.mjs:690`,
  `local/open-brain-mcp/src/thought-store.mjs:495`,
  `local/open-brain-mcp/src/thought-store.mjs:498`,
  `local/open-brain-mcp/src/thought-store.mjs:520`).
- Current graph handlers are gated by admin status, not a distinct maintenance
  capability (`local/open-brain-mcp/src/server.mjs:730`).

Required fix:

- Define maintenance as operation-specific capabilities, not one bit:
  `purge_by_id`, `reconcile_projection_state`, `run_backfill`, `repair_audit`,
  etc.
- Default maintenance responses to ids/hashes/status only; no content, excerpt,
  summary, top_people, graph neighborhood, or old_state unless the operation is
  also a local-trusted review/read operation.
- Require explicit target selectors. No unscoped fanout, wildcard listing, or
  graph traversal from maintenance.
- Audit every maintenance invocation with operation, target, result class, and
  sink.

Acceptance gate:

A cloud-bound admin or operator key with maintenance capability can perform the
allowed repair action but cannot obtain private content, private counts,
private metadata rollups, graph neighborhoods, or audit snapshots.

### 5. MEDIUM/HIGH -- The count oracle is still open while the invariant forbids derived leakage

The invariant says a cloud-class caller gets no restricted content, derived data,
or content-derived answer (`docs/45-ob1-common-brain-access-proposal.md:75`).
The plane table says stats needs a ceiling before aggregation
(`docs/45-ob1-common-brain-access-proposal.md:91`).

But §8 still leaves the count oracle open: accepted residual or required
pre-aggregation clamp (`docs/45-ob1-common-brain-access-proposal.md:266`).

Runtime evidence:

- `handleStats` returns aggregate overview and per-brain stats
  (`local/open-brain-mcp/src/server.mjs:690`,
  `local/open-brain-mcp/src/server.mjs:703`,
  `local/open-brain-mcp/src/server.mjs:707`).
- `brainStats` aggregates counts and top sources/types/people directly from
  `thoughts` metadata (`local/open-brain-mcp/src/thought-store.mjs:495`,
  `local/open-brain-mcp/src/thought-store.mjs:498`,
  `local/open-brain-mcp/src/thought-store.mjs:520`).

Risk:

Counts, top people, top sources, and type distributions leak existence and
shape. In v1 this matters for private brains and maintenance paths. In v2 it
matters for the shared brain once restricted rows are allowed. "No content"
does not mean "no signal." We did in fact learn this before; statistics was
there too.

Required fix:

- Decide now: count oracle is not an accepted residual for restricted/private
  material.
- Clamp before aggregation using the same policy helper.
- For private brains, cloud-bound callers get no per-brain row, no zero/nonzero
  distinction, and no top metadata rollups unless explicitly declassified.
- Maintenance stats, if needed, return only bounded status necessary for the
  operation and go to an approved sink.

Acceptance gate:

Adding one restricted row does not change cloud-visible stats, per-brain
presence, top_people, source/type counts, graph stats, telemetry counts, or
maintenance summaries.

### 6. MEDIUM -- `side_effect_allowed` is not enforcement unless downstream tools obey it

Rev 7's policy vector includes `side_effect_allowed`
(`docs/45-ob1-common-brain-access-proposal.md:210`,
`docs/45-ob1-common-brain-access-proposal.md:215`). It also says cloud-origin
standard rows should be treated as data, not instructions
(`docs/45-ob1-common-brain-access-proposal.md:174`,
`docs/45-ob1-common-brain-access-proposal.md:175`).

That is a good label. It is not, by itself, a control.

Abuse path:

OB1 returns a cloud-origin standard row with `side_effect_allowed=false`. The
local agent receives the tool result, ignores the field, and runs the command or
uses the claim as an operational decision anyway. OB1 did not execute the side
effect, but it supplied the payload and then trusted the consumer to read the
warning label. Historically, warning labels have had a rough time with LLMs.

Required fix:

- Define the consumer-side contract. Any tool or agent path that can perform
  side effects must check policy metadata before action.
- Return untrusted content in a clearly separated field such as
  `untrusted_content`, not blended into instruction-like prose.
- For high-risk flows, require a policy token or explicit local human approval
  before content-derived side effects.
- Add regression tests around tool-call chains, not only OB1 retrieval results.

Acceptance gate:

A cloud-origin standard row containing an instruction to run a shell command is
retrieved by pi. The downstream side-effecting path refuses to act unless a
local-trusted review/approval explicitly overrides the policy.

### 7. MEDIUM -- `local_trusted` is not the same as reviewer authority

Rev 7 correctly makes caller trust class a v1 prerequisite
(`docs/45-ob1-common-brain-access-proposal.md:126`,
`docs/45-ob1-common-brain-access-proposal.md:284`). It also has operations that
need stronger authority: tier downgrades, brain egress-class downgrades,
quarantine approval, export, purge, and high-risk side effects
(`docs/45-ob1-common-brain-access-proposal.md:153`,
`docs/45-ob1-common-brain-access-proposal.md:176`,
`docs/45-ob1-common-brain-access-proposal.md:191`,
`docs/45-ob1-common-brain-access-proposal.md:199`).

Those are not just "local can receive bytes" decisions. They are approval
decisions.

Risk:

The implementation uses `read_egress_class=local_trusted` as the gate for every
special operation. Any local-trusted process can then approve quarantined rows,
downgrade tiers, publish private brains, export content, or purge audit history.
The sidecar turns from a read transport into a root ceremony with better
branding.

Required fix:

- Split caller egress class from authority/capability:
  `read_egress_class`, `actor_role`, `approval_presence`,
  `capabilities`, and `human_confirmation_id`.
- Local-trusted read access is necessary but not sufficient for review,
  downgrade, export, purge, or publish.
- Sidecar per-call approval must bind to the exact operation and target, not
  merely unlock a local-trusted session.

Acceptance gate:

A local-trusted pi session can read private content but cannot approve
quarantine, downgrade tier/brain class, export, or purge unless the matching
operation-specific capability and human confirmation are present.

### 8. MEDIUM -- `origin_egress_class` tracks writer path, not content adversariality

Rev 7 uses `origin_egress_class` as the trust spine for cloud-origin content
(`docs/45-ob1-common-brain-access-proposal.md:170`,
`docs/45-ob1-common-brain-access-proposal.md:171`,
`docs/45-ob1-common-brain-access-proposal.md:174`). That catches cloud harness
poisoning. It does not catch adversarial content imported by a local-trusted
process.

Example:

A local operator imports email, chat logs, issue comments, web pages, or docs
from an external system. The importer runs locally and may be `local_trusted`.
The content itself is still untrusted external text. If `origin_egress_class`
is stamped from the writer's egress class, the row looks local-trusted even when
the source is attacker-controlled. The injection just entered through the front
office instead of the clown hatch.

Required fix:

- Add a separate content provenance/trust dimension:
  `source_trust_class`, `content_origin`, or `adversarial_input_class`.
- `origin_egress_class` answers "which caller/write path contributed?"
  Content trust answers "should the bytes be treated as instructions/truth?"
- External imports default untrusted until reviewed or source-class policy says
  otherwise.
- The answer/tool-output provenance fields must carry both writer egress and
  content/source trust.

Acceptance gate:

A locally imported external email/web/chat row is readable according to its
sensitivity tier but marked untrusted for instruction/side-effect purposes even
though the importer was local-trusted.

## Acceptance Tests To Add

Add these on top of the Rev 7 inherited gates:

1. `private_local` explicit grant: a cloud-bound principal with explicit
   `brain_memberships` grant still cannot name, read, stat, graph, or mutate the
   brain outside the maintenance path.
2. Exposure history: a row read/projected/logged while `standard`, then raised
   to `restricted`, records prior cloud/materialized exposure and scrubs or
   marks derived artifacts.
3. Sink downgrade: making a graph/log/audit/backup sink cloud-agent-readable
   fails while restricted/private artifacts exist inside it.
4. Maintenance non-read: maintenance capabilities can repair specific targets
   but cannot return content, rollups, graph context, old_state, or private
   counts.
5. Stats clamp: restricted/private rows do not affect cloud-visible counts,
   top_people, source/type rollups, graph stats, telemetry counts, or
   maintenance summaries.
6. Side-effect enforcement: downstream side-effecting tools refuse actions
   derived from `side_effect_allowed=false` evidence.
7. Authority split: local-trusted read sessions cannot review, downgrade,
   publish, export, or purge without operation-specific capability and human
   confirmation.
8. Source trust: locally imported external content is marked untrusted for
   instruction/side-effect use even when written by a local-trusted importer.

## Bottom Line

Rev 7 is close enough that the remaining issues are implementation-shaping, not
architecture-resetting.

The biggest thing to fix before coding: separate current label from exposure
history, and separate "local may read this" from "local may trust or approve
this." Those are different states. Pretending they are one state is how the next
bug gets a nice name and a postmortem.
