# PRD: Agent Estate + Brain Selection — Implementation Roadmap (v9)

Date: 2026-06-03
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`,
           CONTEXT `CONTEXT.md`,
           reviews v1–v8
Supersedes: v1, v2, v3, v4, v5, v6, v7, v8

## Why v9

v8 was rejected on two findings:

1. **D7 silently expanded the omitted-`brain` write contract on
   `/admin/thought/metadata` from "default brain" to "every editable
   brain in the household" for service-key non-brain-bound and
   admin contexts.** That contradicts ADR-0001 point 10 (default = 
   `principal.default_brain_id`) and `docs/17:485-500` (single
   `effective_brain_id` for write paths unless the route supports
   explicit override). It is an ADR-level semantic change, not a
   detail.
2. **Phase 2b understated the auth-context rewrite needed for
   estate-aware selectors.** `loadPrincipalMemberships`
   (`auth.mjs:65`) only loads `brain_memberships`. For an
   estate-only principal to resolve a slug for a brain accessible
   only via `estate_memberships`, the auth-context resolver must be
   rewritten to consult both tables. Phase 2b's "selector-only"
   framing was too small.

Both fixed in v9.

## Vocabulary recap

(Unchanged from v7/v8.)

## Layering model

(Unchanged. Four layers: L1 selector, L2 context, L3 per-call
brain, L4 access check.)

## Goals (unchanged)

## Non-goals (unchanged)

## Design decisions

### D1. Estate membership is allow-only (unchanged)

### D2. Selector model — per-auth-source AND per-route admissibility (unchanged from v7/v8)

### D3. Operator path (unchanged)

### D4. Phase scope (unchanged)

### D5. `stats` response shape (unchanged)

### D6. Access-check helper — three modes, single-brain legacy admin (unchanged from v7/v8)

### D7. Omitted-`brain` write defaults align with ADR-0001 (Finding 1 fix)

ADR-0001 point 10 is canon: **default brain when no `brain` is
specified is `principal.default_brain_id`.** ADR-0001 point 11 lists
the multi-brain exceptions: `search_thoughts`, `list_thoughts`,
`ask_brain`, `stats` (and only those — read paths).

**Write surfaces** (`/admin/thought/metadata`, `/ingest/thought`,
`capture_thought`) without an explicit `brain` argument scope to a
**single brain**, never multi-brain. The single brain is determined
per auth source as the principal's effective default — same idea as
the live runtime's `effectiveBrainId` (`auth.mjs:312`).

#### `/admin/thought/metadata` rules:

**Body `brain` IS set:** resolve via D8, L4
`checkBrainAccess({mode: 'edit'})`. WHERE clause:
`id = $1 AND brain_id = $resolved`.

Special legacy-admin sub-rule: if `legacy_admin_key` AND body
`brain` doesn't match `effectiveBrainForLegacyAdmin(accessContext)`
→ 400.

**Body `brain` NOT set:**

| auth source                                | scope when no body `brain` |
|--------------------------------------------|----------------------------|
| `legacy_admin_key`                         | `effectiveBrainForLegacyAdmin` |
| `service_key, is_admin`                    | `accessContext.effectiveBrainId` (= requested-brain L1 OR `key.brain_id` OR `principal.default_brain_id`) |
| `service_key, brain-bound`                 | `key.brain_id` |
| `service_key, non-brain-bound, non-admin` | `accessContext.effectiveBrainId` (= requested-brain L1 OR `principal.default_brain_id`) |
| `human_token`                              | `accessContext.effectiveBrainId` (= requested-brain L1 OR `principal.default_brain_id`) |

WHERE clause: `id = $1 AND brain_id = $effectiveBrainId`.

Cross-brain edits (any brain other than the effective brain) require
**explicit body `brain`**, for every auth source. There is no
multi-brain default scan on write surfaces.

This matches ADR-0001 + `docs/17` + the live runtime contract.

#### `/ingest/thought` and `capture_thought` rules (refined):

Capture is "create new thought." Same omitted-`brain` rule: scope
to `accessContext.effectiveBrainId`. Body `brain` for explicit
override.

The agent contract from ADR-0001 — repo principals capturing into
either repo brain or common brain — works through **explicit body
`brain` on every cross-brain write**, not via a multi-brain default.
The skill (Phase 5) instructs the agent to set `brain` explicitly
when writing to common; when omitted, capture lands in the
principal's default (= repo brain).

#### Asymmetry with read tools is intentional:

ADR-0001 point 11 explicitly singles out the four read tools as
multi-brain default. Edit/write surfaces stay single-brain default.
v9 enforces the asymmetry the ADR specifies.

#### What this means in practice for agent enrichment scripts:

The enrichment scripts (`scripts/thought_enrichment/*`) operating on
`agent-common` from a repo shell **must pass `brain=<UUID>`** on
every patch call. They already do this in v6+ Phase 6 — the new
v9 rule reinforces it. Without explicit `brain`, the script would
patch against the principal's default brain, not the agent-common
brain it is iterating over. Phase 6 acceptance covers this.

### D8. Slug-vs-UUID resolution (unchanged from v7/v8)

### D9. Human-token request-scoped binding (refined for D7 alignment)

Same as v8 except the omitted-`brain` write defaults now match D7:
human-token on non-MCP HTTP write surfaces (`/ingest/thought`,
`/admin/thought/metadata`) without body `brain` scopes to
`accessContext.effectiveBrainId` (which for human-token is
`requestBrain ?? principal.default_brain_id`).

This is consistent with both ADR-0001 and v8's D9 framing — v9
only adjusts the wording so it doesn't read as a special case.

### D10. Env split (unchanged)

### D11. Stored `is_admin` provisioning policy (unchanged)

### D12. Estate-membership `role='member'` is read-only (unchanged from v7/v8)

### D13. Smoke harness contract (unchanged)

### D14. Legacy-admin layer hygiene (unchanged from v7)

### D15. `/admin/thought/access-check` query param `target_brain` (unchanged)

### D16. No estate-rename in this work (unchanged)

### D17. Auth-context resolution becomes estate-aware (Finding 2 fix; new in v9)

The current auth-context resolvers
(`resolveHumanAccessContext`, `resolveStoredAccessKeyContext`) check
that the requested brain is in the principal's
`brain_memberships`. This is correct today (no estate memberships
exist), but **will reject estate-only principals** once
`estate_memberships` is in play.

v9 makes the resolvers estate-aware, before any handler runs:

**Before (today, `auth.mjs:65-80`):**

```sql
select ..., bm.role from brain_principals p
left join brain_memberships bm on bm.principal_id = p.id
left join brains b on b.id = bm.brain_id
where p.id = $1::uuid
```

**After (v9):**

`loadPrincipalMemberships()` becomes `loadPrincipalAccess()`,
returning two collections:

- `brainMemberships`: rows from `brain_memberships`, with
  `is_deny`, `role`, brain_id, brain_slug.
- `estateMemberships`: rows from `estate_memberships`, with
  `role`, household_id.

Computed accessible-brain set (read mode, used for slug
resolution): same union as
`listAccessibleBrainIds({accessContext, mode:'read'})` in D6:

- brain-allow rows (allow + role≥member)
- plus brains in estates where principal has estate membership
- minus brain-deny rows

`resolveHumanAccessContext` and `resolveStoredAccessKeyContext`
now use this combined set to authorize `requestedBrain` (route /
query / header L1). Specifically:

- The "Not authorized for brain" 403 check (`auth.mjs:200,308`)
  consults the combined set, not just `brain_memberships`.
- The brain-bound-key restriction (`auth.mjs:299-310`) is unchanged
  (a brain-bound key's accessible set is still `[key.brain_id]`).

This is a **real auth-context-layer rewrite**, not just selector
normalization. v9 puts it in Phase 2b and is honest about the work.

The `accessContext` shape gets two new fields:

- `accessContext.brainMemberships`: array of {brain_id, brain_slug,
  role, is_deny}.
- `accessContext.estateMemberships`: array of {estate_id, role}.

L4 access-check helpers (D6) read from these arrays instead of
re-querying. This keeps the helper a pure function over context.

The `effectiveBrainId` field stays on `accessContext` and means the
same thing as today: the single brain bound to this request via
L1 selector + key.brain_id + default fallback. It is what omitted-
`brain` write surfaces use per D7.

## Phasing

### Phase 1 — Schema (unchanged from v7/v8)

Migration `009_estate_memberships.sql`. Acceptance unchanged.

### Phase 2a — Helpers + access-check + access-check endpoint (unchanged from v7/v8)

The helpers operate on `accessContext` plus the new
`brainMemberships` and `estateMemberships` arrays loaded in Phase 2b.

**Acceptance** unchanged.

### Phase 2b — Selector unification AND estate-aware auth-context resolution (Finding 2 fix)

This phase is now larger than v8 admitted. Two coordinated changes:

**(i) Selector unification** in `resolveAccessContext` (selector-only
work, as in v8):
- Detect simultaneous L1 sources → 400.
- For `human_token`: reject query/header L1 → 400. Route only.
- For other auth sources: any of the three on routes that support
  them.
- Set `accessContext.requestBrain` from L1.

**(ii) Estate-aware auth-context resolution** (new in v9):
- Replace `loadPrincipalMemberships` with `loadPrincipalAccess`
  per D17.
- `resolveHumanAccessContext` and `resolveStoredAccessKeyContext`
  authorize requestedBrain against the combined accessible set
  (brain-memberships UNION estate-memberships, minus brain-deny).
- `accessContext.brainMemberships` and
  `accessContext.estateMemberships` are populated.
- `effectiveBrainId` derivation is unchanged in semantics: requested
  brain (if accessible) > key.brain_id > principal.default_brain_id.

Both changes ship together because the estate-aware loader is what
makes the new selector behavior correct for estate-only principals.

**Acceptance — selector unification:**
- ☐ MCP `?brain=ob1` + `x-brain-slug=agent-common` → 400.
- ☐ MCP human-token `?brain=ob1` → 400.
- ☐ MCP human-token `x-brain-slug=ob1` → 400.
- ☐ MCP human-token `POST /mcp/brains/ob1` → 200.
- ☐ Service-key MCP `?brain=ob1` → 200.

**Acceptance — estate-aware auth context (Finding 2 fix):**
- ☐ Stored-key principal with `brain_memberships(P, B1, allow)`
  AND `estate_memberships(P, E2, allow)`, where E2 contains brains
  B2 and B3:
  - `accessContext.brainMemberships` = [B1].
  - `accessContext.estateMemberships` = [E2].
  - Requested brain B1 → ALLOWED (via brain-membership).
  - Requested brain B2 → ALLOWED (via estate-membership).
  - Requested brain B3 → ALLOWED (via estate-membership).
  - Requested brain B4 (in estate E3, no membership) → 403 in
    `resolveAccessContext`.
- ☐ Stored-key principal with ONLY `estate_memberships(P, E2)`:
  - Requested brain B2 (in E2) → 200 (NEW: today this would 403
    because brain_memberships is empty).
- ☐ Stored-key principal with `brain_memberships(P, B1, deny)` and
  `estate_memberships(P, E1)` where B1 is in E1:
  - Requested brain B1 → 403 (deny wins, D6 case 4).
- ☐ Brain-bound key with `key.brain_id = B1` and
  `estate_memberships(P, E2)` containing B2:
  - Requested brain B1 → 200.
  - Requested brain B2 → 403 (brain-bound restriction wins,
    D6 case 3).
- ☐ Two estates with same slug accessible to one principal → 409.
- ☐ Brain-bound key with mismatched slug → 404.

**Removed from Phase 2b vs v7/v8** (still in Phase 2c):
- Non-MCP HTTP body-brain handler assertions.
- Route-handler edit enforcement assertions.

### Phase 2c — Tool & HTTP surfaces (handler layer)

(Unchanged in shape from v8 except for D7 alignment with ADR-0001.)

**Capture path** (`capture_thought`, `/ingest/thought`):

- Optional `brain` body field (L3).
- L3 disagreement with `requestBrain` → 400.
- For human-token: tool-arg `brain` MUST equal `requestBrain` if
  both set, else 400.
- L4 access check with `mode='write'`.
- Default brain when no `brain` specified: per auth source per D7,
  always single brain (`accessContext.effectiveBrainId` for non-
  brain-bound; `key.brain_id` for brain-bound;
  `effectiveBrainForLegacyAdmin` for legacy admin).

**Read path** (`search_thoughts`, `list_thoughts`, `ask_brain`,
`/ask`, `/admin/thought/similar`):

- Optional `brain` body field.
- If set: L3 disagreement check, L4 `mode='read'`, scope to that
  brain.
- If not set:
  - `legacy_admin_key`: `[effectiveBrainForLegacyAdmin]`.
  - `service_key, is_admin`: `listAccessibleBrainIds({mode: 'read'})`
    (= every brain in household).
  - `service_key, brain-bound`: `[key.brain_id]`.
  - `service_key, non-brain-bound non-admin`:
    `listAccessibleBrainIds({mode: 'read'})`.
  - `human_token`: `[requestBrain ?? principal.default_brain_id]`
    (single-brain per `docs/17`).

**`stats`:** D5 multi-brain shape per scope, server-derived.

**`/admin/thought/metadata`** (refined per D7 v9 — ADR alignment):

- Optional body `brain` field.
- Body `brain` set: resolve via D8, L4 `mode='edit'`,
  WHERE: `id = $1 AND brain_id = $resolved`.
- Body `brain` unset: scope to single brain per auth source per
  D7 v9. WHERE: `id = $1 AND brain_id = $effectiveBrainId`.
- No multi-brain default. ADR-0001 contract preserved.

**`/graph/*`:** unchanged. Admin-only.

**Acceptance — legacy_admin_key (unchanged from v7/v8):**
- ☐ Smoke harness passes.
- ☐ Without route L1, default brain works.
- ☐ With route L1 `POST /mcp/brains/<other>`, OTHER brain only;
  default DENIED.
- ☐ Patch with body `brain` mismatching effective brain → 400.

**Acceptance — service_key, brain-bound (unchanged):**
- ☐ Capture with no `brain` → `key.brain_id`.
- ☐ Capture with `brain=<other>` → 403.
- ☐ Patch with no body `brain` → scoped to `key.brain_id`. Row in
  another brain → 404.
- ☐ Patch with body `brain=<other>` → 403.

**Acceptance — service_key, non-brain-bound (REPO PRINCIPAL,
refined per ADR alignment):**
- ☐ Capture with no `brain` → repo brain (default).
- ☐ Capture with `brain="agent-common"` (role≥member) → 200.
- ☐ Capture with `brain="<unrelated>"` → 403.
- ☐ Search with no `brain` → spans accessible brains (read
  default per ADR-0001 point 11).
- ☐ Search with `brain="ob1"` → repo only.
- ☐ Patch with no body `brain` → **scoped to repo brain (effective
  default)**. Row in agent-common → **404** with explicit "not
  found in default brain; pass body `brain` for cross-brain patch".
- ☐ Patch with body `brain="agent-common"` (role='editor') → 200.
- ☐ Patch with body `brain="agent-common"` (role='member' only)
  → 403.
- ☐ Patch with body `brain="agent-common"` (estate-admin via D3
  operator path) → 200.
- ☐ Patch with body `brain="agent-common"` (estate-member only,
  D12) → 403.

**Acceptance — service_key, is_admin:**
- ☐ Capture with `brain=<in-household>` → 200.
- ☐ Capture with `brain=<in-OTHER-household>` → 403.
- ☐ Patch with no body `brain` → scoped to
  `accessContext.effectiveBrainId` (single brain). Row elsewhere
  in household → 404.
- ☐ Patch with body `brain=<another-in-household>` → 200.
- ☐ Patch with body `brain=<in-OTHER-household>` → 403.

**Acceptance — human_token (Finding 1 closure):**

MCP routes (unchanged from v7/v8):
- ☐ Search with no `brain` → `requestBrain` only.
- ☐ Search with body `brain` matching `requestBrain` → 200.
- ☐ Search with body `brain` ≠ `requestBrain` → 400.
- ☐ Capture with no `brain` → `requestBrain`.
- ☐ Capture with body `brain` ≠ `requestBrain` → 400.

Non-MCP HTTP routes:
- ☐ `/ingest/thought` body `brain` UNSET → captures into
  `principal.default_brain_id`.
- ☐ `/ingest/thought` body `brain="agent-common"` (with brain-
  membership role≥member) → 200.
- ☐ `/ingest/thought` body `brain="<unrelated>"` → 403.
- ☐ `/ask` body `brain` UNSET → reads from default brain.
- ☐ `/admin/thought/metadata` body `brain` UNSET → scoped to
  default brain. Row in agent-common → 404 with "pass body `brain`
  for cross-brain patch."
- ☐ `/admin/thought/metadata` body `brain="agent-common"`
  (role='editor') → 200.
- ☐ `/admin/thought/metadata` body `brain="agent-common"`
  (estate-member only, D12) → 403.

**Acceptance — selector disagreement (unchanged).**

**Acceptance — `stats` shape (unchanged from D5).**

### Phase 3 — Provisioning CLI (unchanged from v7/v8)

### Phase 4 — Per-repo `.envrc` (unchanged)

### Phase 5 — Routing skill (refined for D7 v9)

The skill (`skills/agent-brain-routing/SKILL.md`) instructs agents:

```
Capture rules:

- Capture default (no `brain` arg) goes to your repo brain.
- Pass brain="agent-common" explicitly when:
  (a) the thought is about a tool, technique, or pattern not
      specific to one codebase;
  (b) the thought is a meta-observation about how to collaborate
      or what the operator prefers across all work;
  (c) the thought is a fact about the operator's environment /
      infrastructure that any agent might need.

Edit / patch rules:

- /admin/thought/metadata defaults to your repo brain.
- To patch a thought in agent-common, ALWAYS pass body brain="agent-
  common" (or the brain UUID). Without it, the patch will return 404.

Search rules:

- Default search (no `brain` arg) returns hits from all your
  accessible brains. This is the agent's read default.
- Pass brain="<slug>" to scope to one brain.

Stats rules:

- Default stats returns aggregated multi-brain stats with a per-
  brain breakdown in `brains[]`.
```

Skill rule clarifies the v9 D7 contract: writes are single-brain by
default; reads are multi-brain by default; cross-brain writes
require explicit `brain`.

System-config Nix deploy via the `live-retrieval` pattern (doc 26).

### Phase 6 — Migrate writers (refined per D7 v9)

`scripts/thought_enrichment/*` and other operator scripts (per v6+):

- Read `OB1_OPERATOR_ACCESS_KEY` only.
- Startup preflight via `/admin/thought/access-check?target_brain=<UUID>`
  (D8/D15).
- Patches send body `brain=<UUID>` on every call. **This is now
  mandatory under v9 D7 (was already in v6+ but is now non-
  optional per the ADR-aligned contract).**
- A patch without body `brain` would patch against the operator's
  default brain (D7), not the script's `--brain-id` target. The
  enrichment scripts always know the target brain UUID, so they
  always pass `brain=<UUID>`. Acceptance test in Phase 6 confirms.

Smoke harness: legacy-admin only, reads `OB1_LEGACY_ADMIN_KEY`.

**Acceptance:**
- ☐ Smoke harness with `OB1_LEGACY_ADMIN_KEY` passes.
- ☐ `enrich.py --apply --brain-id <prod-luchoh>` succeeds.
  Patches send body `brain=<luchoh-UUID>`. `prod-luchoh` is also the
  operator's default brain, so the result would be the same with or
  without explicit body brain — but the script sends it for
  consistency.
- ☐ `enrich.py --apply --brain-id <agent-common>` succeeds. Patches
  send body `brain=<agent-common-UUID>`. **Without the body brain,
  patches would target the operator's default brain (`luchoh`) and
  return 404 — Phase 6 acceptance test confirms the body brain is
  set.**
- ☐ Without `OB1_OPERATOR_ACCESS_KEY` set: scripts error clearly.
- ☐ Inside an OB1 repo shell, with `MCP_ACCESS_KEY` set to repo
  key but no `OB1_OPERATOR_ACCESS_KEY`: scripts error before any DB
  reads.

### Phase 7 — Legacy-admin layer hygiene (unchanged from v7/v8)

## Risks and mitigations

(Unchanged from v8, plus:)

- **D7 single-brain default on write surfaces is "less convenient"
  than v8's multi-brain scan for agent scripts.** Mitigation:
  agent scripts (the only callers that would benefit from multi-
  brain default) already know the target brain UUID — they always
  pass `brain` explicitly. Phase 6 acceptance test confirms.
- **Phase 2b is bigger work than v8 admitted.** Mitigation: D17
  acknowledges the auth-context-layer rewrite. Phase 2b is honest
  about the scope (selector unification + estate-aware loader +
  combined-set authorization). The phase is still independently
  landable; the scope is just larger than "selector-only."

## Out of scope, tracked separately

(Unchanged from v7/v8.)

## Open questions

(Unchanged from v7/v8.)
