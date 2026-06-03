# PRD: Agent Estate + Brain Selection — Implementation Roadmap (v17)

Date: 2026-06-03
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`,
           CONTEXT `CONTEXT.md`,
           reviews v1–v16
Supersedes: v1–v16

## Why v17

v16 was rejected on one finding and two secondary gaps:

1. **v16's new human-token estate-only `POST /ingest/thought` row
   was `200` while D12 says estate-member is read-only.** Internal
   contradiction. The fix is mechanical: split the row by role.
   Estate-member → 403 (D12 holds). Estate-admin → 200.
2. **Read handlers were named as migration sites in D8 v16 but
   Phase 3 didn't add executable acceptance rows for them.** Same
   "patch one layer, forget the test" pattern. Fix: add explicit
   acceptance rows for `/ask`, `/admin/thought/similar`,
   `search_thoughts`, `list_thoughts`, `stats`.
3. **Retrieval-default contract is contradicted between
   ADR-0001 point 11 ("default = all accessible brains") and
   `docs/17:744` ("default retrieval never crosses brain
   boundaries").** v16 buried the auth-source split as a one-bullet
   handler note. v17 promotes it to a normative D19 with explicit
   reconciliation language — and declares which doc is canonical
   for which auth source.

## Vocabulary recap (unchanged)

## Layering model (unchanged)

## Goals (unchanged)

## Non-goals (unchanged)

## Design decisions

### D1. Estate membership is allow-only (unchanged)

### D2. Selector model — per-auth-source AND per-route admissibility (unchanged)

### D3. Operator path (unchanged)

### D4. Phase scope (unchanged)

### D5. `stats` response shape (unchanged)

### D6. Access-check helper — three modes, single-brain legacy admin (unchanged)

### D7. Omitted-`brain` write defaults align with ADR-0001; L4 runs on every write (unchanged)

### D8. Slug-vs-UUID resolution (unchanged from v16)

### D9. Human-token request-scoped binding (unchanged from v15)

### D10. Env split (unchanged)

### D11. Stored `is_admin` provisioning policy (unchanged)

### D12. Estate-membership `role='member'` is read-only (unchanged; reaffirmed against v16's slip)

`role='member'` on `estate_memberships` grants **read access** to
every brain in the estate. It does NOT grant write or edit access.
Write/edit through estate-membership require `role='admin'`.

This rule is normative. Phase 3 acceptance rows that imply
otherwise (like v16's "estate-only POST /ingest/thought → 200")
are bugs to be fixed, not exceptions. v17 splits any such row by
role.

The principal-level effect:
- estate-`admin` on E: read + write + edit on every brain in E
  (subject to brain-deny override).
- estate-`member` on E: read-only on every brain in E.
- `brain_memberships` rows have their own role hierarchy
  (member < editor < owner) for per-brain operations and are
  independent of estate-membership role.

### D13. Smoke harness contract (unchanged)

### D14. Legacy-admin layer hygiene (unchanged)

### D15. `/admin/thought/access-check` query param `target_brain` (unchanged)

### D16. No estate-rename in this work (unchanged)

### D17. Auth-context resolution becomes estate-aware (unchanged)

### D18. Visibility-via-explicit-grants; lookup ⊇ access; D18 governs slug-resolution and read-visibility only (unchanged from v16)

### D19. Default retrieval scope — auth-source split, with canonical reconciliation between ADR-0001 and `docs/17` (Finding secondary 2 fix)

ADR-0001 point 11 says read tools default to all accessible
brains. `docs/17:744` says default retrieval never crosses brain
boundaries. These are not in conflict — they describe different
auth-source contracts:

- **ADR-0001 was written for the agent estate model.** `service_key`
  agents (repo principals + operator stored key) explicitly need
  cross-brain recall as their core feature (the common-brain pattern
  is meaningless without it).
- **`docs/17` was written for the household-human model.**
  `human_token` callers (Keycloak-bound humans) explicitly want
  brain-boundary preservation (the spousal-privacy use case).

Both are correct **for their auth source**. v17 makes this canonical:

| auth source                            | default read scope when no `brain` arg | Canonical doc                        |
|----------------------------------------|-----------------------------------------|--------------------------------------|
| `legacy_admin_key`                     | `[effectiveBrainForLegacyAdmin]` (single brain) | D6 case 1                            |
| `service_key, is_admin`                | every brain in `accessContext.householdId` | ADR-0001 point 11                    |
| `service_key, brain-bound`             | `[key.brain_id]` (single brain)         | D6 case 3                            |
| `service_key, non-brain-bound, non-admin` | `listAccessibleBrainIds({mode: 'read'})` (multi-brain) | **ADR-0001 point 11**               |
| `human_token`                          | `[requestBrain ?? principal.default_brain_id]` (single brain) | **`docs/17:556 + 744`**             |

Tools affected: `search_thoughts`, `list_thoughts`, `ask_brain`,
`/ask`, `/admin/thought/similar`, `stats`.

Explicit `brain` argument on read tools always wins (subject to L4
mode='read' check). The defaults above only apply when no `brain`
is specified.

**Reconciliation statement:**

`docs/17:744`'s "default retrieval never crosses brain boundaries"
applies to **`human_token` only**, where the goal is preserving
brain-as-privacy-boundary for households. Not superseded; scoped.

ADR-0001 point 11's "default to all accessible brains" applies to
**`service_key` non-brain-bound and `service_key, is_admin`**, where
the goal is cross-repo recall for agents and full visibility for
admin keys. The `docs/17:744` rule does not apply to these auth
sources.

If a future ADR wants to unify these defaults — e.g., make
human-token default to multi-brain too, opt-in to spousal-privacy
via explicit `brain` — that's a separate decision. v17 keeps the
auth-source split.

## Phasing

### Phase 1 — Schema (unchanged)

### Phase 2 — Auth context + helpers (unchanged from v15)

### Phase 3 — Tool & HTTP surfaces (Finding 1 fix; Secondary 1 fix; D19 acceptance)

Handler-layer changes. Acceptance rows now cover:
- v16's existing capture/edit closure tests (preserved).
- The human-token non-MCP HTTP body-`brain` rows from v16 with
  Finding 1 fix (estate-member capture → 403; estate-admin → 200).
- New explicit Phase 3 acceptance for read handlers per D19.

#### Capture path (unchanged from v15/v16)

#### Read path — D19 default-scope acceptance (NEW in v17)

Each read tool gets explicit acceptance rows for the auth-source-
specific default scope.

**`search_thoughts` (MCP) and `/admin/thought/similar` (HTTP):**

| auth source                                | scenario                                         | expected default scope |
|--------------------------------------------|--------------------------------------------------|------------------------|
| `legacy_admin_key`                         | no body `brain`                                  | `[effectiveBrainForLegacyAdmin]` |
| `service_key, is_admin`                    | no body `brain`                                  | every brain in household |
| `service_key, brain-bound`                 | no body `brain`                                  | `[key.brain_id]` |
| `service_key, non-brain-bound, non-admin`  | no body `brain`                                  | `listAccessibleBrainIds({mode:'read'})` (multi-brain) |
| `human_token`                              | no body `brain` (D19 single-brain per `docs/17:744`) | `[requestBrain ?? principal.default_brain_id]` |
| any                                        | body `brain="<accessible>"`                      | `[<resolved>]` (explicit) |
| any                                        | body `brain="<inaccessible>"`                    | 403 |

**`list_thoughts` (MCP):** identical default-scope rules to
`search_thoughts`. Plus result rows tagged with `brain_id`/`brain_slug`
when scope is multi.

**`ask_brain` (MCP) and `/ask` (HTTP):** identical default-scope rules.

**`stats` (MCP):** D5 multi-brain shape per scope:
- `legacy_admin_key` → `scope: "legacy"`.
- `human_token`, `service_key brain-bound`, single-brain
  accessible: `scope: "single"`.
- `service_key non-brain-bound non-admin`, `service_key is_admin`
  with multi-brain accessible: `scope: "multi"` with `brains[]`.

**Acceptance — concrete read-handler rows:**

| auth, route, scenario                                                                      | expected |
|--------------------------------------------------------------------------------------------|----------|
| `human_token`, MCP `search_thoughts` no body `brain`, principal has access to repo brain + common-brain via brain-membership | results from `[requestBrain ?? default_brain_id]` only (D19) |
| `service_key non-brain-bound`, MCP `search_thoughts` no body `brain`, same memberships     | results from BOTH brains, rows tagged with brain_id/slug (D19, ADR-0001 point 11) |
| `human_token`, `/ask` no body `brain`, principal has membership to multiple brains         | scoped to default brain only (D19) |
| `service_key non-brain-bound`, `/ask` no body `brain`, same                                | scoped to all accessible brains (D19) |
| any, `search_thoughts` body `brain="<inaccessible>"`                                       | 403 |
| any, `search_thoughts` body `brain="<typo>"`                                               | 404 |
| `human_token`, `stats` no body `brain`                                                     | `scope: "single"` shape, current legacy-shape fields preserved |
| `service_key non-brain-bound`, `stats` no body `brain`, multi-accessible                   | `scope: "multi"` shape with `brains[]` |
| `legacy_admin_key`, `stats` no body `brain`                                                | `scope: "legacy"` shape, exactly today's response keys |

#### Metadata patch (unchanged from v15/v16)

#### Capture path — Human-token non-MCP HTTP (Finding 1 fix; row split by role)

v16's "human-token estate-only access POST /ingest/thought" row is
split. Estate-member is read-only per D12 — capture must deny.
Estate-admin can write.

| auth, scenario                                                                  | route + body                                                            | expected | rationale |
|---------------------------------------------------------------------------------|-------------------------------------------------------------------------|----------|-----------|
| `human_token`, brain-membership exists                                          | `POST /ingest/thought` body `brain="ob1"`                               | 200      | L4 mode='write' allows |
| `human_token`, brain-membership exists                                          | `POST /admin/thought/metadata` body `brain="ob1"` (role='editor')       | 200      | L4 mode='edit' allows |
| `human_token`, no membership to target, target in same household                | `POST /ingest/thought` body `brain="<same-household-no-grant>"`         | 404      | D8 lookup miss |
| `human_token`, no membership to target, target in same household                | `POST /admin/thought/metadata` body `brain="<same-household-no-grant>"` | 404      | same |
| `human_token`, brain-deny override of estate-allow                              | `POST /ingest/thought` body `brain="<denied-via-brain-deny>"`           | 403      | D8 lookup hit, deny wins |
| `human_token`, brain-deny override of estate-allow                              | `POST /admin/thought/metadata` body `brain="<denied-via-brain-deny>"`   | 403      | same |
| `human_token`, body `brain` is a typo / not in scope                            | `POST /ingest/thought` body `brain="<typo>"`                            | 404      | D8 step 1 miss |
| **`human_token`, estate-`member` access (D12 read-only)** (Finding 1 fix)       | **`POST /ingest/thought` body `brain="<brain-in-membership-estate>"`**  | **403**  | **D12: estate-member is read-only; mode='write' denied** |
| **`human_token`, estate-`admin` access** (NEW row split)                        | **`POST /ingest/thought` body `brain="<brain-in-membership-estate>"`**  | **200**  | **D12: estate-admin grants write** |
| **`human_token`, estate-`member` access on edit attempt** (preserves v16 row)   | **`POST /admin/thought/metadata` body `brain="<brain-in-membership-estate>"`** | **403**  | **D7 + D12: mode='edit' denied; mode-based 403, NOT a deny-override 403 (D18 v16 carve-out)** |
| **`human_token`, estate-`admin` access on edit attempt**                        | **`POST /admin/thought/metadata` body `brain="<brain-in-membership-estate>"`** | **200**  | **D12: estate-admin grants edit** |
| `human_token`, no body `brain` on metadata patch                                | `POST /admin/thought/metadata` no body brain, target row in non-default brain | 404      | D7 v9: scope to default brain |

The two **role-split** rows close Finding 1: estate-member is
explicitly 403 for write/edit; estate-admin is explicitly 200.
D12 holds across the contract.

**Other acceptance** (legacy admin, brain-bound, repo principal,
admin in household, human-token MCP routes, `/admin/thought/access-check`):
unchanged from v15/v16.

### Phase 4 — Provisioning CLI (unchanged)

### Phase 5 — Per-repo `.envrc` (unchanged)

### Phase 6 — Routing skill (unchanged)

### Phase 7 — Migrate writers (unchanged)

### Phase 8 — Legacy-admin layer hygiene (unchanged)

## Risks and mitigations

(Unchanged from v16, plus:)

- **D12 must hold under all auth sources for write/edit.**
  Mitigation: Phase 3 has explicit role-split rows for human-token
  estate-only on `/ingest/thought` and `/admin/thought/metadata`.
  Implementer cannot pass Phase 3 without enforcing D12 for
  human-token.
- **D19 reconciles ADR-0001 point 11 with `docs/17:744`.**
  Mitigation: declared as an ADR-level decision in D19, with the
  per-auth-source default-scope table. Phase 3 has executable
  acceptance for each row. The reader doesn't have to infer which
  doc wins.
- **Read-handler migration is a Phase 3 deliverable, not Phase 2.**
  Mitigation: D19 + Phase 3 explicit acceptance rows for `/ask`,
  `/admin/thought/similar`, `search_thoughts`, `list_thoughts`,
  `stats`. Migration sites named in D8 v16.

## Out of scope, tracked separately (unchanged)

## Open questions (unchanged, plus:)

- D19's auth-source split between agent and human retrieval defaults
  — should it persist long-term, or do we eventually want a unified
  default with explicit opt-out? Defer until human-token is wired
  in production and operator usage data accumulates.
