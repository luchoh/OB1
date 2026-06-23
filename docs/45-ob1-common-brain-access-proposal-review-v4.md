# 45 Proposal Review V4 -- Red-Team Findings

**Date:** 2026-06-24
**Reviewer:** Codex
**Reviewed target:** `docs/45-ob1-common-brain-access-proposal.md` Rev 4

## Verdict

Rev 4 folded the v3 findings cleanly. The important stuff is now in the doc:
capture-upsert, monotonic taint, pre-processor egress checks, pi as a distinct
principal, and request-context telemetry redaction. Annoying competence. It
happens.

The remaining problems are narrower and uglier:

1. The pi sidecar can become a confused deputy if any same-user cloud harness can
   call it.
2. "Quarantine" is not real until every read/projection/stats plane excludes
   quarantined rows by default.
3. Capture needs a **preflight** against existing `dedupe_key` rows before
   embedding/extraction, not only before the final update.
4. Request-context controls need a brain-level egress/trust class, not vibes
   inferred from slugs or future operator memory.
5. Monotonic taint is security state; if the DB lets future code overwrite it,
   the label is still washable.

No fatal architectural reversal. Just the usual: every nice abstraction needs a
boring enforcement seam or it turns back into marketing.

## Findings

### 1. HIGH -- The pi sidecar is a confused deputy unless it authenticates the caller

Rev 4 adds concrete custody language for pi's local-trusted credential:
sidecar/session broker/keychain helper, no repo env, no MCP config, no command
args (`docs/45-ob1-common-brain-access-proposal.md:169`). That is the right
direction. But the proposal still does not define how the sidecar decides the
caller is pi rather than Codex.

Abuse path:

If the sidecar exposes a localhost port, Unix socket, launchd service, or helper
command reachable by the same OS user, a cloud harness does not need to steal
the bearer. It invokes the broker and lets the broker inject pi's bearer. That
is not "key theft"; it is a confused deputy. Same corpse, cleaner paperwork.

Impact:

This defeats the Rev 4 architectural correction. pi is a distinct principal in
the database, but Codex can ride pi's transport if the transport only proves
"same user on the same box." The proposal's accepted residual is active
same-user theft (`docs/45-ob1-common-brain-access-proposal.md:51`), not an
always-on helper that willingly signs requests for any local process.

Required fix:

Define the sidecar's caller-binding contract:

- The sidecar must require an unforgeable per-session capability not present in
  the repo, shell env, command args, MCP config, or logs.
- The sidecar must bind that capability to pi's session/process/TTY, or require
  an explicit local human approval step for new callers.
- If it is a socket, file permissions alone are insufficient under the same-user
  threat model; require an application-level handshake or client credential.
- Add a negative test: a process launched from the repo cloud-agent shell cannot
  use the sidecar to call OB1 as pi even when it can reach localhost and the
  filesystem.

### 2. HIGH -- Quarantine must be a global retrieval/materialization state, not an ask-only rule

Rev 4 says `cloud_origin + restricted` rows are not trusted local private and
must be disallowed, quarantined, excluded, or visibly marked
(`docs/45-ob1-common-brain-access-proposal.md:162`). Good. But the enforcement
language mostly names `ask_brain`/retrieval. That is too narrow.

Runtime evidence:

- Graph projection scans all thoughts and has no tier, origin, or quarantine
  predicate (`local/open-brain-mcp/src/graph-projection.mjs:71`).
- Projected Thought nodes include `summary` and `content_preview`
  (`local/open-brain-mcp/src/projection-planner.mjs:1232`).
- `brainStats` aggregates directly from `thoughts` and metadata without tier,
  origin, or quarantine predicates (`local/open-brain-mcp/src/thought-store.mjs:495`).
- `readThoughtRowsByIds` rehydrates full rows by id with only brain/deleted/filter
  predicates (`local/open-brain-mcp/src/thought-store.mjs:435`).

Abuse path:

A cloud harness writes `restricted` poison into a shared brain. The row is marked
"quarantined" in metadata or a future column. If only `ask_brain` honors that
state, the row still reaches list/search, graph projection, graph expansion,
stats, calibration export, or operator enrichment. Then local tooling consumes
the poison through the side door. Very OB1: the graph remembers what the guard
forgot.

Required fix:

Make quarantine a first-class store predicate:

- Add a structured `trust_state`/`review_state` column, not a loose metadata
  convention.
- Default `cloud_origin + restricted` to non-retrievable until reviewed.
- Apply the predicate to active SQL reads, `readThoughtRowsByIds`, stats, graph
  projection, graph reads/expansion, telemetry result ids, calibration sampler,
  and operator enrichment.
- Add a test proving a quarantined row is absent from every materialization plane
  except an explicit local-trusted review endpoint.

### 3. MEDIUM/HIGH -- Capture conflict policy must preflight before processor calls

Rev 4 correctly says capture is an upsert and the conflict path must be
tier-aware (`docs/45-ob1-common-brain-access-proposal.md:151`). It also says
processor trust must be checked before outbound embed/extract calls
(`docs/45-ob1-common-brain-access-proposal.md:135`). The missing join is this:
for a dedupe collision, the operation's effective tier is the **existing row's
current tier**, not just the requested tier.

Runtime evidence:

- `handleCaptureThought` currently authorizes brain WRITE, then starts
  `extractMetadata` and `createEmbedding`, then calls `captureThought`
  (`local/open-brain-mcp/src/server.mjs:310`).
- `captureThought` only discovers the conflict inside the insert/upsert
  statement (`local/open-brain-mcp/src/thought-store.mjs:85`).

Abuse path:

A caller submits `sensitivity_tier=standard` with a `dedupe_key` that collides
with an existing `restricted` row. If implementation checks only the requested
tier before embedding, it treats the operation as standard until the upsert
conflict is discovered. The update may be denied later, but the handler has
already performed processor side effects and created timing/error oracles. The
existing row's tier should have controlled the operation from the start.

Required fix:

Capture must perform a preflight lookup by `(brain_id, dedupe_key)` before
embedding/extraction:

- Compute `effective_tier = max(requested_tier, existing_current_tier)` using
  fail-closed ordering.
- If existing row is `restricted`/`personal` and caller is `cloud_bound`, deny
  before any upstream processor call.
- If allowed, lock the row or make the final upsert re-check the same condition
  atomically to avoid TOCTOU.
- Add tests for requested-standard capture colliding with existing-restricted,
  including "zero upstream requests."

### 4. MEDIUM/HIGH -- Request-context redaction needs a brain-level egress class

Rev 4 says telemetry redaction keys off request/caller context, private brains,
and tier-unknown states (`docs/45-ob1-common-brain-access-proposal.md:143`).
Correct. But the proposal does not define how the runtime knows a brain is
private before rows are fetched.

Runtime evidence:

- `brains` has a free-form `kind` column, but no enforced egress/trust class
  (`local/open-brain-mcp/migrations/005_household_multitenancy.sql:16`).
- `fetchBrainCatalog` selects id, slug, and estate id, not kind or sensitivity
  (`local/open-brain-mcp/src/auth.mjs:125`).
- Telemetry currently records `brain_id`, `brain_slug`, and
  `requested_brain_slug` directly from `accessContext`
  (`local/open-brain-mcp/src/observability.mjs:127`).

Risk:

"Private brain" becomes an operator convention. Telemetry, processor policy,
graph projection, and stats need a machine-readable brain classification before
content exists or rows are materialized. Without it, redaction depends on
remembering which slug is spicy. Strong system design, if the system is a sticky
note.

Required fix:

Add an explicit brain-level egress/trust class:

- Example: `brains.egress_class` or constrained `brains.kind` values with
  `public`, `repo`, `private_local`, `quarantine_review`.
- Include it in access context / catalog resolution.
- Use it for telemetry redaction, processor policy, graph projection eligibility,
  stats aggregation, and unscoped fanout decisions.
- Add migration constraints and tests for private-brain zero-result and failed
  requests producing no slug/id/query leakage in agent-readable telemetry.

### 5. MEDIUM -- Monotonic taint needs DB enforcement, not only application discipline

Rev 4 says `origin_egress_class` is sticky and may never wash from cloud to local
(`docs/45-ob1-common-brain-access-proposal.md:162`). That is correct. It is also
exactly the sort of invariant future scripts and "one quick migration" will
break unless the database refuses it.

Runtime evidence:

- The existing tier column is plain text today (`docs/45-ob1-common-brain-access-proposal.md:67`).
- The proposal already recognizes DB-level constraints are required for
  `sensitivity_tier`, but does not make the same DB-level requirement explicit
  for monotonic origin taint.
- Operator tooling currently reads Postgres directly and patches via generic
  admin routes (`scripts/thought_enrichment/lib/db.py:68`,
  `scripts/thought_enrichment/lib/db.py:228`).

Risk:

The first implementation can be perfect and the second importer can still
overwrite `origin_egress_class='local_trusted'`. If the taint controls trust,
the DB must reject impossible transitions. "Please do not launder this" is not
an invariant. It is a vibe with SQL access.

Required fix:

Make origin taint database-enforced:

- Constrain allowed values.
- Add a trigger or controlled stored procedure that permits only monotonic
  transitions: `local_trusted -> cloud_origin` is allowed, `cloud_origin ->
  local_trusted` is rejected.
- Include the rule in backfill/import migrations and tests.
- Require all direct operator paths to use the same DB function or fail CI.

### 6. MEDIUM -- Retention/backup/log-shipping policy is still an open hole, not a later nicety

Rev 4 treats telemetry, purge audit, errors, and operator diagnostics as
private-derived planes, then leaves per-store retention/redaction as an open
decision (`docs/45-ob1-common-brain-access-proposal.md:190`). That is still a
hole because the proposal now depends on derived artifacts being outside
cloud-harness reach.

Runtime evidence:

- Telemetry appends JSONL locally and includes query/result/error fields today
  (`local/open-brain-mcp/src/observability.mjs:161`).
- Purge audit snapshots old content and metadata
  (`local/open-brain-mcp/src/thought-store.mjs:386`).
- `requestJson` currently throws upstream URL/body text
  (`local/open-brain-mcp/src/models.mjs:284`).

Risk:

Even if runtime responses are clean, backups, log collectors, telemetry files,
diagnostic bundles, and purge audit exports can carry the private-derived data.
If a cloud agent can read those files in the repo/workspace or if log shipping
sends them to a cloud service, the egress boundary moved, it did not vanish.
Classic enterprise magic trick. Bad hat, same rabbit.

Required fix:

Do not defer this past v1:

- Define which artifact stores may contain private-derived data.
- Place them outside repo/cloud-harness reach.
- Set retention and redaction rules per store.
- Add tests or repo checks that telemetry, diagnostics, and audit exports do not
  land under repo paths or agent-readable runtime artifact dirs for private
  requests.

## Acceptance Tests To Add

Add these on top of the Rev 4 adopted gates:

1. A repo-launched same-user process cannot invoke the pi sidecar/session broker
   as pi without the pi-bound out-of-band capability.
2. A `cloud_origin + restricted` quarantined row is absent from search, list,
   ask, stats, graph projection, graph expansion, calibration export, and
   operator enrichment unless an explicit local-trusted review endpoint is used.
3. Capture preflight denies requested-`standard` dedupe collision against an
   existing `restricted` row before any embedding or metadata extraction request.
4. Private-brain zero-result and failed requests redact brain slug/id, query
   preview, processor URL, and upstream body using a real brain egress class.
5. The database rejects `origin_egress_class` laundering from cloud-origin back
   to local-trusted, including direct SQL/import/backfill attempts.
6. Private-derived telemetry, diagnostics, purge audit exports, and backup
   artifacts are not written to repo paths or cloud-agent-readable artifact dirs.

## Bottom Line

Rev 4 is close enough that the remaining failures are implementation discipline,
not theory collapse.

The next wall is enforcing the new nouns. A sidecar must authenticate pi, a
quarantine must cover every materialization plane, a capture conflict must be
classified before processors run, and taint must be a DB invariant. Otherwise
the design gets to be right while the implementation quietly goes around it.
Same building, different unlocked door.
