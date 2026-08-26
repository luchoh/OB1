# PRD — Self-Improving System on OB1

Status: **Draft for review** (v3 — post-review; threat model as spine)
Date: 2026-08-25
Owner: luchoh
Authored: selfimprove pane (`wK:p2`)
Source material: `transcript.md`, `images/` (9 prompt screenshots)
Destination: OB1 `docs/` as the next numbered PRD. No new repo — see §6.

---

## 1. Summary

Build a **closed improvement loop** on top of the existing OB1 brain: a scheduled
process that reads where the operator corrected Claude, proposes concrete changes to
the operator's tooling, and routes every proposal through a human gate before anything
is applied.

This PRD does **not** build a knowledge base, an ingestion layer, or a retrieval
system. Those exist and are mature. The gap is the loop.

The loop's input is attacker-reachable and its output is its own instructions. That
property, not the feature set, is what shapes this document. **§5 is the spine; every
requirement in §8 exists to satisfy it.**

---

## 2. Background: the source framework

Austin Marchese's "B.U.I.L.D." framework (`transcript.md`) proposes: **B**ASE (a
`raw/` + `wiki/` folder knowledge base), **U**PLOAD (one-time bulk ingest),
**I**NFLOW (recurring sync pipelines), **L**OOP (an `improve-system` skill with a
three-tier approval gate), **D**RIVE (operating mindset).

Its durable contribution is the **approval spectrum**: full automation causes system
drift, reviewing every change is unsustainable, so AI takes low-stakes calls and the
human takes high-stakes ones.

Its storage design does not transfer. The `wiki/` exists only because plain files have
no retrieval — a workaround for a problem OB1 does not have.

---

## 3. Current state: what OB1 already provides

Measured 2026-08-24/25.

**Corpus:** 6,459 thoughts, 100% embedded. First capture 2026-03-15.

**Sources flowing:** chatgpt (3,082), claude (2,720), imap_attachment (539),
dictation (37), pi (24), codex (15), telegram (14), claude-code-memory (8), imap (5).

**Retrieval:** semantic search with recency decay, grounded Q&A (`ask_brain`), Neo4j
graph expansion, lineage/neighbour traversal, JSONB metadata filtering.

**Governance:** sensitivity tiers, egress classes, agent-estate multi-tenancy, thought
audit log (ADR-0009 refuses mutations without an audit actor).

**Existing skills that already cover framework steps:** `claudeception` (extracts
skills from sessions), `panning-for-gold` (voice dumps), `auto-capture` (session-end
capture), `weekly-signal-diff` (external signal), `heavy-file-ingestion`,
`meeting-synthesis`, `research-synthesis`.

**Conclusion:** BASE, UPLOAD and INFLOW are solved. Only the LOOP is missing.

---

## 4. Gap analysis

| Framework step | Status | Action |
| --- | --- | --- |
| BASE / UPLOAD / INFLOW (general) | **Superseded or done** | No action |
| INFLOW — Claude Code sessions | Sync repaired 2026-08-24; distillation absent | **C2** |
| **LOOP — improvement cycle** | **ABSENT** | **C3** |
| LOOP — scheduling | ABSENT | **C4** |
| DRIVE | Mindset, not software | N/A |

### G1 — Claude Code sessions do not reach the brain

**Status: FIXED, one residual open.** OB1 `d666f483` (5 renames of
`mcp__open-brain__capture_thought` → `mcp__ob1__capture_thought`; guard rail rewritten
so a failed capture is reported in session output; 1.0.0 → 1.1.0). system-config
`c3a0257` bumped the pin and rebuilt. Verified end-to-end, not by grep: thought
`22ca4283` in `agent-common` at 2026-08-25T02:26:39Z — first `claude-code-memory`
capture in 41 days.

**Residual:** verification exercised the *capture path*, not the *auto-trigger*. The
verifying session held a pre-rebuild skill catalog, so it followed corrected
instructions it had authored rather than a freshly-loaded deployed skill. That
autodream fires the skill unprompted is unproven and needs a fresh session.

**Why it matters beyond itself:** G1 is this system's reference failure. A skill sat
deployed and silently wrong for five weeks because nothing validated its declared
contract (G8b). Every "fails quietly" risk below is this shape.

### G2 — Nothing closes the loop

OB1 is capture + retrieval. No process asks *what should change about how I work*.
`claudeception` is closest but is reactive, single-session, and only ever emits skills.

### G3 — Nothing is scheduled

All pipelines are manually triggered. A loop that runs when remembered is not a loop.

### G4 — Metadata extraction degrades silently

Recent thoughts carry `metadata_extraction_error` (MLX endpoint HTTP 507, memory
ceiling). They embed but get no extracted topics, summary, or action items. Retrieval
quality decays quietly. Owned elsewhere; the loop inherits the damage.

### G5 — Credential reach determines what the loop can see

Two agents audited the same source and got 8 vs 1. Neither was wrong: this session
holds a `legacy_admin_key` (`reach: global_unscoped_legacy_admin`, effective brain
`luchoh`); the OB1 pane holds a repo key reaching `ob1` + `agent-common`.

**Any thought count is meaningless without naming credential and brain scope**, and a
repo-scoped loop cannot curate the 6,459-thought `luchoh` brain. Reach is a functional
requirement (R3.9), not a deployment detail.

**Live anomaly.** The admin key is still live in exactly one place: this pane
(`wK:p2`), the sole surviving pre-restart terminal. Every other live pane has a fresh
environment. Restarting the herdr server does not clean panes that outlive it. Nothing
should be called remediated while this pane is up, and **no part of C3 may be designed
assuming that reach.** Clearing it costs this session's context — operator's call.

`list_brains` / `list_principals` return 403 (`can_mint_repo_keys`) from both panes, so
estate topology could not be enumerated from either side.

### G6 — pi's ingest credential fails auth

pi hit `HTTP 401 Unauthorized` on `/ingest/thought` at ~16:30 on 2026-08-24. Did not
reproduce on a healthy repo key, so it is credential-specific, not server-wide.
Distinct from G1 — a bad tool name yields a resolution failure, not a 401. Unowned;
pi-originated captures are presumed lost meanwhile.

### G7 — Coordination has no durable audit trail

The G1 fix spanned two repos and two commits, coordinated entirely over Herdr panes,
which are live-only by design. A mailbox thread was written after the fact
(`agent-handovers/inbox/system-config/2026-08-25-ob1-autodream-sync-fixed-and-verified.md`,
`07a006f`). Same failure class as G1: **the loop consumes history, and history that
evaporates is not consumable.**

### G8 — Nothing validates a deployed skill's declared contract

*Standalone gap. Belongs to the system-config lane where `mkSkillSet` lives. Must not
block on this PRD.*

Deployed-versus-source cannot drift: `mkSkillSet` fetches a tarball at a pinned commit,
so the deployed tree *is* the pinned source. Three real gaps sit elsewhere.

**G8a — pin versus HEAD.** Nothing checks whether the pinned commit is current. A skill
fixed upstream and never pinned is invisible until someone thinks to look. That is the
five-week G1 window restated: the fix was never the problem, the missing check was.

**G8b — the tool contract exists and nothing reads it.** *(The check is one string
comparison; knowing to run it, and having somewhere it runs, is the actual work. The
five weeks reflect an absent mechanism, not negligence.)* Verified on the live tree
`d666f483…`:

- `ob1-autodream-brain-sync/metadata.json` declares
  `version 1.1.0`, `requires.tools: ["mcp__ob1__capture_thought"]`
- `~/.claude.json` registers `["aws-knowledge","aws-mcp","context7","ios-simulator","ob1","playwright"]`

A machine-readable assertion that a tool must resolve, sitting beside a registry that
answers the question. Had any mechanism compared the two at any point since
2026-07-16, G1 would have surfaced in one run.

**G8c — not every skill declares a contract.** `ob1-estate-setup` has no
`metadata.json`. A validator must treat *no declared contract* as a finding, not a
pass, or it reports green on skills it cannot see.

Incidental: 4 stale skill trees remain under `~/.local/share/ob1-skills/`
(`83a87c52`, `ad2d1048`, `deecd308`, plus the live `d666f483`) alongside `cage/`. Not
harmful, but a stale tree is something an agent can read by accident.

---

## 5. Threat model

**The loop's input is attacker-reachable and its output is its own instructions.**

Claude Code transcripts are not a conversation between operator and Claude. They
contain **untrusted third-party text**: fetched web pages, ingested mail (the operator
classifies mail as internet-open injection), and peer handovers — which
`agent-handovers`' own README declares untrusted peer input that *can never authorize
an action you would not otherwise take*.

### T1 — Injection to durable instruction

```
attacker-controlled text
  → lands in a transcript
  → appears INSIDE a correction cluster        (R2.4 narrows entry to this)
  → C2 distills that cluster into a thought
  → C3 reads it and proposes a skill / CLAUDE.md / memory edit
  → an auto-approve tier applies it
  → a pin bump + rebuild ships it              (human gate, semantically blind)
  → agents load it: fleet-wide for skills,
    per-repo or per-user for CLAUDE.md / memories
```

Two honest narrowings, stated because the narrower claim is harder to dismiss. Entry
requires the text to land inside a correction cluster, not merely anywhere in a
transcript. And deployment is not fully automatic: a human approves a pin bump and
runs a rebuild. **That gate is weaker than it sounds — the human approves a commit
range, not skill semantics** — which is more damning than claiming no gate exists.

Two fleet-specific aggravators:

- **Cage crossing.** `mkSkillSet` runs with `cageExpose = true`, so an accepted skill
  edit lands in pi's read-only cage mount — crossing the exact boundary the cage
  exists to enforce.
- **Silent persistence.** Nothing validates a deployed skill's *declared contract*
  (G8b). Deployed content cannot drift from its pinned source — the precise gap is that
  no one checks the assertions the skill itself makes. A malicious or merely wrong edit
  persists the same quiet way, for the same reason G1 did.

**No attack is asserted. The channel is asserted.** A self-improving loop must name
this before building, not discover it after.

**Mitigations:** R3.4 (no auto-approve for instruction surfaces), R3.5 (untrusted-span
provenance), R3.6 (hard constraint), G8 validator.

### T2 — Secret exfiltration through distillation

Measured over `~/.claude/projects` (filename counts only, no content read):

| Pattern (as run) | Files |
| --- | --- |
| Total session files | 733 (261 MB) |
| `OB1_MCP_ACCESS_KEY` | 177 |
| `x-access-key` | 169 |
| `Authorization: Bearer` | 34 |
| `AKIA[0-9A-Z]{16}` | 22 |
| `-----BEGIN [A-Z ]+PRIVATE KEY-----` (canonical PEM) | **0** |
| `BEGIN [A-Z ]*PRIVATE KEY` | 1 |
| `PRIVATE KEY` (loosest — mentions, not material) | 48 |

**Read these as regex artifacts, not facts about secrets.** Each row records the exact
pattern because the count is a property of the pattern: private-key hits range 0 → 48
across three reasonable regexes. An earlier draft asserted "6 private key blocks"; that
figure was irreproducible and is withdrawn. No canonical PEM header appears in the
corpus.

**The corpus is live and self-referential.** It is written continuously — the same
`BEGIN .*PRIVATE KEY` pattern returned 6 and then 7 within an hour, because sessions
were being appended while we measured. This session's own transcript is in the corpus
and contains every pattern in this table, since discussing them writes them. C2 would
therefore ingest transcripts *about* secrets alongside transcripts *containing* them,
and cannot distinguish the two by pattern alone.

The load-bearing rows are `OB1_MCP_ACCESS_KEY` (177) and `x-access-key` (169). They
are **upper bounds that include mentions**, not counts of exposed values.

The same self-referential mechanism contaminates them: this document's own authoring
session matches `OB1_MCP_ACCESS_KEY` 16 times, entirely from discussing it, and is one
of the 177. A variable *name* appears both where its value was echoed and where the
name was merely typed, and grep cannot separate the two.

These rows remain the table's best evidence for a reason the private-key row could not
claim: **the direction of the error is known and bounded.** A bare credential variable
name in a transcript is far more likely to sit beside its value than the words "private
key" are to sit beside key material. The count overstates by an unknown but one-sided
margin — never understates. That is a weaker claim than the previous wording and it is
the one the evidence supports.

`capture_thought` defaults to `sensitivity_tier=standard` and the egress flip is still
ahead. **C2 distilling every session walks this corpus into standard-tier thoughts by
default.**

**Mitigations:** R2.2 (redaction precondition), R2.3 (restricted tier, private_local
brain), R2.4 (narrow extraction).

### T3 — Echo chamber

A loop learning from its own transcripts mostly relearns the operator's existing
habits and launders them as improvement. Reading *only* existing thoughts is the same
failure by another road: thoughts are deliberate saves, so that path relearns what was
already written down.

**Mitigation:** R2.4 — extract correction moments, not sessions. The signal is where
the operator *disagreed*, which is precisely what nobody stops to save.

---

## 6. Decision

**OB1 is the substrate. Build the loop, not a second knowledge base. No new repo.**

The video's file design solves retrieval by hand-maintaining an index; OB1 solves it
with embeddings and a graph. Running both means two sources of truth and a `wiki/` that
drifts.

`~/Dev/selfimprove` is a design directory, not an OB1 consumer — no key, no brain, no
runtime call, no mailbox inbox. It should not become a repo. **This PRD lands in OB1
`docs/`; C2/C3 ship as skills in `OB1/skills/`, deployed by the same `mkSkillSet`
chain.** `transcript.md` and `images/` are consumed source material — Appendix A
captures what mattered.

### State placement

ADR-0011 (accepted 2026-08-25) moves ingest-daemon state into Postgres reached over
HTTP through the MCP server: *"The file works while exactly one process cares. It stops
working the moment a second one does."* That reasoning transfers — with one exception.

| State | Home | Why |
| --- | --- | --- |
| Watermarks / run state | **Postgres via MCP** | Per ADR-0011. Sole writer until it isn't |
| Change log | **Postgres via MCP** | Audit trail; answers to ADR-0009 audit actors |
| Review file | **Rendered file** | Its purpose is human editing in Obsidian. A checkbox list is UI, not state |
| Approval decisions | **Postgres via MCP** | The state *behind* the UI |

The review file is exempt because forcing a human interface into Postgres invents
mechanism to avoid an interface. But **the file being a file is not where the
split-brain lives** — see R3.8.

**Decision record shape.** Minimum columns: `proposal_id`, `render_revision`,
`verdict`, `actor`, `decided_at`, `evidence_set_hash`.

**"Moved" is defined**, or R3.8 cannot be implemented or tested. A proposal has moved
when either its **content hash** or its **evidence set hash** differs from the values
it was rendered with. Rank change alone is *not* movement — rank is presentation, and
treating it as movement would refuse decisions on every re-render.

**Audit actor (ADR-0009).** Mutations without an audit actor are refused, and "a human
ticked a box and the loop applied it" is exactly the case that ADR exists to make
explicit. The actor is recorded as the **operator, with the loop named as the
executing agent** — two fields, not one. The loop never records itself as the deciding
actor on an instruction surface.

**Inherited cost, stated plainly.** ADR-0011's Postgres half requires new MCP
endpoints, a migration, and a fleet-wide pin release — which is why it has not shipped.
C3's decision store inherits all three. **C3 therefore depends on ADR-0011 landing**
(reflected in §12), or ships against a documented interim: decisions appended to a
local append-only log with the same row shape, migrated when the endpoints exist. The
interim is acceptable *only* because the decision record is additive; the review file
and proposal ids do not change shape under migration.

---

## 7. Scope

**In scope:** C1 (done), C2, C3, C4, C5, C6.
**Out of scope:** any `raw/` or `wiki/` hierarchy; re-ingesting what OB1 holds; new
ecosystem connectors; rebuilding `claudeception` / `panning-for-gold` /
`weekly-signal-diff`; fixing G4; **G8's validator (system-config lane — related, not
blocked on this)**.

---

## 8. Requirements

### C1 — Repair the memory sync — **DONE 2026-08-24**

- **R1.1–R1.2** ✅ Tool name corrected; failures now reported in session output.
- **R1.3** Backfill existing `.claude/projects/*/memory/*.md` not already in OB1.
- **R1.4** Prove the auto-trigger fires in a fresh session (G1 residual).

### C2 — `sync-claude-sessions`

- **R2.1** Read session `.jsonl` newest-first against a watermark. Idempotent. Skip
  sessions modified in the last 10 minutes.

  **Stripping is scoped to capture, not to analysis.** Tool output, attachments and
  thinking are excluded from captured *content* — they are the bulk and the
  secret-bearing part — but their **provenance markers are retained**, along with a
  bounded excerpt wherever a correction refers to them. Stripping them outright would
  destroy the referent most corrections depend on (R2.4) and would leave R3.5 nothing
  to label as tool-derived, making it unenforceable on the exact category it exists to
  catch.
- **R2.2 — Redaction is a precondition, not a hardening pass.** No session content is
  distilled or captured until it passes redaction covering at minimum the T2 patterns
  (`OB1_MCP_ACCESS_KEY`, `x-access-key`, bearer tokens, `AKIA…`, private key blocks).
  A session that cannot be cleanly redacted is **skipped and reported**, never captured
  partially. Fail closed.
- **R2.3 — Restricted by default.** Captures use `sensitivity_tier=restricted` into a
  `private_local` brain. Never `standard`. This holds regardless of the egress flip.
- **R2.4 — Extract correction moments, not sessions.** The unit is the correction, not
  the session. Sessions containing no correction produce nothing. This is the T3
  mitigation and the cost control.

  **Cluster boundary.** A cluster spans three parts, not one:
  1. **Referent** — the preceding assistant action being corrected. "No, not like that"
     is uninterpretable without *that*.
  2. **Correction** — the operator's pushback itself.
  3. **Resolution** — the outcome. A correction whose fix did not work is noise being
     promoted to instruction.

  **Reversals are excluded.** Where the operator corrects and then later reverses
  within the same session — discovering the original approach was right — the loop must
  discard it. Without this the loop learns the retracted position.

  **Recall will be low, and that is expected.** The strongest corrections are often
  implicit: silently abandoning a path, rewriting the code by hand, re-asking the same
  question differently. Detection keyed on pushback phrasing will miss most of these.
  This is a stated limitation, not a defect to be discovered in step 3 of §12. Precision
  is preferred to recall — a missed correction costs a lesson; a hallucinated one
  becomes an instruction.
- **R2.5 — Provenance is structural, never inferred.** Each span records its origin
  (operator turn / assistant turn / tool result / fetched content) **derived from the
  JSONL record type and role fields — never from content the model interprets.**

  This is the difference between a control and a decoration. If provenance were inferred
  by a model reading the transcript, injected text could simply assert *the following is
  operator-authored*, and R3.5 would be defeated by the very manipulation it exists to
  stop — a judgement made by the component the threat model says is manipulable.

  **Any span whose origin cannot be derived structurally is untrusted by default.** Fail
  closed, per §9.
- **R2.6** Deliberately narrow: no cross-session analysis, theming, or skill
  suggestion. Those are C3's.
- **R2.7** Runs manually with zero arguments so it can be tested before scheduling.

### C3 — `improve-system`

- **R3.1 — Input.** Since the last run: new correction-derived thoughts, prior review
  decisions, and the change log.

- **R3.2 — Analysis.** Four target surfaces: `~/.claude/skills/**`, `CLAUDE.md`
  (global and per-repo), `.claude/projects/*/memory/**`, and OB1 hygiene
  (near-duplicates, extraction errors, stale facts, orphaned graph nodes).

- **R3.3 — Bucketing.** Three tiers, but see R3.4 for the hard boundary.
  - **AUTO-APPROVE** — applied immediately, logged.
  - **NEEDS SIGN-OFF** — rendered to the review file. Not applied.
  - **MORE CONTEXT REQUIRED** — rendered as questions.

- **R3.4 — Auto-approve may never write an instruction.** *(The central control.)*
  AUTO-APPROVE is confined to **brain hygiene that cannot alter behaviour**: dedupe,
  retag, fix broken references, flag extraction errors.

  **Skills, `CLAUDE.md`, and memories are the persistence boundary. For those surfaces
  the loop may PROPOSE and never APPLY** — including deletions, including cases where
  the operator appears to have already contradicted the item, including anything the
  loop judges obvious.

  **There is no graduation path.** No "approve and don't ask again" for instruction
  surfaces; that mechanism is exactly how auto-approve grows into T1. Graduation
  remains available for hygiene findings only.

- **R3.5 — Untrusted spans cannot author instructions.** *(Defence in depth. Not
  load-bearing — see the limit below.)* Using R2.5 provenance, a proposal whose
  supporting evidence derives from tool result, fetched content, mail, or peer handover
  is **ineligible for any instruction surface regardless of tier.**

  **Known limit: the operator turn is a relay, not a trusted channel.** The operator
  routinely pastes untrusted content into the prompt — peer-pane messages, error logs,
  mail excerpts, web snippets. This document is itself the proof: for several rounds the
  two authoring panes communicated by the operator hand-relaying text, which arrived in
  each session as an *operator turn*. Under a naive taxonomy that content is
  operator-authored and therefore eligible. **T1 is not severed by R3.5; it is rerouted
  through the human.** An attacker who gets text into a peer handover the operator then
  relays has laundered it into the one category R3.5 trusts.

  Consequently:
  - **Pasted or quoted content inside an operator turn is not operator-authored.**
    Detection is imperfect and will miss cases. That is stated, not assumed away.
  - **R3.5 is never a justification for widening R3.4.** No proposal is auto-approvable
    onto an instruction surface because it looks provenance-clean. That argument is the
    deleted graduation path returning through a side door.

  Untrusted-derived proposals are rendered to `outputs/untrusted-derived-<date>.md`,
  **capped and ranked identically to R3.10**, with withheld counts stated. An uncapped
  second list is a second unreviewed list.

- **R3.6 — Hard constraint.** Never modify `~/.claude/skills/**` or any `CLAUDE.md`
  without a checked box. No exceptions, no "obvious" cases. Note this reaches pi's cage
  via `cageExpose`.

- **R3.7 — Reversibility.** Every applied change records enough to undo it. Skill and
  `CLAUDE.md` edits go through git where the target is a repo.

- **R3.8 — The review protocol: optimistic concurrency on the human surface.**
  The split-brain is not that the review file is a file — it is the **gap between
  render and read**. The human approves the proposal as it stood on Tuesday; the loop
  applies the proposal as it stands on Thursday. ADR-0011 leaves this explicitly open:
  two writers require a designed protocol — a claim, a row version, or a lease.

  Therefore:
  - Every checkbox carries a **stable proposal id** and the **revision it was rendered
    from**.
  - Decisions are recorded **keyed by id, never by position in the file**. Positional
    parsing breaks the moment render order changes; ids are what make the surface
    disposable and re-renderable.
  - If the proposal has moved since render, the decision is **REFUSED and re-rendered**,
    never applied.

  Without this, a stale open review file is an approval oracle for a proposal nobody
  read. This also covers the case where the vault syncs across M2 and M4 and the *file*
  itself has two writers.

- **R3.9 — Declare reach.** Every run report states credential type, reach, and the
  brains actually queried; every count is qualified by that scope. If the loop cannot
  reach a brain in the estate, the report says so rather than reporting a clean bill of
  health for a corpus it never saw. **The loop must not assume admin reach** (G5).

- **R3.10 — Volume control.** Cap NEEDS SIGN-OFF items per run (default 10), stating
  how many were withheld. An unreviewable review file is an unreviewed review file.

  **Ranking is by evidence strength, defined** — this knob decides what the operator
  never sees, so it may not stay vague. In precedence order: (1) number of distinct
  correction clusters supporting the proposal; (2) number of distinct sessions those
  clusters span, so one long argument does not outrank a recurring pattern;
  (3) recency; (4) whether the proposal is reversible. Ties are broken toward the
  smaller blast radius. The ranking inputs are recorded per item so a withheld proposal
  can be audited.

### C4 — Scheduling

- **R4.1** Two schedules, not one, so failures are attributable: ingestion early,
  improvement later the same day.
- **R4.2** Twice weekly to start.
- **R4.3** Schedules invoke the skill **by name**, never an inlined copy.
- **R4.4** Nudge when a review file has sat unchecked for >N days.
- **R4.5** Mechanism per Q3.

### C5 — Diagnose pi's ingest credential (G6)

An actively failing credential deserves more than a heading — captures are being lost
now, not hypothetically.

- **R5.1** Identify which credential pi presents to `/ingest/thought`, and under which
  identity — pi runs caged and cannot reach herdr, so this is inspected from the host
  side.
- **R5.2** Determine whether rejected captures are **lost or queued for retry**. This
  decides whether the window since 2026-08-24 is recoverable or gone, and whether the
  fix needs a backfill.
- **R5.3** Name the owner. Split responsibility is why this is unowned: system-config
  holds the cage secret material; OB1 holds key state and the ingest endpoint. One of
  the two must own it explicitly.
- **R5.4** Make the failure visible. A 401 that only surfaces in a pane's scrollback is
  the G1 pattern; ingest auth failures must surface where someone sees them.

### C6 — Adopt the mailbox for durable cross-repo work (G7)

`~/Dev/agent-handovers` is the record for work the loop is expected to learn from.
Herdr coordinates live panes; it is not the audit trail.

---

## 9. Non-functional requirements

- **Idempotency.** Every pipeline safe to re-run.
- **Observability.** Each run records outcome, counts, skips and errors. **Silent
  success and silent failure are both defects** — see G1.
- **Fail closed.** Redaction failure, provenance gaps, and reach shortfalls all stop
  work and report, rather than proceeding on partial data.
- **Privacy.** Restricted tier by default (R2.3); no new egress paths.
- **Cost.** Bounded by R2.4 — correction clusters, not 733 sessions.

---

## 10. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| **Injection → durable instruction** (T1) | Attacker text becomes durable instruction, incl. pi's cage | R3.4 (primary), R3.6, G8; R3.5 as defence in depth only |
| **Injection laundered via operator relay** | Untrusted text pasted by the operator inherits operator-authored provenance, bypassing R3.5 | R3.4 — this is why auto-approve, not provenance, is the load-bearing control |
| **Secrets into the brain** (T2) | 6 private keys, 177 access-key hits become standard-tier thoughts | R2.2, R2.3 |
| **Echo chamber** (T3) | Habits laundered as improvement | R2.4 |
| **Silent failure** — the G1 shape | Loop looks healthy, does nothing | R1.2, R4.4, staleness check every run |
| **Stale approval** | Approving Tuesday's proposal, applying Thursday's | R3.8 |
| **Credential blind spot** (G5) | Clean bill of health on a corpus never seen | R3.9 |
| **Review fatigue** | Loop stalls at the gate | R3.10, R4.4 |
| **Garbage in** (G4) | Bad proposals from bad metadata | Skip thoughts with extraction errors; count them |
| **Ephemeral coordination** (G7) | No record of the work the loop should learn from | C6 |
| **Overlap with `claudeception`** | Two systems proposing skills | C3 delegates skill creation to it |

---

## 11. Open questions

- **Q1** Backfill depth for C2: all 733 sessions, the 617 from the last 30 days, or
  forward-only? Interacts with R2.2 — backfill is where redaction load concentrates.
- **Q2** May C3 propose changes to OB1 itself, or only to Claude tooling? Widening
  makes it genuinely self-improving and enlarges the blast radius.
- **Q3** Scheduling mechanism: cron tooling vs. desktop routines vs. launchd. Affects
  whether runs happen when Claude Code is closed.
- **Q4** *(blocking C3)* Which brain, under which credential? The corpus is in `luchoh`;
  the repaired sync routes `[reference]` memories to `agent-common`. A loop scoped to
  one cannot curate the other. Options: admin-reach and curate everything; repo-scoped
  and accept a partial view; or per-brain loops. **Settle before C3** — it determines
  what the loop can fix, and G5's live anomaly means the answer must not be "whatever
  reach the pane happens to have."
- **Q5** Does the `agent-estate` roadmap (`docs/29-*`, 12 revisions) already overlap C3?
  Not read for this PRD.

---

## 12. Sequencing

0. **C1** — ~~fix the sync~~ **DONE**. Remaining: R1.4 auto-trigger proof, R1.3 backfill.
1. **Settle Q4** — credential and brain scope. Blocks C3 (G5).
2. **C2** — with R2.2 redaction working *first*. Run manually; backfill per Q1.
   *(C2 is independent of ADR-0011; only C3's decision store depends on it.)*
3. **Verify distillation quality by hand** before automating on top of it.
4. **C3** — run manually; review the first outputs closely. **Depends on ADR-0011's
   Postgres half** (new MCP endpoints, migration, fleet pin release) or ships against
   the documented interim log in §6. Decide which before starting, not during.
5. **C4** — schedule only after 2 and 4 have proven themselves manually.

In parallel, unblocked: **G8** validator (system-config lane), **C5** (pi's 401),
**C6** (mailbox adoption).

---

## Appendix A — Source prompts

Nine prompts extracted from the video as screenshots in `images/`:

| Screenshot (time) | Creates |
| --- | --- |
| 16.43.53 (~1:02) | Three-folder knowledge base |
| 16.44.29 (~1:54) | Combined base setup + `add-new-resource`, with interview step |
| 16.45.09 (~2:43) | Session-history analysis; skills for tasks repeated ≥3× |
| 16.45.40 (~3:41) | Machine scan + email export |
| 16.47.24 (~4:11) | One-session bulk ingest |
| 16.48.50 (~5:34) | `sync-claude-sessions` skill |
| 16.49.21 (~6:54) | `sync-ecosystem-data` skill, with run history |
| 16.49.59 (~8:57) | All three sync skills, with `_candidates/` staging |
| 16.50.29 (~10:54) | **`improve-system` — the three-bucket design** |
| 16.50.53 (~13:20) | `data-ingestion` orchestration skill |

A tenth (16.48.29) shows the author's finished `sync-claude-sessions` in a terminal,
confirming the friction-first summary shape and idempotency design.

**Adopted:** the three-bucket gate, friction-first extraction, strict separation of
sync from analysis, skill-referencing schedules, watermarks, staging over applying.

**Rejected:** `raw/`, `wiki/`, `add-new-resource`, the bulk-ingest prompts, and the
ecosystem/curated sync skills — all superseded by OB1.

**Rejected on threat-model grounds (§5):** the source framework's auto-approve tier as
specified. It permits applying skill edits without review, which is T1's final step.
R3.4 narrows it to hygiene.

---

## Appendix B — Provenance of this document

Findings were produced by two agents auditing each other.

- The **selfimprove pane** (`wK:p2`) authored the document, diagnosed G1, and measured
  G5.
- The **OB1 pane** (`wB:p1`) proposed the §5 threat model, surfaced the T2 counts,
  supplied G8, and supplied R3.8's render-versus-read protocol.

Positions changed in both directions: the OB1 pane withdrew a recommendation to read
thoughts instead of transcripts; this pane withdrew the auto-approve tier for
instruction surfaces and its graduation path.

**Declared conflict:** the OB1 pane reviews this document, and §5 is its argument.
An author reviewing his own argument should be named rather than assumed away — flagged
at that pane's own request. Reviewers should weight §5 and R3.8 accordingly.

**Corrections that ran both ways on the same number.** This pane corrected the OB1
pane's private-key count from 1 to 6; the OB1 pane could not reproduce 6 and was right
not to. Re-measurement showed the figure is an artifact of regex choice (0 canonical
PEM headers, 1, 7, or 48 depending on pattern) and that it drifts between runs because
the corpus is written continuously. **The "6" is withdrawn.** The T2 table now records
the exact pattern per row. The credential-key rows (177, 169) were reproduced by both
panes and are what T2 rests on.

The episode is the document's own thesis in miniature: a number neither author could
reproduce survived two rounds of review because both were confident and neither
re-ran it.

**Unverified by this pane:** the estate's full brain topology (403 from both sides) and
the `agent-estate` roadmap overlap (Q5).
