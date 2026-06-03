# PRD: Agent Estate + Brain Selection — Implementation Roadmap (v5)

Date: 2026-06-02
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`,
           CONTEXT `CONTEXT.md`,
           reviews v1, v2, v3, v4
Supersedes: v1, v2, v3, v4

## Why v5

v4 was rejected on three real bugs and two secondary gaps. The recurring
pattern across reviews is: the model has **layers** (selector
resolution → auth context → access check → handler logic), and bugs
appear when any layer leaks state into another. v5 makes the layering
explicit and addresses each finding by tightening seams rather than
patching symptoms.

The five rewrites:

1. **Legacy admin metadata patch — promote the body `brain` field
   into the auth selector model, OR drop the non-default-brain
   patch claim.** v4 split D6 and D7 across incompatible stories.
   v5 picks **drop** — see D6 + D7. Legacy admin remains strictly
   single-brain, period. Enrichment scripts that need cross-brain
   metadata patch use the operator path (Phase 6) instead.
2. **Human-token sessions stay route/connector-scoped.** No per-call
   brain switching. v4's "human can pass `brain=` on a tool call to
   switch" violates `docs/17:250,548`. v5 removes that path.
3. **Operator-script auth gets its own env var.** Not `MCP_ACCESS_KEY`,
   which collides with the repo-shell `.envrc`. New
   `OB1_OPERATOR_ACCESS_KEY`. Plus an **upfront brain-authorization
   preflight** before any row is processed.
4. **Stored household-scoped `is_admin` keys are constrained.** Today
   nothing prevents minting one. v5 doesn't outlaw them but adds an
   explicit policy: only the bootstrap path mints `is_admin=true`,
   and the provisioning CLI refuses to create new ones without a
   `--allow-admin` flag.
5. **`stats` `scope` shape spelled out.** v4 referenced it without
   defining the input. v5 makes `scope` a server-derived response
   field (not an input), and pins the legacy single-brain shape to a
   specific set of auth contexts.

## Vocabulary recap

Defined in `CONTEXT.md`. Quick reference:

- **Auth source** — `human_token`, `service_key`, `legacy_admin_key`.
- **Brain-bound key** — `service_key` with `brain_access_keys.brain_id != null`.
- **Operator stored key** — non-admin, non-brain-bound `service_key`
  for principal `luchoh`, paired with
  `estate_memberships(luchoh, agent-estate, role='admin')`.
- **Selector layer** — the resolution of "which brain is this request
  about?" Composed of:
  - **Auth selector** (route slug, query string, `x-brain-slug`
    header) — bound at `resolveAccessContext` time, before body parse.
  - **Tool-arg selector** (the `brain` field on a tool call body or
    arg) — bound inside the handler, after body parse.
  The auth selector establishes the **session context**. The tool-arg
  selector applies **per-call** within that session. They live at
  different layers and cannot substitute for each other.

## Layering model (new in v5)

To keep the seams clean, v5 names the four layers and assigns each
finding to exactly one:

```
   ┌──────────────────────────────────────────────────┐
   │ L1. Selector resolution (route/query/header)      │
   │     → produces accessContext.sessionBrain         │
   └────────────────────┬─────────────────────────────┘
                        │
   ┌────────────────────▼─────────────────────────────┐
   │ L2. Auth context (auth source, principal,         │
   │     householdId, key.brain_id, isAdmin,           │
   │     sessionBrain) — resolved once per request     │
   └────────────────────┬─────────────────────────────┘
                        │
   ┌────────────────────▼─────────────────────────────┐
   │ L3. Per-call brain resolution (tool-arg `brain`)  │
   │     → resolves tool-arg slug to a UUID using      │
   │       listAccessibleBrainIds. Detects             │
   │       sessionBrain disagreement → 400.            │
   └────────────────────┬─────────────────────────────┘
                        │
   ┌────────────────────▼─────────────────────────────┐
   │ L4. Access check (read or edit)                   │
   │     → ALLOW/DENY based on auth source +           │
   │       memberships + role + brain UUID.            │
   └──────────────────────────────────────────────────┘
```

Three rules fall out of the layering:

- **A body field never crosses up into L1 or L2.** That is what
  Codex Finding 1 proved against v4. Body fields are L3-and-below.
- **A tool-arg `brain` cannot widen L1's session context.** It can
  pick a brain WITHIN the auth context's accessible set; it cannot
  bypass the auth selector's binding.
- **Each auth source declares its session-brain semantics at L1/L2.**
  `human_token` binds session brain at L1 and L3 cannot override it
  to a different brain. `service_key` non-brain-bound has no L1
  session brain by default; L3 is fully open within L4's accessible
  set. Spelled out in D6 and D9.

## Goals

- Per-repo agent isolation with cross-repo recall via the common
  brain.
- Operator visibility into agent brains via stored-key + estate
  membership.
- Zero regressions on legacy-admin and human-token contracts.
- Enrichment / backfill scripts succeed against any brain via the
  operator path, with upfront authorization and clear error messages.
- Every write surface that becomes cross-brain capable does so
  through L4, not through ad-hoc body fields.

## Non-goals

- Renaming `households` → `estates`.
- Edit / delete capabilities beyond `/admin/thought/metadata`.
- Multi-brain graph queries.
- Federated identity for agents.
- Telegram bridge wrapper changes (cross-repo).
- Outlawing existing `is_admin=true` stored keys (constraining new
  ones, not retroactive).

## Design decisions

### D1. Estate membership is allow-only (unchanged)

`estate_memberships` has no `is_deny`. Brain-level deny is the only
deny.

### D2. Selector model — strict layering (Finding 1 fix; refined)

L1 selector sources, in order of precedence (still at most one of
{route, query, header}):

- Route: `POST /mcp/brains/:brainSlug`.
- Query string: `?brain=<slug>`.
- Header: `x-brain-slug: <slug>`.

Two simultaneous L1 sources disagreeing → 400.

L1 produces `accessContext.sessionBrain` (UUID + slug, or null).

L3 selector source: tool-arg `brain` field on a tool call (MCP) or
HTTP body field on a non-MCP route.

L3 rules:

- If `sessionBrain` is set AND tool-arg `brain` is set: they **must
  resolve to the same UUID**, else 400.
- If `sessionBrain` is null and tool-arg `brain` is set: tool-arg
  resolves via `listAccessibleBrainIds` (D8).
- If both null: handler default (D9, varies per auth source).

A body `brain` field is **not promoted to L1**. It is L3-and-below.
That means a request authenticated as `legacy_admin_key` cannot use
a body `brain` field to escape its single-brain auth context.

### D3. Operator path — stored key + estate-admin (unchanged from v4)

Existing principal `luchoh` in `local-household` gets:

- A new stored access key: `is_admin=false`, `brain_id=null`.
- `estate_memberships(luchoh, agent-estate, role='admin')`.

Operator's home env exports
`OB1_OPERATOR_ACCESS_KEY=<this stored key>`. This is **not**
`MCP_ACCESS_KEY` (collision avoidance — Finding 3 fix; see D10).

Scripts that need operator-level cross-brain rights (enrichment,
backfill, future audit-replay) read `OB1_OPERATOR_ACCESS_KEY`
explicitly and reject `MCP_ACCESS_KEY` as a fallback (so they don't
silently degrade to the repo principal key when run from a repo
shell).

### D4. Phase scope

**Multi-brain capable after this PRD:**
- MCP tools: `capture_thought`, `search_thoughts`, `list_thoughts`,
  `stats`, `ask_brain`.
- HTTP: `/ingest/thought`, `/ask`, `/admin/thought/similar`.

**Treated as deliberate write-surface expansion:**
- `/admin/thought/metadata` — D7. Cross-brain capable for
  service_key/human_token via L4 (memberships and role). **NOT**
  cross-brain for legacy_admin_key.

**Out of scope (admin-only, single-brain):**
- All `/graph/*` endpoints. `ensureGraphAdmin()` (`server.mjs:773`)
  unchanged. No `brain` parameter added.

### D5. Multi-brain reads carry brain origin (Finding 5 fix)

Every multi-brain read row gains `brain_id` and `brain_slug`.
`stats` returns:

```json
{
  "success": true,
  "scope": "multi" | "single" | "legacy",
  "brains": [...],            // present when scope=multi
  "brain_id": "...",          // present when scope=single or legacy
  "brain_slug": "...",
  "total": 6772,              // present when scope=single or legacy
  "embedded": 6772,
  ...
}
```

`scope` is a **server-derived output field**, not an input. The
server picks based on auth context:

- `legacy_admin_key`: `scope = "legacy"`. Single-brain shape with
  fields at top level (preserves today's response shape exactly).
- `human_token`: `scope = "single"`. Single-brain shape (preserves
  `docs/17:250,548` semantics).
- `service_key, brain-bound`: `scope = "single"`. Single-brain.
- `service_key, is_admin`: `scope = "multi"` if `listAccessibleBrainIds
  > 1`, else `"single"`.
- `service_key, non-brain-bound non-admin`: `scope = "multi"` if
  accessible > 1, else `"single"`.

`scope = "legacy"` and `scope = "single"` produce **identical**
top-level field shapes. The distinction matters only for telemetry
attribution. Existing parsers that read `total` / `embedded` / etc.
keep working.

### D6. Access-check helper — six branches (Findings 1, 4 alignment)

L4. Pure function: `(accessContext, brainId, requireEdit) → ALLOW |
DENY`.

```
1. legacy_admin_key
     brainId == accessContext.effectiveBrainId  → ALLOW
     else                                        → DENY
   (Finding 1: legacy admin is single-brain, period. The body `brain`
    field cannot widen this. Scripts that need cross-brain go through
    the operator path, see D10/Phase 6.)

2. service_key, is_admin=true
     brain.household_id == accessContext.householdId  → ALLOW
     else                                              → DENY
   (Preserves auth.mjs:290-310. Finding 4 secondary: this branch is
    not deprecated by v5, but D11 constrains who mints these keys.)

3. service_key, brain-bound (key.brain_id != null)
     brainId == key.brain_id  → ALLOW
     else                      → DENY
   (Preserves auth.mjs:299-310.)

4. service_key, non-brain-bound, non-admin
   OR human_token (read paths only — see D9 for write):
     brain-level deny on (principal, brain)               → DENY
     brain-level allow on (principal, brain)              → ALLOW
     estate-level allow on (principal, brain.household_id) → ALLOW
     otherwise                                              → DENY

5. requireEdit=true narrows case 4:
     deny on (principal, brain)                                            → DENY
     brain-level allow on (principal, brain) AND role IN ('owner','editor') → ALLOW
     estate-level allow on (principal, brain.household_id) AND role='admin' → ALLOW
     otherwise                                                              → DENY

6. requireEdit=true narrows case 2 (admin):
     allowed iff household match (no further role check; admin keys
     have full edit by definition within their household).
```

`listAccessibleBrainIds({ accessContext })`:

- `legacy_admin_key`: `[effectiveBrainId]`.
- `service_key, is_admin`: every brain in `accessContext.householdId`.
- `service_key, brain-bound`: `[key.brain_id]`.
- `service_key, non-brain-bound, non-admin`: union of
  brain-membership allows + brains in estates with `estate_memberships`,
  minus brain-membership denies.
- `human_token`: same as `service_key, non-brain-bound`. (The
  difference between them is L1/L2 default, not L4 access.)

`listEditableBrainIds({ accessContext })`: same as accessible but
filtered through case 5/6 logic above.

### D7. `/admin/thought/metadata` — L3+L4 only (Finding 1 fix)

The endpoint takes a thought_id. v5 changes:

- Optional `brain` body field (L3 selector).
- Resolution order:
  - If `brain` body field is set: resolve via L3 (must agree with L1
    sessionBrain if present, else 400). Then L4
    `checkBrainAccess({requireEdit: true})`. If 403 → 403; else
    SQL update with `WHERE id = $1 AND brain_id = $2`.
  - If `brain` body field is unset:
    - `legacy_admin_key`: `WHERE id = $1 AND brain_id = effectiveBrainId`.
      Cross-brain patch is **not possible** through this branch. Scripts
      that need it use the operator path.
    - All other branches: `WHERE id = $1 AND brain_id = ANY($2)`,
      where `$2 = listEditableBrainIds()`.
- Row not in the WHERE-clause set → 404 with explicit message naming
  the brain considered (or "no editable brains" if the principal has
  none).

This means the legacy admin patch contract is **strictly preserved**:
single-brain, exactly as today. Codex Finding 1 closed.

### D8. Slug resolution uses listAccessibleBrainIds() exactly (unchanged from v4)

For non-legacy callers: slug → UUID lookup over
`listAccessibleBrainIds()`. 404 if not present, 409 if multi-match.

If the slug resolves successfully, L4 access check runs separately
and may return 403 for write-only-restricted brains.

For legacy admin: slug resolution global, unchanged
(`auth.mjs:336-364`).

### D9. Human-token sessions are connector/route-bound, no per-call switching (Finding 2 fix)

`docs/17:250,548` is canon. v5 enforces it:

- L1 selector for human-token sessions: route slug
  (`POST /mcp/brains/:brainSlug`) is the only blessed path. Query
  string and header are accepted (L2 doesn't distinguish auth
  sources at this layer), but the recommended pattern is route-based.
- L1 produces `sessionBrain`.
- If no L1 selector: `sessionBrain = principal.default_brain_id`.
  Set once per session.
- L3 tool-arg `brain` for human-token sessions:
  - If tool-arg `brain` matches `sessionBrain`: ALLOW.
  - If tool-arg `brain` does NOT match `sessionBrain`: **400 Bad
    Request** with message "Human-token sessions are bound to one
    brain per session. Open a new session targeting `<other-brain>`
    via `POST /mcp/brains/<slug>` to access it."
- Read defaults for human-token: scope to `sessionBrain` only. NOT
  `listAccessibleBrainIds()`.

This means human-token sessions are strictly single-brain. The
`docs/17` contract holds. The access-check helper (D6 case 4) is
shared with `service_key`, but the **session-brain binding rule**
(D9) is enforced at L3 specifically for human-token, before L4 ever
runs.

`service_key, non-brain-bound, non-admin` does NOT have D9's
rule. For service keys, L3 freely picks any brain in
`listAccessibleBrainIds()`, and reads default to multi-brain. This
is the agent-side contract.

### D10. Env split — three vars, three roles (Finding 3 fix)

| Env var | Auth source | Where set |
|---|---|---|
| `MCP_ACCESS_KEY` | service_key (repo principal or operator) | Repo `.envrc`, OR operator's home env when not in any repo |
| `OB1_LEGACY_ADMIN_KEY` | legacy_admin_key | Set only in environments that need it (smoke, provisioning, schema migrations) |
| `OB1_OPERATOR_ACCESS_KEY` | service_key (operator stored key) | Set in the operator's home env explicitly |
| Authorization: Bearer ... (existing) | human_token | Browser / connector flows |

Why three vars instead of two:

- `MCP_ACCESS_KEY` collides with repo `.envrc`. Inside a repo shell,
  `MCP_ACCESS_KEY` is the repo principal key. Operator scripts run
  from the repo shell would silently use the repo principal key
  (Codex Finding 3 against v4).
- `OB1_OPERATOR_ACCESS_KEY` is an **explicit, separate** input.
  Operator scripts read it; if missing, they error before any work.
- Some agents/MCP clients run from outside any repo. In that case,
  `MCP_ACCESS_KEY` may be the operator key (set in `~/.config/ob1/...`).
  This double-use is fine because the operator scripts don't read
  `MCP_ACCESS_KEY` — they read `OB1_OPERATOR_ACCESS_KEY` only.

### D11. Stored `is_admin` keys are constrained, not deprecated (Finding 4 secondary)

Today's `bootstrap-admin` key is grandfathered. New `is_admin=true`
keys cannot be created by Phase 3's provisioning CLI without an
explicit `--allow-admin` flag. Documented in the CLI's `--help`.

The provisioning CLI prints a warning when it sees an existing
`is_admin=true, brain_id=null` key in `local-household`, advising
the operator to migrate to the operator stored key (D3) and
deactivate the admin key after operator-path cutover.

The model still permits admin keys (the schema and resolver
support them; we are not breaking that). But the provisioning
default is non-admin. This is policy, not enforcement.

### D12. Smoke harness contract — legacy-admin only (unchanged from v4)

`scripts/smoke-open-brain-running-service.sh` reads
`OB1_LEGACY_ADMIN_KEY`. Errors if missing. Single contract. Service-
key smoke is a future separate harness.

### D13. Enrichment-script preflight (Finding 3 fix, second part)

Before any patch, enrichment scripts perform an upfront authorization
check:

- Read `OB1_OPERATOR_ACCESS_KEY` from env. If missing, error with
  exact env-var name.
- Refuse to fall back to `MCP_ACCESS_KEY`.
- Issue a single `GET /admin/thought/access-check?brain=<UUID>`
  request to the MCP server. (New endpoint added in Phase 2c —
  service-side helper that returns
  `{ canRead: bool, canEdit: bool, principal_id: uuid }` for the
  authenticated principal against the requested brain.)
- If `canEdit` is false: error with the brain UUID and the principal
  identity, instructing operator to grant editor/owner role or
  estate-admin.
- Only after the preflight passes do the scripts begin processing
  rows.

This is the "auth preflight" Codex called for. It runs once per
script invocation, before the loop.

The new `GET /admin/thought/access-check` endpoint:

- Reads `accessContext` via `resolveAccessContext`.
- Resolves `brain` query param to a UUID via D8.
- Returns `{ canRead: D6.case-4-or-equivalent(...), canEdit:
  D6.requireEdit(...), principal_id: accessContext.principalId }`.
- 403 if the principal cannot even read the brain (so the script's
  preflight gives a fail-closed answer for cases where the
  endpoint shouldn't even disclose the brain's existence to the
  caller).

### D14. No estate-rename in this work (unchanged)

## Phasing

Independently deployable. Each acceptance row tests **all relevant
auth branches**.

### Phase 1 — Schema (unchanged from v4)

Migration `009_estate_memberships.sql`:

```sql
create table if not exists estate_memberships (
  principal_id uuid not null references brain_principals(id) on delete cascade,
  household_id uuid not null references households(id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  primary key (principal_id, household_id)
);

create index if not exists estate_memberships_household_idx
  on estate_memberships (household_id);

alter table brain_memberships
  add column if not exists is_deny boolean not null default false;

create index if not exists brain_memberships_principal_active_idx
  on brain_memberships (principal_id, brain_id)
  where is_deny = false;
```

**Acceptance:** unchanged.

### Phase 2a — Helpers + access-check + access-check endpoint

Implement:

- `checkBrainAccess({accessContext, brainId, requireEdit}) → { allowed, reason }`
- `listAccessibleBrainIds({accessContext}) → uuid[]`
- `listEditableBrainIds({accessContext}) → uuid[]`
- `resolveBrainSlug({accessContext, slug}) → { brainId } | 404 | 409`
- `GET /admin/thought/access-check?brain=<slug-or-uuid>` HTTP route
  (D13). Returns `{canRead, canEdit, principal_id}` JSON.

Test matrix (each row is a CI test). Key changes from v4:

- v5 case 2 (admin) is household-scoped only.
- v5 adds case 6 (admin + requireEdit).
- v5 adds tests for the access-check endpoint.

| auth branch                                                    | helper                  | result |
|----------------------------------------------------------------|-------------------------|--------|
| legacy_admin_key, target = effectiveBrainId                    | check                   | ALLOW |
| legacy_admin_key, target ≠ effectiveBrainId                    | check                   | DENY |
| legacy_admin_key                                                | listAccessible          | `[effectiveBrainId]` |
| service_key, is_admin, brain in principal household            | check                   | ALLOW |
| service_key, is_admin, brain in OTHER household                | check                   | DENY (Finding 1 v3) |
| service_key, is_admin, brain in principal household            | check(requireEdit)      | ALLOW |
| service_key, is_admin                                           | listAccessible          | every brain in **principal's household** |
| service_key, brain-bound, target == key.brain_id               | check                   | ALLOW |
| service_key, brain-bound, target ≠ key.brain_id                | check                   | DENY |
| service_key, brain-bound                                        | listAccessible          | `[key.brain_id]` |
| service_key, no membership, no estate                          | check                   | DENY |
| service_key, brain-allow                                       | check                   | ALLOW |
| service_key, brain-allow + role='member'                       | check(requireEdit)      | DENY |
| service_key, brain-allow + role='editor'                       | check(requireEdit)      | ALLOW |
| service_key, brain-allow + role='owner'                        | check(requireEdit)      | ALLOW |
| service_key, estate-membership member                          | check                   | ALLOW |
| service_key, estate-membership member                          | check(requireEdit)      | DENY |
| service_key, estate-membership admin                           | check                   | ALLOW |
| service_key, estate-membership admin                           | check(requireEdit)      | ALLOW |
| service_key, estate-allow + brain-deny                         | check                   | DENY |
| service_key, brain-bound + estate-allow on different brain     | check                   | DENY (case 3 wins) |
| human_token, brain-allow                                       | check                   | ALLOW |
| human_token, no membership                                     | check                   | DENY |

**Acceptance:**
- ☐ Test matrix above passes.
- ☐ `GET /admin/thought/access-check?brain=<accessible>` returns
  `{canRead: true, canEdit: <per-rule>, principal_id: ...}`.
- ☐ Same endpoint with `brain=<inaccessible>` returns 403.
- ☐ Smoke regression unchanged.

### Phase 2b — Selector unification (D2)

In `resolveAccessContext`:

- Detect simultaneous L1 sources → 400.
- Set `accessContext.sessionBrain` from L1.

Slug→UUID for non-legacy callers: `listAccessibleBrainIds()`. 404 /
409 / UUID. For legacy admin: global, unchanged.

**Acceptance:**
- ☐ `?brain=ob1` + `x-brain-slug=agent-common` → 400.
- ☐ Stored-key principal with estate-only access to estate B can
  resolve a slug in B (read-only) and run reads.
- ☐ Two estates with same slug accessible to one principal → 409.
- ☐ Brain-bound key with mismatched slug → 404.
- ☐ Slug resolves to a brain caller can read but not edit → 200 on
  read, 403 on `/admin/thought/metadata` (NOT slug failure).

### Phase 2c — Tool & HTTP surfaces (D6, D7, D9)

**Capture path** (`capture_thought`, `/ingest/thought`):

- Optional `brain` body field (L3).
- Tool-arg vs sessionBrain disagreement → 400.
- For human-token: tool-arg `brain` ≠ `sessionBrain` → 400 (D9).
  Tool-arg matching `sessionBrain` is allowed.
- L4 access check (`requireEdit: false` for capture — capture is
  create, not edit). Hmm — clarification: capture creates a new
  thought in a brain. Authorization is "may write to this brain at
  all," not edit. Phase 2a adds a third helper:
  `checkBrainAccess({requireWrite: true})` — equivalent to "principal
  has an allow row (brain-level OR estate-level) and not a brain-deny."
  Distinct from `requireEdit` because capture allows `role='member'`
  on a brain (member can write new captures) while edit requires
  editor/owner/estate-admin.
- Default brain resolution per D9 + D6 cases.

(Phase 2a test matrix is extended with `requireWrite` rows
mirroring `requireEdit` but allowing role='member'.)

**Read path** (`search_thoughts`, `list_thoughts`, `ask_brain`,
`/ask`, `/admin/thought/similar`):

- Optional `brain` (L3).
- If set: scope to that brain after L4 access check.
- If not set:
  - `legacy_admin_key`: `[effectiveBrainId]`.
  - `service_key, is_admin`: principal's accessible brains within
    household.
  - `service_key, brain-bound`: `[key.brain_id]`.
  - `service_key, non-brain-bound non-admin`: `listAccessibleBrainIds()`.
  - `human_token`: `[sessionBrain]` (D9 — single-brain default).
- Multi-brain scope → fan out, merge, tag every row with
  `brain_id`/`brain_slug`.

**`stats`:** D5 multi-brain shape, `scope` field server-derived.

**`/admin/thought/metadata`** (D7):

- Optional `brain` body field.
- Resolution per D7. Legacy admin path strictly single-brain.

**`/graph/*`:** unchanged.

**Acceptance — legacy_admin_key (Finding 1):**
- ☐ Smoke harness passes.
- ☐ Patch on default brain → 200.
- ☐ Patch with body `brain=<other>` → **the body field is ignored
  for legacy admin.** WHERE clause uses `effectiveBrainId`. If the
  thought is in `<other>`, → 404. (The body field exists for non-
  legacy branches; legacy admin is single-brain by D6 case 1.)
- ☐ The patch test: explicit error message documents that legacy
  admin cannot patch other brains.

**Acceptance — service_key, brain-bound:**
- ☐ Capture with no `brain` → `key.brain_id`.
- ☐ Capture with `brain=<other>` → 403.
- ☐ Search no `brain` → only `key.brain_id`.

**Acceptance — service_key, non-brain-bound (REPO PRINCIPAL):**
- ☐ Capture with no `brain` → repo brain (default).
- ☐ Capture with `brain="agent-common"` → common brain.
- ☐ Capture with `brain="<unrelated>"` → 403.
- ☐ Search with no `brain` spans repo + common; rows tagged.
- ☐ Search with `brain="ob1"` → repo only.
- ☐ `/admin/thought/metadata` body `brain="agent-common"`:
  - role='member' on common: 403.
  - role='editor' on common: 200.
  - role='owner' on common: 200.
  - estate-admin (operator path): 200.

**Acceptance — service_key, is_admin (cross-household NOT crossed):**
- ☐ Capture with `brain=<brain-in-principal-household>` → 200.
- ☐ Capture with `brain=<brain-in-OTHER-household>` → 403.
- ☐ `listAccessible` returns only brains within the principal's
  household.

**Acceptance — human_token (Finding 2):**
- ☐ Search with no `brain` → `sessionBrain` only (single-brain).
- ☐ Search with `brain` matching `sessionBrain` → 200.
- ☐ Search with `brain` ≠ `sessionBrain` → 400 with message about
  opening a new session.
- ☐ Capture with no `brain` → `sessionBrain`.
- ☐ Capture with `brain` ≠ `sessionBrain` → 400.

**Acceptance — selector disagreement:**
- ☐ `POST /mcp/brains/ob1` + tool-arg `brain="agent-common"` → 400.

**Acceptance — access-check endpoint:**
- ☐ Phase 2a covers it.

### Phase 3 — Provisioning CLI (Finding 4 secondary; Finding 5 fix)

`scripts/agent_estate/provision.py`:

- `provision-estate-and-common`: create agent estate + common brain.
  Idempotent.
- `provision-repo --slug <slug>`:
  - Repo principal + repo brain + memberships:
    - `brain_memberships(repo-principal, repo-brain, role='owner')`
    - `brain_memberships(repo-principal, common-brain, role='editor')`
  - Mint a non-brain-bound, non-admin `service_key`.
  - **D11:** Refuse to mint `is_admin=true` without `--allow-admin`.
  - Print plaintext key once.
- `provision-operator-membership`:
  - Mint operator stored key for `luchoh`: non-admin, non-brain-bound.
  - `estate_memberships(luchoh, agent-estate, role='admin')`.
  - Warn if an existing `is_admin=true, brain_id=null` key exists in
    `local-household` (D11).
- `rotate-key --slug <slug>`: revoke + re-mint.

**Acceptance:**
- ☐ Re-running provision is idempotent.
- ☐ Repo principal validates against the **non-brain-bound,
  multi-membership** matrix (Phase 2a relevant rows): no `brain` →
  repo brain; `brain="agent-common"` → 200; `brain="<unrelated>"` →
  403.
- ☐ Repo principal `/admin/thought/metadata` on common-brain
  thought → 200 (role='editor').
- ☐ Operator stored key + estate-admin grant cross-estate read on
  every agent brain.
- ☐ Operator stored key `/admin/thought/metadata` on any agent-brain
  thought → 200.
- ☐ `provision-repo --slug foo --allow-admin` mints an admin key with
  a warning printed.
- ☐ `provision-repo --slug foo` (no `--allow-admin`) refuses to mint
  admin keys.

### Phase 4 — Per-repo `.envrc` (D10)

In each onboarded repo:

- `.envrc` exports `MCP_ACCESS_KEY=<repo-principal stored key>`.
- `OPEN_BRAIN_BASE_URL=http://127.0.0.1:8788`.
- The actual key value lives in a gitignored file.

In operator's home env:

- `~/.config/ob1/operator.env` exports BOTH:
  - `OB1_OPERATOR_ACCESS_KEY=<operator stored key>` (for scripts that
    explicitly read it).
  - `MCP_ACCESS_KEY=<operator stored key>` (for general AI-client
    use outside a repo shell). Direnv overrides this when entering a
    repo.

In environments that need legacy admin:

- `OB1_LEGACY_ADMIN_KEY` exported separately.

**Acceptance:**
- ☐ Inside `/Users/luchoh/Dev/OB1` shell: `MCP_ACCESS_KEY` is repo
  key; `OB1_OPERATOR_ACCESS_KEY` is operator key (UNCHANGED by repo
  entry; lives in operator's home env).
- ☐ Capture inside the OB1 shell with no `brain` → `ob1` brain.
- ☐ Outside any repo: `MCP_ACCESS_KEY` is operator key.
- ☐ Smoke harness with `OB1_LEGACY_ADMIN_KEY` passes (D12).

### Phase 5 — Routing skill (unchanged from v4)

`skills/agent-brain-routing/SKILL.md`. System-config Nix deploy via
the `live-retrieval` pattern.

### Phase 6 — Migrate writers (Finding 3 fix completes)

**Mechanical env-var renames:**
- `scripts/smoke-open-brain-running-service.sh`: read
  `OB1_LEGACY_ADMIN_KEY` only.
- Other infrastructure scripts that need legacy admin: same.

**Auth migration for enrichment scripts (Finding 3, D13):**

`scripts/thought_enrichment/*` change:
- Read `OB1_OPERATOR_ACCESS_KEY` from env. Refuse `MCP_ACCESS_KEY`
  fallback. If missing: error with exact env-var name and how to
  set it.
- Add a startup preflight: call `GET /admin/thought/access-check
  ?brain=<--brain-id-as-UUID>`. If `canEdit` is false: error with
  the brain UUID, the principal_id, and instructions ("grant
  role='editor' on the brain or role='admin' on its estate").
- Patches pass `brain=<UUID>` body field on every call.

`scripts/thought_enrichment/lib/db.py`:
- `AdminClient` reads `OB1_OPERATOR_ACCESS_KEY` not `MCP_ACCESS_KEY`.
- `AdminClient.patch` always sends `brain` body field.
- New method `AdminClient.preflight(brain_id)` calls the access-check
  endpoint and raises if not editable.

`backfill_sensitivity.py`:
- Same env var, same preflight, same `brain` field.

**Other writers (no change required):**
- Telegram bridge — wrapper still sets `MCP_ACCESS_KEY` to legacy
  admin. Cross-repo follow-up.
- FastAPI ingest — same.
- Autodream-brain-sync skill — uses MCP from the AI client; key
  comes from client config.

**Acceptance:**
- ☐ Smoke harness with `OB1_LEGACY_ADMIN_KEY` passes (D12 contract).
- ☐ `scripts/thought_enrichment/enrich.py --apply --brain-id <prod-luchoh>` succeeds with `OB1_OPERATOR_ACCESS_KEY` set; preflight passes; patches succeed.
- ☐ `scripts/thought_enrichment/enrich.py --apply --brain-id <agent-common>` succeeds; preflight verifies estate-admin role; patches succeed.
- ☐ Without `OB1_OPERATOR_ACCESS_KEY` set: enrich.py errors clearly with the env-var name, BEFORE any DB reads.
- ☐ Inside an OB1 repo shell, with `MCP_ACCESS_KEY` set to repo key
  but no `OB1_OPERATOR_ACCESS_KEY`: enrich.py errors clearly. Does NOT
  silently use the repo key.
- ☐ With operator key authorized for read-only on the target brain
  (no editor role): preflight fails with brain UUID + principal_id +
  remediation instructions.

## Risks and mitigations

- **Body field promoted to L1 by accident.** Mitigation: D7 + D6
  case 1 explicitly state legacy admin ignores body `brain`. Tests
  in Phase 2c acceptance.
- **Human-token contract drift.** Mitigation: D9 enforces
  session-brain binding at L3, with explicit 400 for tool-arg
  mismatch. Tests in Phase 2c human-token acceptance.
- **Operator scripts run from repo shell with wrong key.**
  Mitigation: D10 + D13 ensure the operator scripts read
  `OB1_OPERATOR_ACCESS_KEY` only; failure is fail-fast with named
  env var.
- **Stored `is_admin` keys remain a hole.** Mitigation: D11 +
  Phase 3 provisioning refuse-by-default + warning. Cleanup of
  existing bootstrap-admin happens after operator-path cutover (not
  in this PRD).
- **Multi-brain search latency.** Mitigation: parallel fanout, N
  small.
- **Slug ambiguity surfaces under multi-estate access.** Mitigation:
  Phase 2b synthetic test.
- **`/admin/thought/access-check` endpoint becomes an enumeration
  oracle.** Mitigation: returns 403 (not 404) for inaccessible
  brains, preventing brain-existence inference. Tested in Phase 2a.

## Out of scope, tracked separately

- Renaming `households` → `estates`.
- Brain-qualified graph projections + multi-brain graph queries.
- `update_thought_mcp` / `delete_thought_mcp` MCP tools.
- Thought-audit log (ADR-27).
- Telegram bridge wrapper env split (system-config follow-up).
- Recurring backup design (task #14).
- Service-key smoke harness (separate effort).
- Deprecating bootstrap-admin entirely (post-cutover ADR).
- Human-token federation for agent principals.
- Human-token multi-brain mode (would require an explicit ADR
  changing the `docs/17:250,548` contract).

## Open questions

- D11 leaves admin keys legal but constrained. After operator-path
  cutover, should we deactivate `bootstrap-admin` entirely? Defer
  until enrichment + smoke + provisioning all use D10's split paths.
- D9's session-brain binding may be too strict for some future
  human-token use cases (e.g., a dashboard that shows multi-brain
  views). If/when that surfaces, requires a separate ADR amending
  `docs/17:250,548`. Not in this PRD.
- D13's preflight endpoint is read-only and idempotent. Should it
  also be exposed as an MCP tool (`check_brain_access`)? Useful for
  agents that want to introspect their permissions before a write.
  Defer; agents can call it via plain HTTP if needed.
