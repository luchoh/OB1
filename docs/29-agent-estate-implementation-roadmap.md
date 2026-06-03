# PRD: Agent Estate + Brain Selection — Implementation Roadmap

Date: 2026-06-02
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`,
           CONTEXT `CONTEXT.md`

## Summary

Implement the design from ADR-0001 in a sequence that preserves
backward compatibility throughout. Existing single-tenant traffic
(bootstrap-admin key, Telegram bridge, FastAPI ingest, autodream-
brain-sync skill) keeps working at every step.

The end state:

- An **agent estate** sits alongside `local-household`. It contains
  one **repo principal** per code repository (slug = repo name) plus
  the **common brain** (one brain shared via memberships across all
  repo principals).
- Each repo principal owns a **repo brain** for its workspace.
- Per-repo `.envrc` carries the repo principal's access key.
- AI tools call MCP tools with an explicit `brain` parameter (slug
  or UUID) per call. Capture defaults to the principal's default
  brain when omitted; search defaults to all accessible brains.
- The operator (`luchoh` principal in `local-household`) has an
  estate membership in the agent estate, granting visibility into
  all agent brains.

## Goals

- Land per-repo agent isolation with cross-repo recall.
- Preserve operator visibility into agent activity without granting
  human-side access to other humans' estates.
- Avoid breaking any existing capture or retrieval path during
  rollout.

## Non-goals

- Human-side multi-tenancy (multiple human estates, federated
  identities, OIDC binding). The schema supports it; this work item
  doesn't exercise it.
- Renaming `households` → `estates` at the database level. Cosmetic
  rename; tracked separately.
- Edit / delete capabilities on thoughts. Pre-condition for ADR-27
  thought-audit, not in scope here.

## Phasing

Each phase is independently deployable.

### Phase 1 — Schema: cross-estate access primitives

**Migration 009** adds `estate_memberships` and a deny flag on
`brain_memberships`.

```sql
-- estate_memberships
create table if not exists estate_memberships (
  principal_id uuid not null references brain_principals(id) on delete cascade,
  estate_id uuid not null references households(id) on delete cascade,
  role text not null,
  is_deny boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (principal_id, estate_id)
);

create index if not exists estate_memberships_estate_idx
  on estate_memberships (estate_id);

-- brain_memberships gets a deny flag for the override path
alter table brain_memberships
  add column if not exists is_deny boolean not null default false;
```

(Names use `estate_id` even though the FK target is `households(id)`
— column name is forward-looking; rename is later.)

No code changes in this phase. The new table/column exists, nothing
reads them yet. Safe to apply to prod.

### Phase 2 — Server: brain parameter on tools

Every MCP tool (`capture_thought`, `search_thoughts`, `list_thoughts`,
`stats`, `ask_brain`, `expand_context`, `graph_neighbors`,
`source_lineage`, `why_connected`) gains an optional `brain` parameter
(string — UUID or slug).

Resolution order, server-side:

1. If `brain` is set:
   - resolve to a `brain_id` (UUID-ish input → direct lookup; slug-ish
     input → look up in `brains` table by slug, scoped to brains the
     principal could plausibly access — i.e., either in the principal's
     own estate, or via brain/estate membership);
   - validate the principal has access to it (membership check, see
     §"Access check" below);
   - if no access → 403.
2. If `brain` is not set:
   - **Capture / write tools** → use
     `brain_principals.default_brain_id`. If null, error with a clear
     message ("principal X has no default brain; pass `brain=<slug>`").
   - **Read tools** → use the full set of brains the principal has
     access to (§"Access check"); fan out, merge results, dedup.

**Access check** (single helper, used everywhere):

A principal P has access to brain B if any of the following is true,
in order:

1. There exists a `brain_memberships` row `(P, B)` with
   `is_deny = false`. → **ALLOWED** (regardless of estate-level state).
2. There exists a `brain_memberships` row `(P, B)` with
   `is_deny = true`. → **DENIED** (overrides estate-level allow).
3. B is in estate E and there exists `estate_memberships (P, E)` with
   `is_deny = false`. → **ALLOWED**.
4. Otherwise → **DENIED**.

Brain-level rows (1, 2) win over estate-level rows (3) because they
are more specific, matching ADR-0001 point 2.

Existing `accessContext.effectiveBrainId` becomes
`accessContext.defaultBrainId` for the capture path; the read paths
move to a list of accessible brains computed via the access-check
helper.

Read fanout is **N parallel queries merged in JS** (not a SQL change);
N is the count of accessible brains. Acceptable until N grows past
~10 in practice.

Telemetry: every read records `accessible_brain_count` and
`searched_brain_count`; capture records the resolved
`destination_brain_id`.

This phase is observably backward-compatible: existing callers don't
pass `brain`, so capture goes to the principal's default brain
(today, `effectiveBrainId`), and search broadens to "all accessible
brains" — but accessible brains is currently 1 (the bootstrap-admin
principal owns one brain), so behavior is unchanged in practice.

### Phase 3 — Provisioning: agent estate + repo principals

A small CLI (`scripts/agent_estate/provision.py` or extension of an
existing admin script) that, given a repo slug:

1. Creates the agent estate if not exists (singleton).
2. Creates the **common brain** in the agent estate if not exists
   (singleton).
3. Creates a repo principal `<slug>` in the agent estate.
4. Creates a repo brain `<slug>` in the agent estate.
5. Sets the repo principal's `default_brain_id` to its repo brain.
6. Adds:
   - `brain_memberships(<repo-principal>, <repo-brain>, role='owner')`
   - `brain_memberships(<repo-principal>, <common-brain>, role='member')`
7. Generates a fresh access key, hashes and stores in
   `brain_access_keys` scoped to the repo principal (no `brain_id` —
   the principal can use it across all its accessible brains).
8. Prints the plaintext access key once. Operator stashes it where
   the agent will read it (per phase 4).

The script is idempotent on principal/brain creation
(`ON CONFLICT DO NOTHING` semantics by slug); access-key generation
is single-shot per invocation (each run yields a new key). For
key rotation: a separate `rotate-key` subcommand.

The first run also seeds an **operator estate membership** for the
human principal `luchoh`:

```
estate_memberships(luchoh, <agent-estate>, role='admin', is_deny=false)
```

This is the "operator can peek into agent area" rule from ADR-0001.
Spouse-privacy is preserved by absence of any membership in her
future estate; this provisioning never touches it.

### Phase 4 — Per-repo `.envrc` rollout

For each repo we want agents in:

- Add to the repo's `.envrc`:
  ```
  export MCP_ACCESS_KEY=<repo principal's key>
  export OPEN_BRAIN_BASE_URL=http://127.0.0.1:8788
  ```
- Verify direnv allows the repo (`direnv allow`).
- Confirm AI tools running in that repo see the env (CLI tools do
  automatically; clients with their own MCP config inherit env at
  process start).

The key file itself is gitignored. The repo's tracked `.envrc`
sources a local untracked `.env.local` or similar, depending on
existing repo conventions.

### Phase 5 — Skill: brain selection

Author `skills/agent-brain-routing/SKILL.md` (and ship it through the
same system-config Nix path as `live-retrieval`, doc 26):

```
Capture rules:

- Use brain="agent-common" when:
  (a) the thought is about a tool, technique, or pattern not
      specific to one codebase;
  (b) the thought is a meta-observation about how to collaborate or
      what the operator prefers across all work;
  (c) the thought is a fact about the operator's environment /
      infrastructure that any agent might need.

- Otherwise omit `brain` (capture goes to the repo brain by default).

When in doubt: capture to repo. Common is curated.

Search rules:

- Default search (no `brain` argument) returns hits from all
  accessible brains. Use this most of the time.
- Pass brain="<slug>" only when scoping is genuinely needed (e.g., to
  exclude common brain noise on a focused recall).
```

The skill is one file, ships once, applies to all AI tools that read
SKILL.md.

### Phase 6 — Migrate existing writers

This is incremental, not a hard cutover. Each writer gets updated to
pass `brain` explicitly when it makes sense:

- **Telegram bridge** keeps writing without a `brain` arg → captures
  go to the bridge principal's default brain (presumed to remain the
  human `luchoh` brain).
- **FastAPI ingest paths** (document, dictation, email) — same.
- **Autodream-brain-sync skill** — could optionally start passing
  `brain="luchoh"` explicitly, or leave the default. No change
  required.
- **Telegram bridge admin patch path** (`/admin/thought/metadata`) —
  no change; admin path already takes `thought_id`.

No writer is forced to change; the default-brain rule covers them.

## Acceptance criteria

For each phase:

**Phase 1:**
- ☐ Migration 009 applied on dev. `\d+ estate_memberships` shows the
  table; `\d+ brain_memberships` shows the new `is_deny` column.
- ☐ No regression on existing flows (re-run smoke tests for capture
  and search).

**Phase 2:**
- ☐ A capture call with no `brain` argument lands in the principal's
  default brain (verified by querying `thoughts.brain_id`).
- ☐ A search call with no `brain` argument returns hits from all
  brains the principal has membership for. (Initially N=1, so this
  is a no-op until phase 3 lands.)
- ☐ Passing `brain="ob1"` (slug) resolves to the right UUID and
  returns 403 if the principal lacks membership.
- ☐ A capture call with `brain="some-disallowed-brain"` returns 403
  and writes nothing.

**Phase 3:**
- ☐ Provisioning script can be re-run and is idempotent (no duplicate
  estates, no duplicate brains).
- ☐ A new `agent-estate` exists in `households` (or its rename) with
  one common brain.
- ☐ Each repo invocation creates one principal + one brain + two
  memberships (repo brain owner, common brain member).
- ☐ The operator (`luchoh`) has an `estate_memberships` row in the
  agent estate with `role='admin'`, `is_deny=false`.

**Phase 4:**
- ☐ From within `/Users/luchoh/Dev/OB1` shell, `echo $MCP_ACCESS_KEY`
  shows the OB1 repo principal's key (not the bootstrap-admin key).
- ☐ A capture from inside the OB1 shell with no `brain` arg lands in
  the `ob1` brain (verified by querying `brain_id`).

**Phase 5:**
- ☐ `skills/agent-brain-routing/SKILL.md` exists in the repo.
- ☐ System-config handoff doc written (companion to doc 26 pattern).

**Phase 6:**
- ☐ Existing writers continue to function unchanged. No regressions.

## Risks and mitigations

- **Phase 2 read fanout latency.** With 3-5 accessible brains it's
  fine. With 20+ it would matter; we're nowhere near that. If we
  ever are, add a `match_thoughts_multi(brain_ids[], ...)` SQL
  variant.
- **Phase 3 forgets to grant operator estate membership.** The
  provisioning script does this on first run; subsequent runs check
  for the row and skip. Manual verification is part of acceptance.
- **Phase 4 forgets to gitignore the per-repo key file.** Use
  `.envrc` that sources a `.env.local` (already gitignored
  convention). Reviewer-checks during repo onboarding.
- **Phase 5 skill drift.** The skill rule is judgment-based; agents
  will inevitably misroute some captures. Mitigation: the operator
  has visibility into both repo and common brains and can move
  thoughts post-hoc (once a `move_thought` capability exists; not
  in this PRD). Until then, drift is observable but not fixable
  in-place.
- **`brain_memberships.is_deny` introduces a small semantic risk:**
  someone might add a deny row thinking it temporarily blocks access
  but forget to remove it. Mitigation: deny rows are rare by design;
  the provisioning script never creates them. They're a manual,
  deliberate operator action.

## Out of scope

- Renaming `households` → `estates` at the schema level.
- A `move_thought` MCP tool (move a thought between brains).
- A `grant_brain_access` MCP tool exposing membership management as
  callable.
- Federated identity (`principal_identity_bindings` table is unused
  today; this work doesn't change that).
- Agent-side write authorization checks (e.g., "Codex can only write
  via `capture_thought`, not via `update_thought_metadata`"). The
  current admin endpoint already requires admin-flagged keys.

## Open questions

None blocking phase 1. Phases 3-5 will surface these as we go:

- Should the **operator's estate membership** in the agent estate
  default to `role='admin'` or just `role='member'`? Practically,
  what role-based auth does the server enforce? Today, role is
  recorded but not consulted. Phase 2 is the right time to wire it
  if we want enforcement.
- Should the **common brain** be `kind='shared_household'` or a new
  `kind='agent_common'`? Cosmetic. Default to existing flavor for now.
