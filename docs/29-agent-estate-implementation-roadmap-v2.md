# PRD: Agent Estate + Brain Selection — Implementation Roadmap (v2)

Date: 2026-06-02
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`,
           CONTEXT `CONTEXT.md`,
           review `docs/29-agent-estate-implementation-roadmap-review-v1.md`
Supersedes: `docs/29-agent-estate-implementation-roadmap.md` (v1)

## Why v2

v1 was reviewed and rejected. The direction is sound; the rollout is not.
Six findings were valid against the code as it actually runs:

1. v1 introduced `estate_memberships.is_deny`, contradicting ADR-0001
   which explicitly chose **brain-level deny only**.
2. v1 added a `brain` argument to graph tools without addressing the
   admin-only gate that protects them today; the underlying graph queries
   are not brain-qualified at all.
3. v1 claimed "behavior unchanged" on the back-compat path, but the
   actual local runtime uses the **legacy admin key path** in
   `auth.mjs`, which is principal-less and global — separate from any
   stored-key path.
4. v1 only updated MCP tool argument schemas. The runtime exposes
   several non-MCP HTTP surfaces (`/ingest/thought`, `/ask`,
   `/admin/thought/metadata`, `/admin/thought/similar`, `/graph/*`)
   that all resolve through `effectiveBrainId`. `/admin/thought/metadata`
   in particular silently 404s when `brain_id` mismatches.
5. v1 added a 4th brain selector (tool-arg) without saying which selector
   wins when route, header/query, and tool-arg disagree. The runtime
   already has three selectors today (`POST /mcp/brains/:brainSlug`,
   `?brain=`, `x-brain-slug`).
6. v1 said multi-brain reads should carry per-row `brain_id` and
   `brain_slug` (per ADR-0001) but the response-shape change was
   not part of the plan.

This v2 addresses each finding directly and reorganizes the phase plan
around the actual auth and HTTP surfaces in the codebase, not just the
MCP tool surface.

## Vocabulary recap

Defined in `CONTEXT.md`. Quick reference for this PRD:

- **Estate** — top-level container (currently `households` table).
- **Repo principal** — `brain_principals` row with
  `principal_type='agent'`, slug = code repo name. Shared by all AI
  tools running in that repo.
- **Repo brain** — brain owned by a repo principal in the agent estate.
- **Common brain** — single brain in the agent estate, with brain
  memberships granted to every repo principal.
- **Default brain** — `brain_principals.default_brain_id`. Where a
  capture lands if the caller does not specify a brain.
- **Legacy admin context** — auth path active when the request key
  equals `config.accessKey`. Principal-less, `isAdmin=true`. Used by
  most local scripts and smoke flows today.
- **Stored-key context** — auth path used when the request key matches a
  hashed row in `brain_access_keys`. Tied to a real principal.

## Goals

- Per-repo agent isolation with cross-repo recall via a common brain.
- Operator visibility into all agent brains via estate-level membership.
- **Zero regressions** on existing legacy-admin-key callers (Telegram
  bridge, FastAPI ingest, autodream-brain-sync skill, smoke scripts,
  `scripts/thought_enrichment/*`).
- Honest accounting of which surfaces become multi-brain-aware in this
  work and which remain single-brain (admin-only) until follow-up work.

## Non-goals

- Renaming `households` → `estates` at the schema level (cosmetic).
- Edit / delete capabilities on thoughts (precondition for ADR-27).
- Multi-brain graph queries. Graph tools stay admin-only until
  graph-projection brain scoping is implemented (separate work item).
- Federated identity (`principal_identity_bindings` is unused today).

## Design decisions, post-review

These are the new commitments that v1 lacked. They drive the phase plan
below.

### D1. Estate membership has no deny rows

`estate_memberships` is allow-only. The migration **does not** add an
`is_deny` column. The only deny mechanism is at the brain level.

This matches ADR-0001 point 2 exactly. v1's `is_deny` on estate rows is
removed.

### D2. Canonical brain selector + ambiguity rule

The runtime currently accepts brain context from four places:

1. Route: `POST /mcp/brains/:brainSlug` (`auth.mjs:367`).
2. Query string: `?brain=<slug>` (`auth.mjs:227-231`).
3. Header: `x-brain-slug: <slug>` (`auth.mjs:233-236`).
4. **NEW (this PRD):** tool argument: `brain` parameter on tool calls.

Resolution rule:

- **At most one of {route, query, header} may be present.** If two
  disagree, the request returns **400 Bad Request** with a message
  naming both.
- **If a route/query/header brain is set AND a tool-arg brain is set,
  they must resolve to the same brain.** Disagreement → 400.
- **Within tool calls of one MCP session**, the per-call `brain`
  argument is authoritative. The route/query/header value (if any) is
  the **session default**, not a hard binding.
- **Slug ambiguity across estates** (where one principal can see two
  brains with the same slug because they live in different estates):
  if the principal's accessible brains include more than one brain with
  the requested slug, return **409 Conflict** and instruct the caller
  to pass a UUID. The server logs slug→UUID candidates so the operator
  can disambiguate.

UUIDs are accepted everywhere a slug is. UUIDs always disambiguate.

### D3. Legacy admin context is preserved as-is, with a contract

The local `MCP_ACCESS_KEY === config.accessKey` path
(`auth.mjs:367-381`) keeps working unchanged. Specifically:

- It remains principal-less, `isAdmin=true`, `effectiveBrainId` =
  requested brain or `resolveDefaultAdminBrain()`.
- It is the **only** auth path that bypasses estate/brain membership
  checks. No other call site gets that privilege.
- Callers using legacy admin keys are: Telegram bridge, dictation
  ingest, FastAPI document/email ingest, autodream-brain-sync skill,
  `scripts/thought_enrichment/*`, `scripts/backfill-chat-claim-typing.py`,
  the smoke harness in `scripts/smoke-open-brain-running-service.sh`.
- For these callers, **single-brain semantics remain.** The principal's
  default-brain rule does not apply — there is no principal. Brain
  selection comes from the request (route/query/header/tool-arg, per
  D2). With nothing specified, `resolveDefaultAdminBrain()` continues
  to return the canonical default.
- Multi-brain search defaults **do not apply to legacy admin
  context.** A search with no brain spec returns hits from
  `effectiveBrainId` only. Anything else is a footgun against scripts
  that expect single-brain results.

This is a **first-class branch in the access-check helper**, not an
edge case to paper over. New work that depends on principals
(estate/brain membership lookups) is a no-op for legacy admin context
and explicitly documented as such.

### D4. Phase scope is cut to MCP tools + selected HTTP surfaces

v1 implicitly assumed Phase 2 covered everything. v2 names exactly
which surfaces become multi-brain-aware in this work and which do not.

**In scope for Phase 2:**
- MCP tools: `capture_thought`, `search_thoughts`, `list_thoughts`,
  `stats`, `ask_brain`.
- HTTP: `/ingest/thought`.

**Explicit changes to non-MCP HTTP surfaces:**
- `/admin/thought/metadata` — change WHERE clause from
  `(id, brain_id)` to `(id IN principal's accessible brains)`. For
  legacy admin context, behavior unchanged. For stored-key context,
  any thought in any accessible brain can be patched. Validated via
  membership check before the UPDATE. **This is the only HTTP write
  surface that actively breaks under v1's plan; v2 fixes it
  explicitly.**
- `/admin/thought/similar` — read path, same treatment.
- `/ask` — same as MCP `ask_brain`.

**Out of scope for this PRD (kept admin-only or single-brain):**
- All `/graph/*` endpoints. Graph projections are not brain-qualified
  in their underlying queries (`graph.mjs` walks canonical IDs without
  brain filters). Cross-brain graph results would leak and produce
  false paths. Graph tools (`graph_neighbors`, `source_lineage`,
  `why_connected`, `expand_context`) **remain admin-only** until graph
  scoping work lands. The `ensureGraphAdmin()` gate in `server.mjs:773`
  stays in place. The MCP tool argument `brain` is **not added** to
  graph tools in this PRD. Adding it later is a separate, smaller PRD
  that depends on graph-projection brain qualification.
- The future ADR-27 thought-audit endpoint, when it lands, must apply
  the same access-check helper this PRD introduces.

### D5. Multi-brain reads carry brain origin in the response

For every read tool (`search_thoughts`, `list_thoughts`, `ask_brain`)
that may return rows from more than one brain, every result row gains:

- `brain_id: uuid`
- `brain_slug: text`

`stats` aggregates per-brain when multi-brain. New shape:

```json
{
  "success": true,
  "scope": "multi" | "single",
  "brains": [
    { "brain_id": "...", "brain_slug": "ob1", "total": 6772, "embedded": 6772, ... },
    { "brain_id": "...", "brain_slug": "agent-common", "total": 12, "embedded": 12, ... }
  ]
}
```

Existing single-brain stats responses keep their shape under
`scope="single"`.

### D6. Telemetry update

`observability.mjs` logs one `brain_id` and one `brain_slug` per
request today. For multi-brain reads, telemetry becomes:

- `brain_scope: "single" | "multi" | "legacy_admin"`
- `searched_brain_ids: uuid[]` (the actual fanout set)
- `result_brain_ids: uuid[]` (distinct brains in result rows)

Single-brain reads keep the old shape; multi-brain reads add the
arrays. `payload.brain_id` becomes the *primary* brain (the requested
brain, or the principal's default) for compatibility.

### D7. No estate-rename in this work

`households` stays `households` in SQL. New code uses local variable
names like `estateId` for forward compatibility, but DDL stays in
"household" terminology. Cosmetic rename happens after the agent
estate model is verified working.

## Phasing

Each phase is independently deployable. Acceptance criteria below cover
both the legacy admin path AND the stored-key path explicitly.

### Phase 1 — Schema: cross-estate access primitives

Migration **`009_estate_memberships.sql`**:

```sql
-- estate-level allow rows (no deny)
create table if not exists estate_memberships (
  principal_id uuid not null references brain_principals(id) on delete cascade,
  household_id uuid not null references households(id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  primary key (principal_id, household_id)
);

create index if not exists estate_memberships_household_idx
  on estate_memberships (household_id);

-- brain-level deny override on the existing memberships table
alter table brain_memberships
  add column if not exists is_deny boolean not null default false;

-- a partial index to make the access-check helper fast
create index if not exists brain_memberships_principal_active_idx
  on brain_memberships (principal_id, brain_id)
  where is_deny = false;
```

No code reads these columns in Phase 1. Safe to apply to dev and prod
independently of any code change.

**Acceptance:**
- ☐ `\d+ estate_memberships` shows the table without an `is_deny`
  column.
- ☐ `\d+ brain_memberships` shows the new `is_deny` column with default
  `false`.
- ☐ Re-run smoke tests for capture/search/admin patch — no regression.

### Phase 2a — Server: access-check helper

A single helper, used everywhere brain access is gated:

```js
// returns: { allowed: boolean, reason: string | null }
async function checkBrainAccess({ accessContext, brainId }) {
  // 1. legacy admin: bypass membership check
  if (accessContext.authSource === "legacy_admin_key") {
    return { allowed: true, reason: "legacy_admin_key" };
  }
  // 2. stored-key path
  // brain-level explicit deny → DENY (most specific)
  // brain-level explicit allow → ALLOW
  // estate-level allow on the brain's estate → ALLOW
  // otherwise → DENY
  ...
}

// returns: { brainIds: uuid[], reason: string }
async function listAccessibleBrainIds({ accessContext }) {
  // legacy admin: [accessContext.effectiveBrainId]
  // stored-key: union of (brain memberships allow) and
  //   (brains in estates where principal has estate membership)
  //   minus (brain memberships deny)
}
```

These helpers ship together with no caller changes yet. They have unit
tests that cover:

- Legacy admin → allowed, reason `legacy_admin_key`, accessible
  brains = `[effectiveBrainId]`.
- Stored key with no estate membership, no brain membership → denied.
- Stored key with brain membership (allow) → allowed.
- Stored key with estate membership only → allowed for any brain in
  that estate.
- Stored key with estate membership AND brain-level deny → denied for
  that brain only.
- Stored key with estate membership in estate A and brain-level allow
  in estate B → allowed in both.

**Acceptance:**
- ☐ Helpers exported, tested, no caller change.
- ☐ Test suite green on every case above.
- ☐ Smoke script still passes (legacy-admin path unchanged).

### Phase 2b — Selector unification

Implement the D2 rule in `resolveAccessContext`:

- Detect simultaneous route+query, route+header, query+header — return
  400 with both names.
- Cache the route/query/header brain on `accessContext` as
  `accessContext.sessionBrain` (UUID + slug, optional).

Tool-arg vs session-brain disagreement is detected per-tool in Phase 3.

Slug→UUID resolution: when looking up a slug for a stored-key principal,
search the union of (the principal's estate's brains) and (brains the
principal has any membership row on). If two matches in that set, 409.
For legacy admin, slug lookup is global as today.

**Acceptance:**
- ☐ Setting `?brain=ob1` and `x-brain-slug: agent-common` returns 400.
- ☐ Setting `?brain=ob1` alone is honored unchanged.
- ☐ A stored-key principal with two estate memberships on estates that
  both contain a `default` brain returns 409 with both UUIDs in the
  error body.
- ☐ Legacy admin key resolves slugs globally as today.

### Phase 2c — Tool & HTTP surfaces: brain parameter, defaults, deny

For each surface in scope (D4):

**`capture_thought`, `/ingest/thought`:**
- Accept optional `brain` (slug or UUID) on the body.
- Tool-arg vs session-brain disagreement → 400.
- Resolve to UUID using stored-key slug lookup (Phase 2b).
- Run `checkBrainAccess`. If denied → 403.
- If no brain specified:
  - Stored-key: use `principal.default_brain_id`. If null → 400.
  - Legacy admin: use the existing `resolveDefaultAdminBrain()` flow
    (unchanged).
- Write the thought.

**`search_thoughts`, `/admin/thought/similar`, `ask_brain`, `/ask`:**
- Accept optional `brain` on tool args.
- If `brain` is set: scope to that brain (after access check).
- If `brain` is not set:
  - Stored-key: scope to `listAccessibleBrainIds()`.
  - Legacy admin: scope to `[effectiveBrainId]` (unchanged behavior).
- Fan out search per brain in parallel; merge by similarity; tag every
  result row with `brain_id` and `brain_slug` (D5).

**`list_thoughts`:**
- Same multi-brain scoping rules.
- Result rows tagged with `brain_id`/`brain_slug`.
- Cross-brain ordering by `created_at DESC`.

**`stats`:**
- Returns the new `scope` + `brains` shape (D5) when multi-brain;
  legacy single-brain shape preserved when scope is single.

**`/admin/thought/metadata`:**
- Change WHERE from `(id, brain_id)` to `(id IN listAccessibleBrainIds())`.
- For legacy admin: WHERE is unchanged (uses `effectiveBrainId`).
- The 404 footgun for stored-key callers patching cross-brain thoughts
  is fixed.

**`/graph/*` and graph MCP tools:**
- **Unchanged.** `ensureGraphAdmin()` still gates them. No `brain`
  parameter added. Documented as future work.

**Acceptance (legacy admin):**
- ☐ Smoke script (using `MCP_ACCESS_KEY=config.accessKey`) passes
  unchanged.
- ☐ Telegram bridge captures continue landing in the existing
  default brain.
- ☐ `scripts/thought_enrichment/*` continue to work without changes.
- ☐ Admin `/admin/thought/metadata` patches return success on the
  same input that worked before.

**Acceptance (stored-key, single brain):**
- ☐ A stored-key principal with one accessible brain captures with
  no `brain` arg → lands in default brain.
- ☐ Search with no `brain` arg returns single-brain hits as today.

**Acceptance (stored-key, multi-brain):**
- ☐ Capture with `brain="ob1"` lands in `ob1` brain.
- ☐ Capture with `brain="agent-common"` (where principal has membership)
  lands in `agent-common`.
- ☐ Capture with `brain="other-tenant"` (where principal has no
  membership) returns 403, no row written.
- ☐ Search with no `brain` arg returns hits from all accessible brains;
  every row carries `brain_id` and `brain_slug`.
- ☐ Search with `brain="ob1"` scopes to that brain only.
- ☐ `/admin/thought/metadata` with a `thought_id` from `agent-common`
  succeeds when called by a principal that has membership on
  `agent-common`, even though their default brain is `ob1`.
- ☐ Same call returns 403 if the principal has no membership on
  `agent-common`.

**Acceptance (selector disagreement):**
- ☐ `POST /mcp/brains/ob1` + tool-arg `brain="agent-common"` → 400.
- ☐ `?brain=ob1` + `x-brain-slug=agent-common` → 400.
- ☐ Two route/query/header sources matching the same UUID → allowed.

### Phase 3 — Provisioning CLI (unchanged from v1)

`scripts/agent_estate/provision.py`. Idempotent. See v1 §Phase 3 for
the unchanged steps. One addition:

- Verify the operator's `estate_memberships` row in the agent estate
  is created on first run (it was a manual step in v1's prose; making
  it part of the script removes the "operator forgets to grant
  themselves" risk).

**Acceptance:**
- ☐ Re-running provision is idempotent (no duplicate estate, no
  duplicate brain, no duplicate access key — script either rotates
  or refuses, depending on `--rotate-key` flag).
- ☐ Operator (`luchoh`) has an `estate_memberships(luchoh, agent-estate, role='admin')`
  row after first run.
- ☐ Operator can search across the agent estate's brains using their
  existing access key (verified via the smoke flow in Phase 2c
  acceptance).

### Phase 4 — Per-repo `.envrc` (unchanged from v1)

For OB1 first; other repos follow the same pattern.

**Acceptance:**
- ☐ From `/Users/luchoh/Dev/OB1` shell, `MCP_ACCESS_KEY` resolves to
  the OB1 repo principal's key (not legacy admin).
- ☐ Capture from inside the OB1 shell with no `brain` arg lands in
  the `ob1` brain.
- ☐ Capture with `brain="agent-common"` lands in the common brain.
- ☐ The smoke harness running outside any repo continues to use the
  legacy admin key path (unchanged).

### Phase 5 — Routing skill (largely unchanged from v1)

`skills/agent-brain-routing/SKILL.md`. Captures rule from v1.

System-config Nix handoff to deploy to `~/.claude/skills/`, mirroring
the live-retrieval pattern from doc 26.

### Phase 6 — Migrate writers (revised from v1)

v1 said "no writer changes." v2 is honest: most writers don't change,
but **`/admin/thought/metadata` callers do benefit from the relaxed
brain check.** Specifically:

- `scripts/thought_enrichment/*` — no change. Still uses legacy admin
  key. Still hits one brain.
- `scripts/backfill-chat-claim-typing.py` — no change.
- `scripts/smoke-open-brain-running-service.sh` — no change.
- Telegram bridge — no change.
- FastAPI document/dictation/email ingest — no change.
- Autodream-brain-sync skill — could optionally start passing
  `brain="luchoh"` once it has a stored-key principal. For Phase 6
  this stays a no-op.
- The future `update_thought_mcp` (when implemented) and any new
  agent-side write tools must use the access-check helper from
  Phase 2a. Documented as a contract, not enforced by code.

**Acceptance:**
- ☐ Existing writers unchanged. No regressions.

## Risks and mitigations (revised)

- **Legacy admin path drift.** Anyone changing the auth code in the
  future must remember legacy admin is its own branch. Mitigation:
  the access-check helper has a hard short-circuit on
  `authSource === "legacy_admin_key"`, and tests cover both branches
  explicitly.
- **Multi-brain search latency.** With N=2-5 accessible brains the
  parallel fanout is fine. With N=20+ it would matter; we are not
  there. If we are, add a `match_thoughts_multi(brain_ids[])` SQL
  variant. Already discussed in v1.
- **Slug ambiguity surfaces only after the operator has multiple estate
  memberships.** Today there's one estate; the 409 path is dormant
  until that changes. Test it with a synthetic second-estate scenario
  in Phase 2 acceptance.
- **`/graph/*` cross-brain leakage.** Mitigation: not changing graph
  tools at all in this PRD. They stay admin-only. Future work tracks
  in a follow-up doc and in `docs/12-graph-augmentation-prd.md`'s
  successor.
- **`/admin/thought/metadata` semantic shift.** Stored-key callers
  start being able to patch cross-brain thoughts. Risk: a principal
  with `agent-common` membership patches a thought it didn't write.
  Mitigation: this is the intended model; a future audit log
  (ADR-27) will record who patched what. Not blocked on this.

## Out of scope, tracked separately

- Renaming `households` → `estates` (cosmetic; future migration).
- Brain-qualified graph projections + multi-brain graph queries.
- `update_thought_mcp` and `delete_thought_mcp` (precondition: ADR-27
  audit log).
- Thought-audit log (ADR-27).
- Recurring backup design (task #14).

## Open questions

- Should the legacy admin key path be **deprecated** once stored-key
  flows cover its use cases? Today it's load-bearing for many scripts
  and bridges. v2 keeps it as a first-class branch indefinitely.
  Future ADR may revisit.
- Should `estate_memberships.role` enforce anything (`admin` vs
  `member`)? Today the schema records it; the access-check helper
  ignores it. Phase 2 punt: roles are recorded for forward
  compatibility, not consulted.
- Should the multi-brain `stats` shape be the **default** even for
  single-brain scope, to make the response shape uniform? v2 keeps
  the legacy single-brain shape because too many callers parse it.
  Revisit if the multi-brain shape becomes universally expected.
