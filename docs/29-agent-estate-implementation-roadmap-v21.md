# PRD: Agent Estate + Brain Selection — Implementation Roadmap (v21)

Date: 2026-06-03
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`,
           CONTEXT `CONTEXT.md`,
           reviews v1–v20
Supersedes: v1–v20 (self-contained; Phase 2 and Phase 3 acceptance fully inlined.)

## Why v21

v20 was rejected on:

1. **Legacy-admin mismatch-`400` rows unreachable.** D19 Step 3
   ran D8 — which embeds a `mode='read'` access check returning
   `403` on lookup-hit-but-denied — before Step 5's D7a equality
   check could emit `400`. So a legacy-admin explicit-mismatch
   request returned `403`, not `400`, contradicting the entire
   D7a contract.
2. **Acceptance tables collapsed slug and UUID input shapes** even
   though D8 assigns them different failure classes. Slug-not-in-
   scope is `404`; UUID-exists-but-inaccessible is `403`.
3. **v20 was not honestly self-contained** — Phase 2 referenced
   v15/v17/v18/v19 instead of inlining its acceptance.

v21 fixes all three.

## Vocabulary recap

(Defined in `CONTEXT.md`.)

## Layering model

Four layers: L1 selector, L2 context, L3 per-call brain, L4
access. Body fields never promote to L1/L2.

## Goals (unchanged)

## Non-goals (unchanged)

## Design decisions

### D1. Estate membership is allow-only

`estate_memberships` has no `is_deny`. Brain-level deny is the only
deny.

### D2. Selector model — per-auth-source AND per-route admissibility

L1 sources: route, query, header. Two simultaneous L1 sources
disagreeing → 400.

| auth source         | route | query | header |
|---------------------|:-----:|:-----:|:------:|
| `human_token`       | yes (MCP only) | NO | NO |
| `service_key`       | yes (MCP only) | yes | yes |
| `legacy_admin_key`  | yes (MCP only) | yes | yes |

L3 sources: tool-arg `brain` field on MCP tools, body `brain` on
non-MCP HTTP routes.

### D3. Operator path

Existing principal `luchoh` in `local-household` gets a non-admin,
non-brain-bound `service_key` plus
`estate_memberships(luchoh, agent-estate, role='admin')`.

### D4. Phase scope

In scope: MCP tools (`capture_thought`, `search_thoughts`,
`list_thoughts`, `ask_brain`, `stats`), `/ingest/thought`, `/ask`,
`/admin/thought/metadata`, `/admin/thought/similar`. Out: `/graph/*`.

### D5. `stats` response shape

`scope` server-derived: `legacy` | `single` | `multi`. See §3.6 for
the exact field shape per scope.

### D6. Access-check helper — three modes, single-brain legacy admin

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

### D7. Omitted-`brain` write defaults align with ADR-0001; L4 runs on every write

Write surfaces without body `brain` scope to a single brain
(`accessContext.effectiveBrainId`). Cross-brain writes require
explicit body `brain`. L4 runs on every write surface against the
resolved target, every time.

### D7a. Legacy-admin selector contract — single canonical place

`effectiveBrainForLegacyAdmin(accessContext)`:
- L1-resolved brain (route/query/header) if present and admissible.
- Otherwise `resolveDefaultAdminBrain()`.

Rules for body / tool-arg `brain` (compared on canonical UUIDs;
D8 normalization runs first per D19):
- **Rule L-1:** if set AND its canonical UUID ≠
  `effectiveBrainForLegacyAdmin`'s UUID → 400.
- **Rule L-2:** if set AND UUIDs match → accepted as redundant
  confirmation; proceed.
- If unset → proceed against `effectiveBrainForLegacyAdmin`.

Read default: `[effectiveBrainForLegacyAdmin]`. Write default:
same. L4: D6 case 1.

### D8. Slug-vs-UUID resolution — split into normalize and access (Finding 1 fix)

v21 splits the previous combined `resolveBrainSlug` into two
named operations. **The pipeline (D19) calls only the normalize
operation at Step 3; access checks happen at Step 7.**

#### Slug lookup scope per auth source

| auth source                                | slug lookup scope |
|--------------------------------------------|-------------------|
| `legacy_admin_key`                         | global brains table |
| `service_key, is_admin=true`               | every brain in `accessContext.householdId` |
| `service_key, brain-bound`                 | `[key.brain_id]` |
| `service_key, non-brain-bound, non-admin`  | `brainAllows(P) ∪ estateBrains(estateAllows(P))` |
| `human_token`                              | same as service_key non-brain-bound |

`accessibleSet(P) = brainAllows(P) ∪ estateBrains(estateAllows(P)) − brainDenies(P)`.
`lookupScope(P) ⊇ accessibleSet(P)` always.

#### `normalizeBrainSelector({accessContext, input}) → UUID | 404 | 409`

**Lookup-only. No access check.** Used by D19 Step 3.

If `input` is a slug:
1. Look up in per-auth-source `lookupScope(P)`.
2. 0 matches → **404**. Multiple → **409**. One → return the UUID.

If `input` is a UUID:
1. Look up in `brains` (global, since UUIDs are opaque).
2. Not found → **404**. Found → return the UUID (no scope check
   here — Step 7 will gate access).

#### `resolveBrainSlug({accessContext, slug}) → UUID | 404 | 409 | 403`

Convenience wrapper used by `/admin/thought/access-check` only:
- Calls `normalizeBrainSelector`. Propagates 404/409.
- Calls `checkBrainAccess({mode:'read'})` on the resolved UUID.
  ALLOW → return UUID. DENY → **403**.

Routes that introspect access (the access-check endpoint) want
both layers. The pipeline (D19) wants Step 3 to ONLY normalize so
that Step 5 (D7a) gets a chance to emit `400` on mismatch before
any access check runs.

### D9. Human-token request-scoped binding

Human-token: route L1 only (D2). Tool-arg/body `brain` must equal
`requestBrain` (compared on canonical UUIDs after Step 3) if both
set; tool-arg-only without route L1 = 400.

### D10. Env split

`MCP_ACCESS_KEY`, `OB1_LEGACY_ADMIN_KEY`,
`OB1_OPERATOR_ACCESS_KEY`.

### D11. Stored `is_admin` provisioning policy

Provisioning CLI refuses `is_admin=true` without `--allow-admin`.

### D12. Estate-membership `role='member'` is read-only

Write/edit through estate-membership require `role='admin'`.

### D13. Smoke harness — legacy-admin only, reads `OB1_LEGACY_ADMIN_KEY`

### D14. Legacy-admin layer hygiene

`config.accessKey` (env `MCP_ACCESS_KEY`) is the choke point, not
`brain_access_keys` rows.

### D15. `/admin/thought/access-check` query param `target_brain`

### D16. No estate-rename in this work

### D17. Auth-context resolution becomes estate-aware

`loadPrincipalAccess` returns `brainMemberships` and
`estateMemberships`. Resolvers populate them on `accessContext`.

### D18. Visibility-via-explicit-grants; lookup ⊇ access

D18 governs slug-resolution and read-visibility outcomes. Mode-
based 403s (write/edit denial without a deny row) are governed by
D6 + D7 + D12.

### D19. Pipeline order — single canonical sequence (Finding 1 fix)

The **only** place the pipeline order is specified. Phase 3
plumbing and acceptance reference D19 by step number; they do not
restate it.

```
Step 1. L1 admissibility check (D2 + D9).
        On failure: 400.
        Sets accessContext.requestBrain (or null).

Step 2. L3 admissibility check (D2).
        Tool-arg/body `brain` allowed for this auth source on this route?
        On failure: 400.

Step 3. Normalize selectors (D8 normalizeBrainSelector).
        For each present selector (L1 slug, L3 slug, L3 UUID), call
        normalizeBrainSelector → UUID, 404, or 409.
        NO ACCESS CHECK at this step.

Step 4. Cross-layer disagreement (canonical-UUID equality).
        If both requestBrain and L3 brain are set, their normalized UUIDs
        must match.
        On disagreement: 400.

Step 5. Legacy-admin equality (D7a).
        ONLY for legacy_admin_key.
        Compare L3-resolved UUID against effectiveBrainForLegacyAdmin's UUID.
        On L-1 mismatch: 400.
        On L-2 match or L3 unset: proceed.

Step 6. Default-scope resolution.
        For explicit-`brain` requests, scope = [resolved UUID].
        For omitted-`brain` requests, scope = per-auth-source default
        (table below).

Step 7. L4 access check (D6) at the operation's mode.
        For each brain in scope (or single target for write/edit),
        checkBrainAccess({mode}).
        Read with multi-brain scope: silently exclude denied brains, proceed
        with the rest. Empty result set after exclusion → 200 with no rows
        (NOT 403).
        Read with single-brain scope: DENY → 403.
        Write/edit (always single target): DENY → 403.

Step 8. Execute (read fan-out + merge, OR write SQL).
```

**Why Step 3 is normalize-only, not lookup+check:**

For legacy-admin: the read check inside D8 would return 403 on a
non-default brain BEFORE Step 5 could emit 400. v20's bug. v21
moves the access check to Step 7 so D7a (Step 5) gets to see the
canonical UUIDs and emit the right error class.

For non-legacy: the access check still runs (at Step 7), so
brain-deny override of estate-allow still produces 403 on read.
The behavior is unchanged for non-legacy callers.

#### Default-scope table (referenced by Step 6)

| auth source                                | default read scope                              | Canonical doc        |
|--------------------------------------------|-------------------------------------------------|----------------------|
| `legacy_admin_key`                         | `[effectiveBrainForLegacyAdmin]`                | D7a                  |
| `service_key, is_admin`                    | every brain in `accessContext.householdId`      | ADR-0001 point 11    |
| `service_key, brain-bound`                 | `[key.brain_id]`                                | D6 case 3            |
| `service_key, non-brain-bound, non-admin`  | `listAccessibleBrainIds({mode: 'read'})`        | ADR-0001 point 11    |
| `human_token`                              | `[requestBrain ?? principal.default_brain_id]`  | `docs/17:556 + 744`  |

Tools affected: `search_thoughts`, `list_thoughts`, `ask_brain`,
`/ask`, `/admin/thought/similar`, `stats`. Write surfaces always
default to single brain per D7.

## Phasing

### Phase 1 — Schema

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

**Acceptance:**
- ☐ `\d+ estate_memberships` shows the table without `is_deny`.
- ☐ `\d+ brain_memberships` shows the new `is_deny` column.
- ☐ Smoke regression unchanged.

### Phase 2 — Auth context + helpers (Secondary 1 fix: inlined acceptance)

Implementation order:
1. Migration 009 (Phase 1).
2. `loadPrincipalAccess` per D17 (replaces
   `loadPrincipalMemberships` at `auth.mjs:65`).
3. `accessContext` shape: `brainMemberships`, `estateMemberships`.
4. `resolveStoredAccessKeyContext` (`auth.mjs:241-317`): slug
   lookup over `lookupScope(P)` per D8, populate arrays.
5. `resolveHumanAccessContext` (`auth.mjs:159-225`): slug lookup
   over `lookupScope(P)` per D8, populate arrays.
6. `resolveAccessContext` selector unification: simultaneous-L1 →
   400; reject query/header for human-token at L1.
7. Helpers: `normalizeBrainSelector`, `resolveBrainSlug`,
   `resolveBrainUuid`, `checkBrainAccess`, `listAccessibleBrainIds`,
   `effectiveBrainForLegacyAdmin`.
8. `GET /admin/thought/access-check?target_brain=<...>` route.

#### 2.1 Acceptance — selector + auth context (inlined)

| auth source                                                                   | scenario                                                              | expected |
|-------------------------------------------------------------------------------|-----------------------------------------------------------------------|----------|
| any                                                                           | route+query L1 disagree                                               | 400 |
| any                                                                           | route+header L1 disagree                                              | 400 |
| any                                                                           | query+header L1 disagree                                              | 400 |
| `human_token`                                                                 | `?brain=ob1`                                                          | 400 |
| `human_token`                                                                 | `x-brain-slug=ob1`                                                    | 400 |
| `human_token`                                                                 | `POST /mcp/brains/ob1` (brain-membership exists)                      | 200 |
| `service_key, is_admin`                                                       | `?brain=<in-household, no-membership>`                                | 200 |
| `service_key, is_admin`                                                       | `?brain=<slug-in-OTHER-household>`                                    | 404 |
| `service_key, brain-bound`                                                    | `?brain=<slug = key.brain_id slug>`                                   | 200 |
| `service_key, brain-bound`                                                    | `?brain=<other-slug>`                                                 | 404 |
| `service_key, non-brain-bound, brain-membership only`                         | `?brain=<member-brain-slug>`                                          | 200 |
| `service_key, non-brain-bound, estate-only`                                   | `?brain=<slug-in-membership-estate>`                                  | 200 |
| `service_key, non-brain-bound, estate-only`                                   | `?brain=<slug-in-OTHER-estate-NO-membership>`                         | 404 |
| `service_key, non-brain-bound, brain-deny + estate-allow`                     | `?brain=<denied-slug>` (lookup hit via estate, access denied)         | 403 |
| `service_key, non-brain-bound, ONLY direct cross-estate brain-membership`     | `?brain=<slug-in-other-estate-via-direct-brain-membership>`           | 200 |
| `service_key, non-brain-bound, repo principal homed in agent-estate, NO membership to sibling brain` | `?brain=<sibling-repo-brain-slug>`                                    | 404 |
| `service_key, non-brain-bound, repo with brain-membership to common-brain`    | `?brain=common-brain`                                                 | 200 |
| `service_key, non-brain-bound, ORPHAN DENY ROW (no allow path)`               | `?brain=<orphan-deny-brain-slug>`                                     | 404 |
| any non-legacy                                                                | `?brain=<typo>`                                                       | 404 |
| any non-legacy                                                                | slug matches multiple in lookup scope                                 | 409 |

#### 2.2 Acceptance — L4 helpers (D6 matrix)

| auth source                                                | scenario                                            | mode  | expected |
|------------------------------------------------------------|-----------------------------------------------------|-------|----------|
| legacy_admin_key, target = effectiveBrainForLegacyAdmin    | check                                               | any   | ALLOW |
| legacy_admin_key, target ≠ effectiveBrainForLegacyAdmin    | check                                               | any   | DENY |
| service_key, is_admin, brain in household                  | check                                               | any   | ALLOW |
| service_key, is_admin, brain in OTHER household            | check                                               | any   | DENY |
| service_key, brain-bound, target == key.brain_id           | check                                               | any   | ALLOW |
| service_key, brain-bound, target ≠ key.brain_id            | check                                               | any   | DENY |
| service_key, non-brain-bound, no membership                | check                                               | any   | DENY |
| service_key, non-brain-bound, brain-allow role='member'    | check                                               | read  | ALLOW |
| service_key, non-brain-bound, brain-allow role='member'    | check                                               | write | ALLOW |
| service_key, non-brain-bound, brain-allow role='member'    | check                                               | edit  | DENY |
| service_key, non-brain-bound, brain-allow role='editor'    | check                                               | edit  | ALLOW |
| service_key, non-brain-bound, brain-allow role='owner'     | check                                               | edit  | ALLOW |
| service_key, non-brain-bound, estate-member                | check                                               | read  | ALLOW |
| service_key, non-brain-bound, estate-member                | check                                               | write | DENY (D12) |
| service_key, non-brain-bound, estate-member                | check                                               | edit  | DENY |
| service_key, non-brain-bound, estate-admin                 | check                                               | read  | ALLOW |
| service_key, non-brain-bound, estate-admin                 | check                                               | write | ALLOW |
| service_key, non-brain-bound, estate-admin                 | check                                               | edit  | ALLOW |
| service_key, non-brain-bound, estate-allow + brain-deny    | check                                               | any   | DENY |
| human_token, brain-allow                                   | check                                               | read  | ALLOW |
| human_token, no membership                                 | check                                               | any   | DENY |

#### 2.3 Acceptance — `/admin/thought/access-check` (per D8 split)

| input                                                                       | expected |
|-----------------------------------------------------------------------------|----------|
| `?target_brain=<slug-in-lookup-scope, accessible>`                          | 200 |
| `?target_brain=<slug-in-lookup-scope, NOT accessible (deny)>`               | 403 |
| `?target_brain=<slug-not-in-lookup-scope>`                                  | 404 |
| `?target_brain=<UUID-of-accessible-brain>`                                  | 200 |
| `?target_brain=<UUID-of-existing-but-inaccessible-brain>`                   | 403 |
| `?target_brain=<UUID-not-in-brains>`                                        | 404 |
| no `?target_brain=`                                                         | 400 |
| no auth                                                                     | 401 |

### Phase 3 — Tool & HTTP surfaces

#### 3.0 Plumbing checklist (verified against current `master`)

**Schema additions** (every row says NO `brain` field today,
verified by reading `server.mjs:29,41,50,55,66,92`):

| schema target                  | location          | required change |
|--------------------------------|-------------------|------------------|
| `captureThoughtSchema`         | `server.mjs:29`   | add optional `brain: z.string()` |
| `searchThoughtsSchema`         | `server.mjs:41`   | add optional `brain` |
| `listThoughtsSchema`           | `server.mjs:50`   | add optional `brain` |
| `askBrainSchema`               | `server.mjs:55`   | add optional `brain` |
| `updateThoughtMetadataSchema`  | `server.mjs:66`   | add optional `brain` (structured columns from `b8ef895` already present; selector field is new) |
| `similarThoughtLookupSchema`   | `server.mjs:92`   | add optional `brain` |
| `stats` (no input schema today) | MCP `server.tool("stats", ...)` registration | add input schema with optional `brain` |

**Auth-context resolver changes** (per D17 + Phase 2 step 4–6):
already enumerated in Phase 2 implementation order.

**Helper additions** (per Phase 2 step 7).

**Handler-layer changes** (each runs through D19 pipeline):

| handler                                | location           | change |
|----------------------------------------|--------------------|--------|
| `handleCaptureThought`                 | `server.mjs:312`   | apply D19; mode='write' at Step 7 |
| `handleSearchThoughts`                 | `server.mjs:369`   | apply D19; mode='read'; default scope per Step 6 |
| `handleListThoughts`                   | `server.mjs:697`   | same |
| `handleAskBrain`                       | `server.mjs:450`   | apply D19; preserve `graph_assisted` admin gate |
| `handleStats`                          | `server.mjs:707`   | apply D19; output shape per D5 |
| `handleSimilarThoughtLookup`           | `server.mjs:663`   | apply D19; mode='read' |
| `updateThoughtMetadata`                | `server.mjs:566` (helper) and `server.mjs:1085` (route) | apply D19; mode='edit' (always) |

**Telemetry update:** `appendRetrievalTelemetry`
(`observability.mjs:141`) accepts `brain_scope`,
`searched_brain_ids`, `result_brain_ids` via the existing `extra`
field.

#### 3.1 Acceptance — Capture path (`capture_thought`, `/ingest/thought`)

Slug vs UUID rows split where statuses diverge (Finding 2 fix).

| auth source                                | scenario                                                            | expected |
|--------------------------------------------|---------------------------------------------------------------------|----------|
| `legacy_admin_key`                         | no body `brain`                                                     | 200, target = `effectiveBrainForLegacyAdmin` |
| `legacy_admin_key`                         | body `brain="<slug-of-other-existing-brain>"`                       | 400 (Step 5 D7a L-1 after Step 3 normalizes) |
| `legacy_admin_key`                         | body `brain="<UUID-of-other-existing-brain>"`                       | 400 (Step 5 D7a L-1) |
| `legacy_admin_key`                         | body `brain="<UUID-not-in-brains>"`                                 | 404 (Step 3 normalize fails) |
| `legacy_admin_key`                         | body `brain="<typo-slug>"` (legacy lookup is global)                | 404 (Step 3 lookup miss) |
| `legacy_admin_key`                         | body `brain="<same as effective>"` (slug or UUID)                   | 200 (Step 5 D7a L-2) |
| `service_key, is_admin`                    | no body `brain`                                                     | 200, target = principal.default_brain_id |
| `service_key, is_admin`                    | body `brain="<slug-in-household>"`                                  | 200 |
| `service_key, is_admin`                    | body `brain="<slug-in-OTHER-household>"`                            | 404 (Step 3 lookup miss; admin scope = household) |
| `service_key, is_admin`                    | body `brain="<UUID-of-existing-brain-in-OTHER-household>"`          | 403 (Step 3 normalizes; Step 7 D6 case 2 DENY) |
| `service_key, brain-bound`                 | no body `brain`                                                     | 200, target = `key.brain_id` |
| `service_key, brain-bound`                 | body `brain="<slug-of-other-brain>"`                                | 404 (Step 3; lookup scope = `[key.brain_id]`) |
| `service_key, brain-bound`                 | body `brain="<UUID-of-other-existing-brain>"`                       | 403 (Step 3 normalizes; Step 7 D6 case 3 DENY) |
| `service_key, non-brain-bound`             | no body `brain`                                                     | 200, target = principal.default_brain_id |
| `service_key, non-brain-bound`             | body `brain="<slug-of-accessible, role≥member>"`                    | 200 |
| `service_key, non-brain-bound`             | body `brain="<slug-of-deny-overridden-brain>"` (lookup hit via estate) | 403 (Step 7 mode='write' DENY) |
| `service_key, non-brain-bound`             | body `brain="<typo-slug>"`                                          | 404 |
| `service_key, non-brain-bound`             | body `brain="<UUID-of-existing-brain-with-NO-relationship>"`        | 403 (Step 3 normalizes; Step 7 mode='write' DENY) |
| `service_key, non-brain-bound`             | body `brain="<UUID-not-in-brains>"`                                 | 404 |
| `service_key, non-brain-bound, ESTATE-MEMBER ONLY` | body `brain="<slug-of-brain-in-estate>"`                            | 403 (Step 7 mode='write' DENY per D12) |
| `service_key, non-brain-bound, estate-admin` | body `brain="<slug-of-brain-in-estate>"`                            | 200 |
| `human_token`, route `POST /mcp/brains/ob1` MCP capture | tool-arg `brain="ob1"` (matches)                       | 200 (Step 4 match) |
| `human_token`, route `POST /mcp/brains/ob1` MCP capture | tool-arg `brain="agent-common"` (mismatches)           | 400 (Step 4) |
| `human_token`, route `POST /mcp` (no slug) MCP capture | tool-arg `brain="ob1"` (no route L1)                    | 400 (Step 4 D9: tool-arg-only forbidden) |
| `human_token` non-MCP HTTP `/ingest/thought` | body `brain="<slug-of-accessible-via-membership>"`                 | 200 |
| `human_token` non-MCP HTTP `/ingest/thought` | body `brain="<slug-with-no-grant-in-same-household>"`              | 404 (D8 lookup miss; supersedes `docs/17:565`) |
| `human_token` non-MCP HTTP `/ingest/thought` | body `brain="<UUID-of-existing-but-inaccessible-brain>"`            | 403 (Step 3 normalizes; Step 7 DENY) |
| `human_token` non-MCP HTTP `/ingest/thought` | body `brain="<typo-slug>"`                                         | 404 |
| `human_token` non-MCP HTTP `/ingest/thought` | no body `brain`                                                    | 200, target = principal.default_brain_id |
| `human_token` non-MCP HTTP, query `?brain=<anything>`                                | rejected at L1 (D2)                                                 | 400 |
| any                                        | route+query L1 disagree                                             | 400 (Step 1) |

#### 3.2 Acceptance — Metadata patch (`/admin/thought/metadata`)

| auth source                                | scenario                                                               | expected |
|--------------------------------------------|------------------------------------------------------------------------|----------|
| `legacy_admin_key`                         | no body `brain`                                                        | scope = `[effectiveBrainForLegacyAdmin]`; row in scope → 200; row elsewhere → 404 |
| `legacy_admin_key`                         | body `brain="<slug-of-other-brain>"` or UUID of other brain            | 400 (Step 5 D7a L-1) |
| `legacy_admin_key`                         | body `brain="<UUID-not-in-brains>"`                                    | 404 (Step 3) |
| `legacy_admin_key`                         | body `brain="<same as effective>"`                                     | as no-body row |
| `service_key, non-brain-bound`             | no body `brain`, target row in default brain                           | 200 |
| `service_key, non-brain-bound`             | no body `brain`, target row in another accessible brain               | 404 ("not in default brain; pass body `brain`") |
| `service_key, non-brain-bound, role='member' on agent-common` | body `brain="agent-common"`, target in agent-common  | 403 (Step 7 mode='edit' denies member) |
| `service_key, non-brain-bound, role='editor' on agent-common` | body `brain="agent-common"`, target in agent-common  | 200 |
| `service_key, non-brain-bound, estate-admin on agent-estate` | body `brain="agent-common"`, target in agent-common   | 200 |
| `service_key, non-brain-bound, ESTATE-MEMBER ONLY` | body `brain="<slug-of-brain-in-estate>"`                            | 403 (mode='edit' denies per D12) |
| `service_key, non-brain-bound`             | body `brain="<slug-of-typo>"`                                          | 404 |
| `service_key, non-brain-bound`             | body `brain="<UUID-of-existing-inaccessible-brain>"`                   | 403 |
| `human_token`, no body `brain`, target row in default brain                              | 200 |
| `human_token`, no body `brain`, target row in non-default brain                          | 404 (single-brain default per D9) |
| `human_token`, body `brain="agent-common"`, role='editor' on agent-common                | 200 |
| `human_token`, body `brain="agent-common"`, estate-member only                           | 403 (D12) |
| any                                        | body `brain="<UUID-of-inaccessible-brain>"`                            | 403 (Step 7) |
| any                                        | body `brain="<UUID-not-in-brains>"`                                    | 404 (Step 3) |

#### 3.3 Acceptance — `search_thoughts` (MCP)

| auth source                                | scenario                                                          | expected |
|--------------------------------------------|-------------------------------------------------------------------|----------|
| `legacy_admin_key`                         | no tool-arg                                                       | scope = `[effectiveBrainForLegacyAdmin]` |
| `legacy_admin_key`                         | tool-arg slug or UUID matching effective                          | 200 (Step 5 L-2) |
| `legacy_admin_key`                         | tool-arg slug-of-other-brain or UUID-of-other-existing-brain      | 400 (Step 5 L-1) |
| `legacy_admin_key`                         | tool-arg UUID-not-in-brains                                       | 404 (Step 3) |
| `service_key, is_admin`                    | no tool-arg                                                       | every brain in household |
| `service_key, is_admin`                    | tool-arg slug-in-household                                        | scope = `[<that>]` |
| `service_key, is_admin`                    | tool-arg slug-in-OTHER-household                                  | 404 (Step 3) |
| `service_key, is_admin`                    | tool-arg UUID-of-other-household-brain                            | 403 (Step 7 D6 case 2 DENY) |
| `service_key, brain-bound`                 | no tool-arg                                                       | `[key.brain_id]` |
| `service_key, brain-bound`                 | tool-arg slug-of-other                                            | 404 (Step 3) |
| `service_key, brain-bound`                 | tool-arg UUID-of-other-existing                                   | 403 (Step 7 D6 case 3 DENY) |
| `service_key, non-brain-bound`             | no tool-arg                                                       | `listAccessibleBrainIds({mode:'read'})` |
| `service_key, non-brain-bound`             | tool-arg slug-of-accessible                                       | scope = `[<that>]` |
| `service_key, non-brain-bound`             | tool-arg slug-of-deny-overridden                                  | 403 (Step 7 mode='read' DENY) |
| `service_key, non-brain-bound`             | tool-arg slug-typo                                                | 404 |
| `service_key, non-brain-bound`             | tool-arg UUID-of-no-relationship-brain                            | 403 (Step 7) |
| `service_key, non-brain-bound`             | tool-arg UUID-not-in-brains                                       | 404 |
| `human_token`, route `POST /mcp/brains/ob1`| no tool-arg                                                       | `[ob1]` |
| `human_token`, route `POST /mcp/brains/ob1`| tool-arg `brain="ob1"`                                            | scope = `[ob1]` |
| `human_token`, route `POST /mcp/brains/ob1`| tool-arg `brain="agent-common"` (mismatch)                        | 400 (Step 4) |
| `human_token`, route `POST /mcp` (no slug) | tool-arg `brain="ob1"` (no route L1)                              | 400 (Step 4 D9) |
| `human_token`, route `POST /mcp` (no slug) | no tool-arg                                                       | `[principal.default_brain_id]` |

#### 3.4 Acceptance — `list_thoughts` (MCP)

Identical row structure to §3.3. Substitute "list" for "search."
Multi-brain results tagged with `brain_id`/`brain_slug`.

#### 3.5 Acceptance — `ask_brain` (MCP)

Identical row structure to §3.3, plus:
- `graph_assisted=true` AND not admin → 400 (existing rule).

#### 3.6 Acceptance — `stats` (MCP)

| auth source                                | scenario                                              | response shape |
|--------------------------------------------|-------------------------------------------------------|----------------|
| `legacy_admin_key`                         | no tool-arg                                           | `scope: "legacy"`, fields = today's exact shape (`overview`, `top_sources`, `top_types`, `top_people`, optional `graph`) plus `scope` field |
| `service_key, is_admin`                    | no tool-arg, multi-brain household                    | `scope: "multi"` with `brains[]` |
| `service_key, is_admin`                    | no tool-arg, single-brain household                   | `scope: "single"` |
| `service_key, brain-bound`                 | no tool-arg                                           | `scope: "single"`, fields = today's shape + `brain_id`/`brain_slug` |
| `service_key, non-brain-bound`             | no tool-arg, multi-accessible                         | `scope: "multi"` with `brains[]` |
| `service_key, non-brain-bound`             | no tool-arg, single-accessible                        | `scope: "single"` |
| `service_key, non-brain-bound`             | tool-arg slug-of-accessible                           | `scope: "single"` for that brain |
| `human_token`, route `POST /mcp/brains/ob1`| no tool-arg                                           | `scope: "single"` for `[ob1]` |
| `human_token`, route `POST /mcp/brains/ob1`| tool-arg mismatch                                    | 400 (Step 4) |
| any                                        | tool-arg slug-typo                                    | 404 |
| any                                        | tool-arg UUID-not-in-brains                           | 404 |
| any                                        | tool-arg UUID-of-existing-inaccessible-brain          | 403 |

#### 3.7 Acceptance — `/ask` (non-MCP HTTP)

| auth source                                | scenario                                                       | expected |
|--------------------------------------------|----------------------------------------------------------------|----------|
| `legacy_admin_key`                         | no body `brain`                                                | `[effectiveBrainForLegacyAdmin]` |
| `legacy_admin_key`                         | body `brain` matches effective                                 | 200 (L-2) |
| `legacy_admin_key`                         | body `brain` mismatches effective (slug or UUID of other)      | 400 (L-1) |
| `legacy_admin_key`                         | body `brain` UUID-not-in-brains                                | 404 |
| `service_key, non-brain-bound`             | no body `brain`                                                | `listAccessibleBrainIds({mode:'read'})` |
| `service_key, non-brain-bound`             | body `brain="<slug-of-accessible>"`                            | 200 |
| `service_key, non-brain-bound`             | body `brain="<slug-typo>"`                                     | 404 |
| `service_key, non-brain-bound`             | body `brain="<UUID-of-existing-inaccessible>"`                 | 403 |
| `service_key, non-brain-bound`             | body `brain="<UUID-not-in-brains>"`                            | 404 |
| `human_token`                              | no body `brain`                                                | `[principal.default_brain_id]` |
| `human_token`                              | body `brain="<slug-accessible>"`                               | 200 |
| `human_token`                              | body `brain="<slug-typo>"`                                     | 404 |
| `human_token`                              | body `brain="<UUID-of-inaccessible>"`                          | 403 |
| `human_token`                              | body `brain="<UUID-not-in-brains>"`                            | 404 |
| `human_token`                              | with `?brain=<anything>` query                                  | 400 (D2) |

#### 3.8 Acceptance — `/admin/thought/similar` (non-MCP HTTP)

Same row set as §3.7 (different operation, identical
selector/access semantics).

#### 3.9 Acceptance — `/admin/thought/access-check`

(Inlined in §2.3.)

### Phase 4 — Provisioning CLI

`scripts/agent_estate/provision.py`:
- `provision-estate-and-common`
- `provision-repo --slug <slug>` (mints non-brain-bound, non-admin
  service key; refuses `is_admin=true` without `--allow-admin`)
- `provision-operator-membership` (mints operator stored key for
  `luchoh` plus `estate_memberships(luchoh, agent-estate,
  role='admin')`)
- `rotate-key --slug <slug>`

**Acceptance:**
- ☐ Re-runs idempotent.
- ☐ Repo principal validates against the non-brain-bound multi-
  membership matrix (Phase 2 §2.1 / 2.2 rows).
- ☐ Operator stored key + estate-admin grant cross-estate read on
  every agent brain.
- ☐ Repo principal does NOT have `estate_memberships` row in the
  agent estate (per ADR-0001 visibility model).

### Phase 5 — Per-repo `.envrc`

In each onboarded repo: `.envrc` exports
`MCP_ACCESS_KEY=<repo-principal stored key>` and
`OPEN_BRAIN_BASE_URL=http://127.0.0.1:8788`. Operator's home env
exports `OB1_OPERATOR_ACCESS_KEY=<operator stored key>` separately.
Infrastructure environments export `OB1_LEGACY_ADMIN_KEY` only when
needed.

### Phase 6 — Routing skill

`skills/agent-brain-routing/SKILL.md` per v6 §Phase 5. Deployed
via system-config Nix per the live-retrieval pattern (doc 26).

### Phase 7 — Migrate writers

`scripts/thought_enrichment/*` and other operator scripts:
- Read `OB1_OPERATOR_ACCESS_KEY` (NOT `MCP_ACCESS_KEY`).
- Startup preflight: `GET /admin/thought/access-check?target_brain=<UUID>`.
- Patches send body `brain=<UUID>` on every call.

Smoke harness: legacy-admin only, reads `OB1_LEGACY_ADMIN_KEY`.

### Phase 8 — Legacy-admin layer hygiene

Per D14: `config.accessKey` is the choke point. Phase 8 audits
in-repo `MCP_ACCESS_KEY` callers for legacy-admin reliance, documents
that bridge wrapper migration is a system-config follow-up, and
constrains future provisioning per D11.

## Risks and mitigations

- Pipeline order written once in D19. Other sections reference by
  step number.
- D8 split into `normalizeBrainSelector` (no access check) vs
  `resolveBrainSlug` (lookup + access). Pipeline calls only the
  former at Step 3; access check happens at Step 7.
- Acceptance tables split slug vs UUID input shapes wherever
  statuses diverge.
- Phase 2 acceptance is fully inlined in §2.1, §2.2, §2.3.
- Plumbing-checklist done/not-done verified against current
  `master`.

## Out of scope, tracked separately

(Same as v7+: estate rename, graph multi-brain, edit/delete MCP
tools, audit log, telegram bridge wrapper migration, recurring
backup, service-key smoke harness, human-token federation.)

## Open questions

(Same as v17+.)
