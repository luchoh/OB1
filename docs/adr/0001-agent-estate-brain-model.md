---
status: accepted
date: 2026-06-02
---

# Agent estate + per-repo brains + cross-brain memberships

## Context

OB1's tenancy model (migration 005) introduces households, brains,
principals, and brain memberships. Today, exactly one household
(`local-household`), one principal (`luchoh`), and two brains exist;
the second brain (`household`) is empty. The model was designed for
multi-human use (family) but currently runs as a single-tenant.

We want **agents** (Claude Code, Codex, Gemini, ChatGPT, Cursor, etc.)
to capture and recall thoughts in OB1 with these properties:

1. Per-repo isolation — thoughts captured while working in repo X land
   in a brain dedicated to repo X.
2. Cross-repo recall — agents can also write to and read from a
   **common brain** that all repo agents share.
3. Operator visibility — the human operator (`luchoh`) can peek into
   any agent brain.
4. Privacy — the operator's wife's brain stays private; her access is
   not affected by the operator's permissions.

The existing schema does not naturally express "operator can see all
agent brains, but not wife's brain" because access today is
membership-on-individual-brains only, with no estate-level (household-
level) inheritance.

## Decision

Adopt these design points (each from a question in the grilling
session that produced this ADR):

1. **Agents reuse the existing principal model.** A repo principal is
   a `brain_principals` row with `principal_type='agent'`. Same table,
   same columns; behavior diverges in code, not schema.

2. **Permission model: allowlist with brain-level deny override.**
   Default deny. Two ways to grant: estate-level membership (broad —
   all brains in the estate) or brain-level membership (specific). A
   brain-level DENY row overrides an estate-level ALLOW. Estate-level
   DENY does not exist (not needed; absence is denial).

3. **Brains belong to exactly one estate.** A brain that needs to be
   "shared" is granted membership rows from principals in other
   estates; the brain itself stays in one estate. No brain-floats-
   between-estates semantics.

4. **Repo principals are created manually.** A CLI script provisions
   `(repo-principal, repo-brain, memberships)` as a unit. No
   auto-creation on first capture.

5. **Principal granularity = per repo, not per agent tool.** All AI
   tools (Claude Code, Codex, Gemini, ChatGPT, Cursor) working in
   repo X share principal `repo-x` and the same access key. Tools are
   interchangeable; the workspace is the identity.

6. **Per-repo `.envrc` carries the access key.** Direnv loads
   `MCP_ACCESS_KEY` on shell entry; agents inherit. Switching repos =
   `cd` somewhere else = different key.

7. **Capture brain selection: skill-driven, agent-decided per call.**
   A SKILL.md instructs the agent: "Capture to **common** when the
   thought is about a tool/technique/operator-preference not specific
   to this codebase. Capture to **repo** otherwise. When in doubt,
   repo." The agent picks per call.

8. **Repo principal slug = short, human-chosen.** `ob1`,
   `system-config`, `dotfiles`. Not `owner/repo`, not URL hashes.

9. **Brain selection on the wire: `brain` parameter on each tool.**
   Move from "access key implies brain" to "access key identifies
   principal; tool calls carry an explicit brain (slug or UUID)."
   Server validates membership before acting.

10. **Default brain when omitted: `principal.default_brain_id`.** The
    schema already has this column. For repo principals, default is
    the repo brain.

11. **Search defaults to ALL accessible brains.** `search_thoughts` /
    `list_thoughts` / `ask_brain` / `stats` with no `brain` argument
    span every brain the principal has membership for, with
    per-row `brain_id` / `brain_slug` in results. Agent narrows by
    passing `brain=...`.

12. **Rollout: big-bang migration.** Default-to-default-brain (point
    10) is the back-compat shim — existing callers that don't pass
    `brain` keep behaving as today. New cross-brain effects only
    activate when new memberships are granted.

## Vocabulary (CONTEXT.md-bound)

The grilling session also surfaced one renaming candidate:

- **household → estate**, with the existing `households` table to be
  renamed in a separate migration. This ADR uses "estate" throughout;
  schema / code uses `household` until the rename lands.

The new noun is "estate" because:

- The existing `household` is human-centric (family). Adding agents
  under the same word is semantically loaded.
- "Estate" works for both human and agent groupings without implying
  family.
- This is a non-blocking rename — code keeps working under the old
  name until the migration runs.

## Consequences

**Positive:**

- Repo agents have isolated knowledge stores by default.
- Common knowledge surfaces across all repo agents automatically (via
  search broadening + the curation discipline in the skill).
- Operator visibility into agents is one membership row away;
  spouse-privacy is preserved by absence of memberships, not by
  special rules.
- Existing callers (Telegram bridge, FastAPI ingest,
  autodream-brain-sync skill) keep working unchanged because of the
  default-brain shim.

**Negative:**

- Adds a new table (`estate_memberships`) plus a deny semantics; reads
  must consult both estate-level and brain-level membership tables.
- Search broadening across multiple brains adds query fanout (small N
  in practice, parallel-and-merge in the application).
- The skill-driven brain selection (point 7) puts the routing burden
  on prompts. Drift over time will require skill tuning, similar to
  the existing thought-classification taxonomy concern (PRD-25 §2.3).

**Mitigations:**

- Search queries fan out across the principal's accessible brains; on
  rare slow days this is observable and we can add a multi-brain
  variant of `match_thoughts` that takes an array.
- A future audit (per ADR-27) will let us inspect which brains
  receive what classes of thoughts and refine the skill rule.

## See also

- PRD `docs/29-agent-estate-implementation-roadmap.md` — the
  implementation plan derived from this ADR.
- PRD `docs/17-local-household-multitenancy-prd.md` — the original
  household multitenancy design that this builds on.
- ADR `docs/27-adr-thought-audit-log.md` — the audit log; this ADR
  reinforces that future write surfaces (edit, delete, brain-grant,
  brain-revoke) must emit audit rows.
