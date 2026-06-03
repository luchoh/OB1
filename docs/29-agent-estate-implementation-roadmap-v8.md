# PRD: Agent Estate + Brain Selection — Implementation Roadmap (v8)

Date: 2026-06-03
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`,
           CONTEXT `CONTEXT.md`,
           reviews v1–v7
Supersedes: v1, v2, v3, v4, v5, v6, v7

## Why v8

v7 was rejected on one real bug and one phase-boundary issue:

1. **D7 and D9 contradicted each other for `human_token` on
   non-MCP HTTP `/admin/thought/metadata` with no body `brain`.**
   D9 said default-brain-only; D7 said `listAccessibleBrainIds({mode:
   'edit'})`. Same auth source, same route family, opposite
   defaults.
2. **Phase 2b acceptance asserted handler behavior** (body-brain
   parsing, route edit enforcement) but Phase 2b's stated scope is
   selector unification inside `resolveAccessContext`. Live server
   parses bodies in route handlers, not auth-context resolution.

Both fixed in v8 below.

## Vocabulary recap

(Unchanged from v7; defined in `CONTEXT.md`.)

## Layering model

(Unchanged from v7. Four layers: L1 auth selector, L2 auth context,
L3 per-call brain resolution (tool-arg or body), L4 access check.)

## Goals (unchanged)

## Non-goals (unchanged)

## Design decisions

### D1. Estate membership is allow-only (unchanged)

### D2. Selector model — per-auth-source AND per-route admissibility (unchanged from v7)

### D3. Operator path (unchanged)

### D4. Phase scope (unchanged)

### D5. `stats` response shape (unchanged)

### D6. Access-check helper — three modes, single-brain legacy admin (unchanged from v7)

### D7. `/admin/thought/metadata` — auth-source-aware default scope (Finding 1 fix)

The endpoint takes a thought_id and an optional body `brain` field
(L3). Resolution rules now spell out the no-body-`brain` default
**per auth source**, eliminating the v7 D7/D9 contradiction.

#### Body `brain` IS set:

For all auth sources: resolve via D8, then L4
`checkBrainAccess({mode: 'edit'})`. WHERE clause becomes
`id = $1 AND brain_id = $resolved-brain`.

Special legacy-admin sub-rule (carries over from v7): if
`legacy_admin_key` AND body `brain` doesn't match
`effectiveBrainForLegacyAdmin(accessContext)` → 400 with explicit
"legacy admin requires body brain to match request L1 selector or
default."

#### Body `brain` is NOT set:

Per auth source:

| auth source                       | scope when no body `brain` |
|-----------------------------------|----------------------------|
| `legacy_admin_key`                | `[effectiveBrainForLegacyAdmin]` (single brain by D6 case 1) |
| `service_key, is_admin`           | every brain in principal's household (`listAccessibleBrainIds({mode:'edit'})` collapses to household for admin) |
| `service_key, brain-bound`        | `[key.brain_id]` |
| `service_key, non-brain-bound, non-admin` | `listAccessibleBrainIds({mode:'edit'})` — multi-brain by default (the agent contract: a repo principal patching a row whose UUID it knows can find that row in any brain it edits) |
| `human_token`                     | `[principal.default_brain_id]` (single brain — Finding 1 fix) |

WHERE clause: `id = $1 AND brain_id = ANY($scope-array)`.

If row not in scope → 404 with explicit message naming the brain(s)
considered. If row matches multiple (impossible in practice because
`thoughts.id` is a UUID PK, but defensive): 409.

**Why human-token defaults to single brain even though service_key
non-brain-bound defaults to multi-brain:**

- Human-token model from `docs/17:250,548` is "single-brain per
  request." Multi-brain scoping on an edit endpoint would surprise
  human operators.
- Service-key non-brain-bound is the agent model: agents work
  across multiple brains by design (repo brain + common brain). A
  patch by thought_id is naturally scoped to "wherever this row
  lives," and the agent has membership where it has membership —
  no surprise.
- Mixed defaults are honest about the two distinct mental models.

**Cross-brain edits remain available to humans via explicit body
`brain`.** Required for any patch outside their default brain.
Friction is intentional.

This is Finding 1 closure: D7 and D9 now agree.

### D8. Slug-vs-UUID resolution (unchanged from v7)

### D9. Human-token request-scoped binding (refined, consistent with D7)

`docs/17:250,548` is canon. v8 enforces request-scoped:

**For human-token on MCP routes (unchanged from v7):**
- L1 admissibility: route only. Query/header rejected at 400.
- `requestBrain = route brain ?? principal.default_brain_id`.
- L3 (tool-arg `brain`): must equal `requestBrain` if both set.
- Read/write defaults: scope to `requestBrain` only.

**For human-token on non-MCP HTTP routes (refined):**

L1 admissibility: route doesn't carry a slug; query/header rejected
for human-token at L1 (D2). So `requestBrain` is null on these routes
for human-token.

L3 admissibility: body `brain` IS admitted. This is the explicit
override path.

Resolution by route:

| route                          | no body `brain`             | body `brain` set |
|--------------------------------|-----------------------------|------------------|
| `/ingest/thought`              | `principal.default_brain_id` | resolve → L4 mode='write' |
| `/ask`                         | `principal.default_brain_id` | resolve → L4 mode='read' |
| `/admin/thought/similar`       | `principal.default_brain_id` | resolve → L4 mode='read' |
| `/admin/thought/metadata`      | `[principal.default_brain_id]` (D7) | `[resolved.id]` (D7) |

Consistent across all four non-MCP HTTP routes for human-token: no
body `brain` → default brain only. This closes the v7 D7/D9
contradiction.

### D10. Env split (unchanged)

### D11. Stored `is_admin` provisioning policy (unchanged)

### D12. Estate-membership `role='member'` is read-only (unchanged from v7)

### D13. Smoke harness contract (unchanged)

### D14. Legacy-admin layer hygiene — `config.accessKey` is the choke point (unchanged from v7)

### D15. `/admin/thought/access-check` query param `target_brain` (unchanged from v7)

### D16. No estate-rename in this work (unchanged)

## Phasing

### Phase 1 — Schema (unchanged)

Migration `009_estate_memberships.sql`. Acceptance unchanged.

### Phase 2a — Helpers + access-check + access-check endpoint

(Unchanged from v7. Test matrix per D6 with three modes; D8 with
split slug/UUID paths; D15 with renamed param.)

**Acceptance** unchanged.

### Phase 2b — Selector unification (scope tightened — Finding 2 fix)

In `resolveAccessContext`:
- Detect simultaneous L1 sources → 400.
- For `human_token`: reject query and header L1 selectors → 400.
  Only route L1 admitted (and only on MCP routes).
- For other auth sources: any of the three on routes that support
  them.
- Set `accessContext.requestBrain` from L1.

**Phase 2b is selector-only. It does NOT touch route handlers.**
Body parsing, body-brain resolution, and route-specific edit
enforcement live in Phase 2c.

**Acceptance — selector-only:**
- ☐ MCP `?brain=ob1` + `x-brain-slug=agent-common` → 400.
- ☐ MCP human-token request with `?brain=ob1` → 400.
- ☐ MCP human-token request with `x-brain-slug=ob1` → 400.
- ☐ MCP human-token request via `POST /mcp/brains/ob1` → 200 (auth
  context resolves with `requestBrain` set; handler body unchanged).
- ☐ Service-key MCP request with `?brain=ob1` → 200.
- ☐ Stored-key principal with estate-only access can resolve a
  cross-estate slug (Phase 2a slug-resolution test).
- ☐ Two estates with same slug accessible to one principal → 409.
- ☐ Brain-bound key with mismatched slug → 404.

**Removed from Phase 2b vs v7** (moved to Phase 2c):
- Non-MCP HTTP `/ingest/thought` body-brain assertions.
- Non-MCP HTTP `/admin/thought/metadata` edit enforcement
  assertions.

These are handler-layer behaviors. Phase 2c is where they belong.

### Phase 2c — Tool & HTTP surfaces (handler layer)

**Capture path** (`capture_thought`, `/ingest/thought`):

(Unchanged from v7. L3 disagreement check, L4 mode='write' enforce,
defaults per D9 / D6.)

**Read path** (`search_thoughts`, `list_thoughts`, `ask_brain`,
`/ask`, `/admin/thought/similar`):

(Unchanged from v7. L4 mode='read' enforce, defaults per D9 / D6.)

**`stats`:** (Unchanged. D5 shape per scope.)

**`/admin/thought/metadata`** (refined to match D7 v8 rules):

- Optional body `brain` field.
- Body `brain` set:
  - Resolve via D8.
  - For legacy_admin_key: must match
    `effectiveBrainForLegacyAdmin`, else 400.
  - L4 `checkBrainAccess({mode: 'edit'})`. If 403 → 403.
  - WHERE: `id = $1 AND brain_id = $resolved`.
- Body `brain` unset, dispatch by auth source per D7:

| auth source                                | WHERE brain_id condition |
|--------------------------------------------|--------------------------|
| `legacy_admin_key`                         | `= effectiveBrainForLegacyAdmin` |
| `service_key, is_admin`                    | `= ANY(every brain in household)` |
| `service_key, brain-bound`                 | `= key.brain_id` |
| `service_key, non-brain-bound, non-admin` | `= ANY(listAccessibleBrainIds({mode:'edit'}))` |
| `human_token`                              | `= principal.default_brain_id` (Finding 1 fix) |

- Row not in scope → 404 with message naming the considered brain(s).
- Row matches multiple → 409 (defensive).

**`/graph/*`:** unchanged. Admin-only, single-brain.

**Acceptance — legacy_admin_key (unchanged from v7):**
- ☐ Smoke harness passes.
- ☐ Without route L1, default brain works.
- ☐ With route L1 `POST /mcp/brains/<other>`, OTHER brain only;
  default DENIED.
- ☐ Patch with body `brain` mismatching effective brain → 400.
- ☐ Documented single-brain semantics.

**Acceptance — service_key, brain-bound (unchanged from v7).**

**Acceptance — service_key, non-brain-bound (REPO PRINCIPAL,
unchanged from v7):**
- (Capture, search, edit acceptance per v7.)

**Acceptance — service_key, is_admin (unchanged).**

**Acceptance — human_token (refined per D7/D9 alignment, Finding 1
fix):**

MCP routes (unchanged from v7):
- ☐ Search with no `brain` → `requestBrain` only.
- ☐ Search with body `brain` matching `requestBrain` → 200.
- ☐ Search with body `brain` ≠ `requestBrain` → 400.
- ☐ Search with no route L1 + body `brain` → 400.
- ☐ Capture with no `brain` → `requestBrain`.
- ☐ Capture with body `brain` ≠ `requestBrain` → 400.

Non-MCP HTTP routes (NEW Finding 1 acceptance):
- ☐ `/ingest/thought` body `brain` UNSET → captures into
  `principal.default_brain_id`.
- ☐ `/ingest/thought` body `brain="agent-common"` (with
  brain-membership role≥member) → 200.
- ☐ `/ingest/thought` body `brain="<unrelated>"` → 403.
- ☐ `/ask` body `brain` UNSET → reads from default brain.
- ☐ `/ask` body `brain="agent-common"` → reads from common.
- ☐ `/admin/thought/similar` body `brain` UNSET → similar from
  default brain.
- ☐ `/admin/thought/metadata` body `brain` UNSET, target row in
  default brain → 200 (Finding 1 fix: NOT scanning every editable
  brain).
- ☐ `/admin/thought/metadata` body `brain` UNSET, target row in
  `agent-common` (which the human can edit via brain-membership
  role='editor') → **404** (because human-token defaults to
  default brain only; the row isn't in default brain). Caller must
  pass body `brain="agent-common"` explicitly.
- ☐ `/admin/thought/metadata` body `brain="agent-common"` with
  role='editor' → 200.
- ☐ `/admin/thought/metadata` body `brain="agent-common"` with
  estate-member only → 403 (D12).

The 404 case in the second-to-last bullet is the **canonical Finding
1 closure test**. v7 left this behavior ambiguous (would it scan
multi-brain or not?); v8 says clearly: human-token + no body brain =
default brain only.

**Acceptance — selector disagreement (unchanged).**

**Acceptance — `stats` shape (unchanged from v7 D5).**

### Phase 3 — Provisioning CLI (unchanged from v7)

Acceptance unchanged.

### Phase 4 — Per-repo `.envrc` (unchanged)

### Phase 5 — Routing skill (unchanged)

### Phase 6 — Migrate writers (unchanged from v7)

### Phase 7 — Legacy-admin layer hygiene (unchanged from v7)

## Risks and mitigations

(Unchanged from v7, plus:)

- **Human-token operators may be surprised by 404 on `/admin/thought/metadata`**
  when the target row is in a non-default brain they could edit.
  Mitigation: error message explicitly names the brain considered
  (default brain) and instructs to pass body `brain=<slug>` for
  cross-brain patch. Documented in the error response, not just in
  this PRD.
- **Service-key non-brain-bound vs human-token default-scope
  asymmetry on `/admin/thought/metadata`.** Different defaults
  for different mental models (agent vs human). Tested explicitly
  in Phase 2c.

## Out of scope, tracked separately

(Unchanged from v7.)

## Open questions

(Unchanged from v7.)
