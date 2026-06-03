# PRD: Agent Estate + Brain Selection — Implementation Roadmap (v20)

Date: 2026-06-03
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`,
           CONTEXT `CONTEXT.md`,
           reviews v1–v19
Supersedes: v1–v19 (genuinely; this doc is self-contained.)

## Why v20

v19 was rejected on one finding plus two secondary gaps. All three
were instances of the same recurring failure: **describing the
same thing in multiple places with subtle drift, then pretending
the drift is intentional**. v19 did this with the legacy-admin
pipeline order (D19 said one order, Phase 3 said another), with
the acceptance tables (claimed "supersedes" while saying "same as
v18" throughout), and with the plumbing checklist (claimed `b8ef895`
already added schema `brain` fields when it didn't).

v20 has three structural commitments to break the cycle:

1. **The pipeline order is written ONCE in D19 as a numbered list.**
   Phase 3's plumbing checklist references it by number; it does
   not restate it.
2. **Phase 3's acceptance is inlined fully.** No "same as v18", no
   "unchanged from v17". An implementer reading v20 alone has the
   complete contract.
3. **The plumbing checklist's done/not-done states are verified
   against the current `master` (`55cca53` plus subsequent
   commits).** Every `b8ef895`-claim was checked by reading the
   actual file. Result: no schema has a `brain` field today.

## Vocabulary recap (unchanged)

(Defined in `CONTEXT.md`.)

## Layering model (unchanged from v17–v19)

(Four layers: L1 selector, L2 context, L3 per-call brain, L4
access check.)

## Goals (unchanged)

## Non-goals (unchanged)

## Design decisions

### D1. Estate membership is allow-only (unchanged)

`estate_memberships` has no `is_deny`. Brain-level deny is the only
deny.

### D2. Selector model — per-auth-source AND per-route admissibility (unchanged for non-legacy; legacy-admin governed by D7a)

L1 sources: route, query, header. Two simultaneous L1 sources
disagreeing → 400.

| auth source         | route | query | header |
|---------------------|:-----:|:-----:|:------:|
| `human_token`       | yes   | NO    | NO     |
| `service_key`       | yes   | yes   | yes    |
| `legacy_admin_key`  | governed by D7a |

L3 sources: tool-arg `brain` field on MCP tools, body `brain` on
non-MCP HTTP routes. Per-route admission table from v7 stands.

### D3. Operator path (unchanged from v6)

Existing principal `luchoh` in `local-household` gets a
non-admin, non-brain-bound `service_key` plus
`estate_memberships(luchoh, agent-estate, role='admin')`.

### D4. Phase scope (unchanged)

In scope: MCP tools, `/ingest/thought`, `/ask`,
`/admin/thought/metadata`, `/admin/thought/similar`. Out: `/graph/*`.

### D5. `stats` response shape (unchanged from v6)

`scope` field server-derived: `legacy` | `single` | `multi`.

### D6. Access-check helper — three modes, single-brain legacy admin (unchanged from v10)

```
checkBrainAccess({accessContext, brainId, mode}) where mode ∈ {'read','write','edit'}:

1. legacy_admin_key
     brainId == effectiveBrainForLegacyAdmin → ALLOW
     else → DENY
2. service_key, is_admin
     brain.household_id == accessContext.householdId → ALLOW
     else → DENY
3. service_key, brain-bound
     brainId == key.brain_id → ALLOW
     else → DENY
4. service_key non-brain-bound non-admin OR human_token:
     brain-deny on (P, B) → DENY
     mode='read':
       brain-allow OR estate-allow → ALLOW
       else → DENY
     mode='write':
       brain-allow role≥member OR estate-allow role='admin' → ALLOW
       else → DENY
     mode='edit':
       brain-allow role∈{owner,editor} OR estate-allow role='admin' → ALLOW
       else → DENY
```

### D7. Omitted-`brain` write defaults align with ADR-0001; L4 runs on every write (unchanged from v10)

Write surfaces without body `brain` scope to a single brain
(`accessContext.effectiveBrainId`). Cross-brain writes require
explicit body `brain`. L4 runs on every write surface against the
resolved target, every time.

### D7a. Legacy-admin selector contract — single canonical place (rule semantics unchanged from v19; ordering deferred to D19)

Legacy-admin operates on exactly one brain per request,
`effectiveBrainForLegacyAdmin(accessContext)`:
- L1-resolved brain (route/query/header) if any L1 selector is
  admissible AND present.
- Otherwise `resolveDefaultAdminBrain()`.

Body / tool-arg `brain` rules:
- **Rule L-1:** if set AND it does not resolve to the same UUID as
  `effectiveBrainForLegacyAdmin`, return 400.
- **Rule L-2:** if set AND it resolves to the same UUID, accept as
  redundant confirmation; proceed against the same brain.
- If unset, proceed against `effectiveBrainForLegacyAdmin`.

These rules apply uniformly across MCP tools and non-MCP HTTP
routes. Read default: `[effectiveBrainForLegacyAdmin]`. Write
default: same. L4: D6 case 1.

**Note:** "resolve to the same UUID" is intentional — D8
normalization runs first; D7a then compares canonical brain IDs.
The full pipeline order is D19.

### D8. Slug-vs-UUID resolution — visibility tracks explicit grants, with deny override visible (unchanged from v15)

#### Slug lookup scope per auth source (v15 wording)

| auth source                                | slug lookup scope                                                                       |
|--------------------------------------------|-----------------------------------------------------------------------------------------|
| `legacy_admin_key`                         | global brains table                                                                     |
| `service_key, is_admin=true`               | every brain in `accessContext.householdId`                                              |
| `service_key, brain-bound`                 | `[key.brain_id]`                                                                        |
| `service_key, non-brain-bound, non-admin`  | `brainAllows(P) ∪ estateBrains(estateAllows(P))`                                        |
| `human_token`                              | same                                                                                    |

`accessibleSet(P) = brainAllows(P) ∪ estateBrains(estateAllows(P)) − brainDenies(P)`.
`lookupScope(P) = brainAllows(P) ∪ estateBrains(estateAllows(P))`.
`lookupScope(P) ⊇ accessibleSet(P)`.

`resolveBrainSlug({accessContext, slug})`:
1. Lookup in `lookupScope(P)`. 0 matches → 404; multiple → 409;
   else proceed with the resolved UUID.
2. `checkBrainAccess({mode: 'read'})` against the UUID. ALLOW →
   return; DENY → 403.

`resolveBrainUuid({accessContext, brainId})`:
1. UUID not in `brains` → 404.
2. `checkBrainAccess({mode: 'read'})`. ALLOW → return; DENY → 403.

Orphan deny rows (deny without an allow path) → lookup miss → 404.

### D9. Human-token request-scoped binding (unchanged)

Human-token: route L1 only. tool-arg/body `brain` must equal
`requestBrain` if both set; tool-arg-only without route L1 = 400.

### D10. Env split (unchanged from v6)

`MCP_ACCESS_KEY`, `OB1_LEGACY_ADMIN_KEY`,
`OB1_OPERATOR_ACCESS_KEY`. Roles per v6 D10.

### D11. Stored `is_admin` provisioning policy (unchanged)

Provisioning CLI refuses `is_admin=true` without `--allow-admin`.

### D12. Estate-membership `role='member'` is read-only (unchanged from v7)

Write/edit through estate-membership require `role='admin'`.

### D13. Smoke harness contract — legacy-admin only (unchanged)

### D14. Legacy-admin layer hygiene (unchanged from v7)

`config.accessKey` is the choke point, not `brain_access_keys` rows.

### D15. `/admin/thought/access-check` query param `target_brain` (unchanged)

### D16. No estate-rename in this work (unchanged)

### D17. Auth-context resolution becomes estate-aware (unchanged from v10)

`loadPrincipalAccess` returns `brainMemberships` and
`estateMemberships`. Resolvers populate them on `accessContext`.

### D18. Visibility-via-explicit-grants; lookup ⊇ access; D18 scoped to slug-resolution and read-visibility only (unchanged from v16)

### D19. Pipeline order — single canonical sequence, applies to ALL auth sources (Finding 1 fix)

This is the **only place** in v20 that the request-processing
pipeline order is specified. Phase 3 plumbing and acceptance
reference D19 by step number; they do not restate it.

#### The order

For every brain-scoped request, the runtime applies these steps in
order. A failure at any step short-circuits subsequent steps with
the indicated status code.

```
Step 1. L1 admissibility check (D2 + D9).
        Detect simultaneous L1 sources (route/query/header).
        Reject inadmissible sources for the auth source.
        On failure: 400.
        On success: accessContext.requestBrain is set (or null).

Step 2. L3 admissibility check (D2).
        Tool-arg/body `brain` allowed for this auth source on
        this route?
        On failure: 400.
        On success: proceed.

Step 3. Slug/UUID normalization (D8).
        If L3 selector or L1 selector is a slug, resolve to UUID
        via resolveBrainSlug (lookup scope per auth source).
        If L3 selector is a UUID, validate via resolveBrainUuid.
        On step-1 lookup miss: 404.
        On multi-match: 409.
        On lookup hit but step-2 access deny: 403.
        On success: canonical UUID(s) bound to the request.

Step 4. Cross-layer disagreement check.
        If both requestBrain (L1) and tool-arg/body `brain` (L3)
        are set, their resolved UUIDs must match. (For human-token
        per D9; for service-key per D2.)
        On disagreement: 400.

Step 5. Legacy-admin equality check (D7a).
        ONLY for legacy_admin_key.
        Compare the L3-resolved UUID (if any) against
        effectiveBrainForLegacyAdmin's UUID.
        On L-1 mismatch: 400.
        On L-2 match or L3 unset: proceed.

Step 6. Default-scope resolution (D19 default-scope table).
        Determine the brain set the operation runs against.
        For explicit-`brain` requests, scope = [resolved UUID].
        For omitted-`brain` requests, scope = the per-auth-source
        default from the table below.

Step 7. L4 access check (D6) for the operation mode.
        For each brain in scope (or the single target for write/
        edit), checkBrainAccess({mode: 'read' | 'write' | 'edit'}).
        On any DENY for a write/edit operation: 403.
        On all-DENY for a read operation: 403.
        On per-brain DENY for a read operation with a multi-brain
        scope: silently exclude that brain, proceed with the rest.

Step 8. Execute the operation.
        Read: fan out across surviving scope brains, merge.
        Write/edit: SQL UPDATE/INSERT against the single target.
```

Key implications of this ordering:

- **Step 3 always runs before Step 5.** Legacy-admin's L-1
  comparison is on canonical UUIDs, not raw slugs. A slug input
  resolves to a UUID first (via D8), then is compared. This means
  L-1 produces 400 on a mismatch even if both inputs were slugs
  pointing to different brains; it produces success on a match
  even if one side was a slug and the other a UUID.
- **Step 4 catches L1/L3 disagreement on canonical UUIDs.** Slugs
  → resolved → compared as UUIDs. No silent slug-vs-slug pass-
  through.
- **Step 5 is no-op for non-legacy auth sources.** The numbered
  pipeline applies to all; legacy-admin-specific behavior is one
  step in it, not a separate path.
- **Step 6 covers the auth-source split** between agent multi-brain
  defaults (ADR-0001 point 11) and human single-brain defaults
  (`docs/17:556 + 744`).

#### Default-scope table (referenced by Step 6)

| auth source                                | default read scope when no `brain` arg                   | Canonical doc        |
|--------------------------------------------|----------------------------------------------------------|----------------------|
| `legacy_admin_key`                         | `[effectiveBrainForLegacyAdmin]`                        | D7a                  |
| `service_key, is_admin`                    | every brain in `accessContext.householdId`              | ADR-0001 point 11    |
| `service_key, brain-bound`                 | `[key.brain_id]`                                        | D6 case 3            |
| `service_key, non-brain-bound, non-admin`  | `listAccessibleBrainIds({mode: 'read'})`                | ADR-0001 point 11    |
| `human_token`                              | `[requestBrain ?? principal.default_brain_id]`          | `docs/17:556 + 744`  |

Tools affected: `search_thoughts`, `list_thoughts`, `ask_brain`,
`/ask`, `/admin/thought/similar`, `stats`.

Write surfaces (`capture_thought`, `/ingest/thought`,
`/admin/thought/metadata`) default to a single brain per D7
regardless of auth source (see D7).

## Phasing

### Phase 1 — Schema (unchanged)

Migration `009_estate_memberships.sql` per v6.

**Acceptance:** unchanged.

### Phase 2 — Auth context + helpers (unchanged from v15)

(Implementation order and acceptance matrix from v15 / v17 / v18 /
v19 stand. See those for the full per-row acceptance table; v20
treats Phase 2 as stable.)

### Phase 3 — Tool & HTTP surfaces (Findings 1, 2, secondary fixes; fully self-contained in v20)

#### 3.0 Plumbing checklist — verified against current `master`

Each row's "current state" is verified by reading the actual
source on the current `master` tip (no claims based on commit
messages alone).

**Schema additions** (extend MCP tool / HTTP body schemas to admit
the `brain` field):

| schema target                  | location          | current state | required change |
|--------------------------------|-------------------|---------------|------------------|
| `captureThoughtSchema`         | `server.mjs:29`   | NO `brain` field | add optional `brain: z.string()` (slug or UUID) |
| `searchThoughtsSchema`         | `server.mjs:41`   | NO `brain` field | add optional `brain` |
| `listThoughtsSchema`           | `server.mjs:50`   | NO `brain` field | add optional `brain` |
| `askBrainSchema`               | `server.mjs:55`   | NO `brain` field | add optional `brain` |
| `updateThoughtMetadataSchema`  | `server.mjs:66`   | NO `brain` field; structured columns added in `b8ef895` | add optional `brain` |
| `similarThoughtLookupSchema`   | `server.mjs:92`   | NO `brain` field | add optional `brain` |
| `stats` (no input schema today) | MCP `server.tool("stats", ...)` registration | no input | add input schema with optional `brain` |

(v19 incorrectly claimed `captureThoughtSchema` and
`updateThoughtMetadataSchema` already had `brain` from `b8ef895`.
They do not. `b8ef895` added structured-column patch fields to
`updateThoughtMetadataSchema` only.)

**Auth-context resolver changes** (per D17):

| target                              | location              | required change |
|-------------------------------------|-----------------------|------------------|
| `loadPrincipalMemberships`          | `auth.mjs:65`         | rename to `loadPrincipalAccess`; return both `brainMemberships` and `estateMemberships` |
| `resolveStoredAccessKeyContext`     | `auth.mjs:241-317`    | slug lookup over `lookupScope(P)` per D8; populate new arrays |
| `resolveHumanAccessContext`         | `auth.mjs:159-225`    | same as above |
| `resolveAccessContext`              | `auth.mjs:367`        | detect simultaneous L1 sources → 400; reject query/header for human-token at L1 |

**Helper additions** (single new module or extension of existing):

- `checkBrainAccess({accessContext, brainId, mode})`
- `listAccessibleBrainIds({accessContext, mode})`
- `resolveBrainSlug({accessContext, slug})`
- `resolveBrainUuid({accessContext, brainId})`
- `effectiveBrainForLegacyAdmin(accessContext)`
- `GET /admin/thought/access-check?target_brain=<...>` route

**Handler-layer changes** (each handler runs through the D19
pipeline; "D19 steps" reference the numbered list above):

| handler                                | location           | change                                                                |
|----------------------------------------|--------------------|-----------------------------------------------------------------------|
| `handleCaptureThought`                 | `server.mjs:312`   | apply D19 steps 1–8; mode='write' at step 7; default at step 6 per D7 |
| `handleSearchThoughts`                 | `server.mjs:369`   | apply D19; mode='read'; default scope per Step 6 table               |
| `handleListThoughts`                   | `server.mjs:697`   | same                                                                 |
| `handleAskBrain`                       | `server.mjs:450`   | apply D19; preserve `graph_assisted` admin gate                      |
| `handleStats`                          | `server.mjs:707`   | apply D19; output shape per D5                                       |
| `handleSimilarThoughtLookup`           | `server.mjs:663`   | apply D19; mode='read'                                               |
| `updateThoughtMetadata` (called from `/admin/thought/metadata`) | `server.mjs:566` (helper) and `server.mjs:1085` (route) | apply D19; mode='edit' (always); SQL update against single target |

**Telemetry update:**

- `appendRetrievalTelemetry` (`observability.mjs:141`) accepts
  `brain_scope`, `searched_brain_ids`, `result_brain_ids` via the
  existing `extra` field.

#### 3.1 Acceptance — Capture path (`capture_thought`, `/ingest/thought`)

| auth source                                | scenario                                                     | expected | rationale (D19 step) |
|--------------------------------------------|--------------------------------------------------------------|----------|----------------------|
| `legacy_admin_key`                         | no body `brain`                                              | 200, target = `effectiveBrainForLegacyAdmin`              | Step 6 default |
| `legacy_admin_key`                         | body `brain="<other>"` (different from effective)            | 400      | Step 5 D7a L-1 |
| `legacy_admin_key`                         | body `brain="<same as effective>"`                           | 200      | Step 5 D7a L-2 |
| `service_key, is_admin`                    | no body `brain`                                              | 200, target = principal.default_brain_id                  | Step 6 |
| `service_key, is_admin`                    | body `brain="<in-household>"`                                | 200, target = `<that brain>`                              | |
| `service_key, is_admin`                    | body `brain="<in-OTHER-household>"`                          | 404      | Step 3 lookup miss |
| `service_key, brain-bound`                 | no body `brain`                                              | 200, target = `key.brain_id`                              | |
| `service_key, brain-bound`                 | body `brain="<other>"`                                       | 404      | Step 3 lookup scope = `[key.brain_id]` |
| `service_key, non-brain-bound`             | no body `brain`                                              | 200, target = principal.default_brain_id                  | |
| `service_key, non-brain-bound`             | body `brain="<accessible, role≥member>"`                     | 200      | Step 7 mode='write' allows |
| `service_key, non-brain-bound`             | body `brain="<accessible-via-deny>"`                         | 403      | Step 3 access deny |
| `service_key, non-brain-bound`             | body `brain="<typo>"`                                        | 404      | Step 3 lookup miss |
| `service_key, non-brain-bound, ESTATE-MEMBER ONLY (no brain-membership)` | body `brain="<brain-in-estate>"`                            | 403      | Step 7 mode='write' denies estate-member (D12) |
| `service_key, non-brain-bound, estate-admin` | body `brain="<brain-in-estate>"`                           | 200      | Step 7 mode='write' allows estate-admin |
| `human_token`, route `POST /mcp/brains/ob1`, MCP capture | tool-arg `brain="ob1"` (matches route)         | 200      | Step 4 match |
| `human_token`, route `POST /mcp/brains/ob1`, MCP capture | tool-arg `brain="agent-common"` (mismatches)   | 400      | Step 4 mismatch |
| `human_token`, route `POST /mcp` (no slug), MCP capture | tool-arg `brain="ob1"` (no route L1)           | 400      | Step 4 D9: tool-arg-only forbidden |
| `human_token`, non-MCP HTTP `/ingest/thought` | body `brain="<accessible-via-membership>"`                | 200      | Step 7 |
| `human_token`, non-MCP HTTP `/ingest/thought` | body `brain="<inaccessible>"`                             | 403      | |
| `human_token`, non-MCP HTTP `/ingest/thought` | body `brain="<typo>"`                                     | 404      | |
| `human_token`, non-MCP HTTP `/ingest/thought` | body `brain="<same-household-no-grant>"`                  | 404      | D8 lookup miss |
| `human_token`, non-MCP HTTP `/ingest/thought` | no body `brain`                                            | 200, target = principal.default_brain_id                  | |
| `human_token`, non-MCP HTTP, query `?brain=<anything>` | rejected at L1 (D2)                                  | 400      | Step 1 |
| any                                        | route+query L1 disagree                                      | 400      | Step 1 |

#### 3.2 Acceptance — Metadata patch (`/admin/thought/metadata`)

| auth source                                | scenario                                                     | expected | rationale |
|--------------------------------------------|--------------------------------------------------------------|----------|-----------|
| `legacy_admin_key`                         | no body `brain`                                              | scope = `[effectiveBrainForLegacyAdmin]`; row in scope → 200; row elsewhere → 404 | Step 6 default |
| `legacy_admin_key`                         | body `brain` mismatches effective                            | 400      | Step 5 D7a L-1 |
| `legacy_admin_key`                         | body `brain` matches effective                               | as no-body row | Step 5 D7a L-2 |
| `service_key, non-brain-bound`             | no body `brain`, target row in default brain                 | 200      | Step 6 default = effective |
| `service_key, non-brain-bound`             | no body `brain`, target row in another accessible brain     | 404 ("not in default brain; pass body `brain`") | Step 6 + Step 8 |
| `service_key, non-brain-bound, role='member' on agent-common` | body `brain="agent-common"`, target row in agent-common | 403 | Step 7 mode='edit' denies member |
| `service_key, non-brain-bound, role='editor' on agent-common` | body `brain="agent-common"`, target row in agent-common | 200 | Step 7 mode='edit' allows editor |
| `service_key, non-brain-bound, estate-admin on agent-estate` | body `brain="agent-common"`, target in agent-common      | 200      | |
| `service_key, non-brain-bound, ESTATE-MEMBER ONLY` | body `brain="<brain-in-estate>"`                          | 403      | mode='edit' denies (D12) |
| `human_token`, no body `brain`, target row in default brain | 200                                                  | |
| `human_token`, no body `brain`, target row in non-default brain | 404 (single-brain default per D9)                | |
| `human_token`, body `brain="agent-common"`, role='editor' on agent-common | 200 | |
| `human_token`, body `brain="agent-common"`, estate-member only | 403 (D12) | |
| any                                        | body `brain="<inaccessible>"`                                | 403 (Step 3 access deny) | |
| any                                        | body `brain="<typo>"`                                        | 404 (Step 3 lookup miss) | |

#### 3.3 Acceptance — `search_thoughts` (MCP)

| auth source                                | scenario                                                     | expected default scope or status |
|--------------------------------------------|--------------------------------------------------------------|----------------------------------|
| `legacy_admin_key`                         | no tool-arg `brain`, no L1                                   | `[effectiveBrainForLegacyAdmin (default)]` |
| `legacy_admin_key`                         | L1 set, no tool-arg                                          | `[L1-resolved brain]` |
| `legacy_admin_key`                         | tool-arg matches effective                                   | 200, scope unchanged |
| `legacy_admin_key`                         | tool-arg mismatches effective                                | 400 (Step 5) |
| `service_key, is_admin`                    | no tool-arg                                                  | every brain in household |
| `service_key, is_admin`                    | tool-arg `<in-household>`                                    | 200, scope = `[<that>]` |
| `service_key, is_admin`                    | tool-arg `<in-OTHER-household>`                              | 404 |
| `service_key, brain-bound`                 | no tool-arg                                                  | `[key.brain_id]` |
| `service_key, brain-bound`                 | tool-arg `<other>`                                           | 404 |
| `service_key, non-brain-bound`             | no tool-arg                                                  | `listAccessibleBrainIds({mode:'read'})` |
| `service_key, non-brain-bound`             | tool-arg `<accessible>`                                      | 200, scope = `[<that>]` |
| `service_key, non-brain-bound`             | tool-arg `<deny-override>`                                   | 403 |
| `service_key, non-brain-bound`             | tool-arg `<typo>`                                            | 404 |
| `human_token`, route `POST /mcp/brains/ob1` | no tool-arg                                                 | `[ob1]` |
| `human_token`, route `POST /mcp/brains/ob1` | tool-arg `brain="ob1"`                                      | 200, scope = `[ob1]` |
| `human_token`, route `POST /mcp/brains/ob1` | tool-arg `brain="agent-common"` (mismatch)                  | 400 (Step 4) |
| `human_token`, route `POST /mcp` (no slug) | tool-arg `brain="ob1"`                                       | 400 (Step 4 D9) |
| `human_token`, route `POST /mcp` (no slug) | no tool-arg                                                  | `[principal.default_brain_id]` |

#### 3.4 Acceptance — `list_thoughts` (MCP)

(Same shape as 3.3. Each row from 3.3 applies. Rows tagged with
`brain_id`/`brain_slug` when scope is multi.)

#### 3.5 Acceptance — `ask_brain` (MCP)

(Same shape as 3.3. Plus: `graph_assisted=true` AND not admin →
400, preserving the existing `handleAskBrain` rule.)

#### 3.6 Acceptance — `stats` (MCP)

| auth source                                | scenario                                              | response shape |
|--------------------------------------------|-------------------------------------------------------|----------------|
| `legacy_admin_key`                         | no tool-arg                                           | `scope: "legacy"`, today's exact field shape preserved (`overview`, `top_sources`, `top_types`, `top_people`, optional `graph`) |
| `service_key, is_admin`                    | no tool-arg, multi-brain household                    | `scope: "multi"` with `brains[]` |
| `service_key, is_admin`                    | no tool-arg, single-brain household                   | `scope: "single"` |
| `service_key, brain-bound`                 | no tool-arg                                           | `scope: "single"`, fields = today's shape + `brain_id`/`brain_slug` |
| `service_key, non-brain-bound`             | no tool-arg, multi-accessible                         | `scope: "multi"` with `brains[]` |
| `service_key, non-brain-bound`             | no tool-arg, single-accessible                        | `scope: "single"` |
| `service_key, non-brain-bound`             | tool-arg `<accessible>`                               | `scope: "single"` for that brain |
| `human_token`, route `POST /mcp/brains/ob1` | no tool-arg                                          | `scope: "single"` for `[ob1]` |
| `human_token`, route `POST /mcp/brains/ob1` | tool-arg mismatch                                    | 400 |
| any                                        | tool-arg `<typo>`                                     | 404 |

#### 3.7 Acceptance — `/ask` (non-MCP HTTP)

| auth source                                | scenario                                                       | expected |
|--------------------------------------------|----------------------------------------------------------------|----------|
| `legacy_admin_key`                         | no body `brain`                                                | scope = `[effectiveBrainForLegacyAdmin]` |
| `legacy_admin_key`                         | body `brain` matches effective                                  | 200 |
| `legacy_admin_key`                         | body `brain` mismatches effective                               | 400 |
| `service_key, non-brain-bound`             | no body `brain`                                                | `listAccessibleBrainIds({mode:'read'})` |
| `service_key, non-brain-bound`             | body `brain="<accessible>"`                                    | 200, scope = `[<that>]` |
| `service_key, non-brain-bound`             | body `brain="<inaccessible>"`                                  | 403 |
| `service_key, non-brain-bound`             | body `brain="<typo>"`                                          | 404 |
| `human_token`                              | no body `brain`                                                | scope = `[principal.default_brain_id]` |
| `human_token`                              | body `brain="<accessible-via-membership>"`                      | 200 |
| `human_token`                              | body `brain="<inaccessible>"`                                  | 403 |
| `human_token`                              | body `brain="<typo>"`                                          | 404 |
| `human_token`                              | with `?brain=<anything>` query                                  | 400 (D2) |

#### 3.8 Acceptance — `/admin/thought/similar` (non-MCP HTTP)

| auth source                                | scenario                                                       | expected |
|--------------------------------------------|----------------------------------------------------------------|----------|
| `legacy_admin_key`                         | no body `brain`                                                | scope = `[effectiveBrainForLegacyAdmin]` |
| `legacy_admin_key`                         | body `brain` matches effective                                  | 200 |
| `legacy_admin_key`                         | body `brain` mismatches effective                               | 400 |
| `service_key, is_admin`                    | no body `brain`                                                | every brain in household |
| `service_key, brain-bound`                 | no body `brain`                                                | `[key.brain_id]` |
| `service_key, non-brain-bound`             | no body `brain`                                                | `listAccessibleBrainIds({mode:'read'})` |
| `service_key, non-brain-bound`             | body `brain="<accessible>"`                                    | 200 |
| `service_key, non-brain-bound`             | body `brain="<inaccessible>"`                                  | 403 |
| `service_key, non-brain-bound`             | body `brain="<typo>"`                                          | 404 |
| `human_token`                              | no body `brain`                                                | `[principal.default_brain_id]` |
| `human_token`                              | body `brain="<accessible-via-membership>"`                      | 200 |
| `human_token`                              | body `brain="<inaccessible>"`                                  | 403 |
| `human_token`                              | body `brain="<typo>"`                                          | 404 |
| `human_token`                              | query `?brain=<anything>`                                       | 400 (D2) |
| any                                        | route+query+header L1 disagree                                  | 400 (Step 1) |

#### 3.9 Acceptance — `/admin/thought/access-check` (D8/D15)

| input                                                                          | expected |
|--------------------------------------------------------------------------------|----------|
| `?target_brain=<slug-in-lookup-scope, accessible>`                            | 200 |
| `?target_brain=<slug-in-lookup-scope, NOT accessible (deny)>`                  | 403 |
| `?target_brain=<slug-not-in-lookup-scope>`                                     | 404 |
| `?target_brain=<UUID-of-accessible-brain>`                                     | 200 |
| `?target_brain=<UUID-of-existing-but-inaccessible-brain>`                      | 403 |
| `?target_brain=<UUID-not-in-brains>`                                           | 404 |
| no `?target_brain=`                                                            | 400 |
| no auth                                                                         | 401 |

### Phase 4 — Provisioning CLI (unchanged from v6)

### Phase 5 — Per-repo `.envrc` (unchanged from v6)

### Phase 6 — Routing skill (unchanged from v6)

### Phase 7 — Migrate writers (unchanged from v6)

### Phase 8 — Legacy-admin layer hygiene (unchanged from v7 D14)

## Risks and mitigations

(Unchanged from v19, plus:)

- **One topic, one section.** Mitigation: D7a is the only place
  legacy-admin's selector contract lives. D19 is the only place
  the pipeline order lives. Other sections reference them by
  number.
- **Phase 3 acceptance is fully inlined in v20.** No
  cross-reference to v17/v18 for status codes. Implementer reading
  v20 alone has the full contract.
- **Plumbing-checklist done/not-done is verified against the
  current `master`.** Each row's "current state" was checked by
  reading the actual file on disk, not by trusting a commit
  message. Result for v20: NO schema currently has a `brain` field.

## Out of scope, tracked separately (unchanged)

## Open questions (unchanged)
