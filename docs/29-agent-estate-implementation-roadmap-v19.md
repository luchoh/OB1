# PRD: Agent Estate + Brain Selection — Implementation Roadmap (v19)

Date: 2026-06-03
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`,
           CONTEXT `CONTEXT.md`,
           reviews v1–v18
Supersedes: v1–v18

## Why v19

v18 was rejected on one finding plus two secondary gaps:

1. **Legacy-admin's selector contract was described three times
   inconsistently** — D2 said "admits tool-arg `brain` freely on
   MCP," D19 said "explicit `brain` is ignored when set," Phase 3
   acceptance said "mismatch returns 400." Three sections, three
   rules.
2. **Phase 3 plumbing tasks were assumed but not named.** MCP tool
   schemas don't currently have a `brain` field; the resolver only
   consumes route/query/header; handlers only consume
   `effectiveBrainId`. The acceptance matrix assumed all of that
   plumbing existed.
3. **`/admin/thought/similar` rode on "identical to `/ask`" prose**
   after v18 claimed that shortcut was gone. Same habit, smaller
   blast radius.

The recurring failure mode across rounds is **not** that the design
is wrong. It's that **the same rule is repeated in multiple
sections with subtle drift**. v19 fixes this structurally:

- One canonical place per topic. Other sections **reference** that
  topic by D-number instead of restating its rule.
- Legacy-admin selector contract is defined once (D7a, new in v19)
  and referenced everywhere else.
- Phase 3 has an explicit plumbing checklist naming every file/
  function that must change for the contract to be reachable.
- `/admin/thought/similar` gets its own concrete rows, no shortcut.

## Vocabulary recap (unchanged)

## Layering model (unchanged)

## Goals (unchanged)

## Non-goals (unchanged)

## Design decisions

### D1. Estate membership is allow-only (unchanged)

### D2. Selector model — per-auth-source AND per-route admissibility (unchanged for non-legacy; legacy-admin moved to D7a)

(D2 retains the per-auth-source admissibility table for human-token
and service-key. The legacy-admin row is removed from this table
and replaced with a pointer: "see D7a for the canonical legacy-
admin selector contract.")

### D3. Operator path (unchanged)

### D4. Phase scope (unchanged)

### D5. `stats` response shape (unchanged)

### D6. Access-check helper — three modes, single-brain legacy admin (unchanged; references D7a for selector behavior)

### D7. Omitted-`brain` write defaults align with ADR-0001; L4 runs on every write (unchanged for non-legacy; legacy-admin behavior moved to D7a)

### D7a. Legacy-admin selector contract — one canonical place (Finding 1 fix; new in v19)

This section is **the only place** the roadmap specifies how
legacy-admin handles the `brain` selector. Other sections
reference D7a instead of restating its rule. If you need to know
how `legacy_admin_key` treats route/query/header L1, body `brain`,
or tool-arg `brain` on any route, this is where it's defined.

#### Effective brain for legacy-admin

`effectiveBrainForLegacyAdmin(accessContext)` is:

- The L1-resolved brain (route slug, query, or header) if any L1
  selector is present and admissible.
- Otherwise `resolveDefaultAdminBrain()` (today's
  `auth.mjs:336-364` behavior).

This is the **only** brain a legacy-admin request operates on.
Single-brain by definition.

#### L1 admissibility for legacy-admin

Route, query, and header L1 selectors are all admissible
(unchanged from D2). At most one may be present per request; two
present and disagreeing → 400 (D2 rule, applies to all auth
sources).

#### Body / tool-arg `brain` for legacy-admin

There are exactly two rules across all routes:

**Rule L-1: If body / tool-arg `brain` is set AND it does NOT
match `effectiveBrainForLegacyAdmin`, the request returns 400.**
The body/tool-arg field is **not a real selector** for legacy-admin
— it can only mirror the L1-resolved (or default) brain. Mismatch
= malformed request, 400.

**Rule L-2: If body / tool-arg `brain` is set AND it matches
`effectiveBrainForLegacyAdmin`, it's accepted as a redundant
confirmation; the request proceeds against the same single brain.**

If body / tool-arg `brain` is unset, the request operates on
`effectiveBrainForLegacyAdmin` directly.

Both rules apply uniformly to:
- MCP tools: `capture_thought`, `search_thoughts`, `list_thoughts`,
  `ask_brain`, `stats`.
- Non-MCP HTTP: `/ingest/thought`, `/ask`, `/admin/thought/similar`,
  `/admin/thought/metadata`.

Read defaults: scope = `[effectiveBrainForLegacyAdmin]`. Single-
brain, never multi-brain.

Write defaults: target = `effectiveBrainForLegacyAdmin`. Single-
brain.

L4 access check: D6 case 1 (allow iff brainId ==
`effectiveBrainForLegacyAdmin`).

#### What this consolidates

- D2's "legacy-admin admits tool-arg `brain`" → narrowed: the
  field is admitted as INPUT, but per L-1 it must match
  `effectiveBrainForLegacyAdmin` or 400. It's not a "real" selector
  in the sense that it could pick a different brain from L1.
- D7's "legacy-admin metadata patch: body `brain` must match
  effective" → generalized to all routes via L-1.
- D19's "explicit `brain` is ignored when set" (v18 wording) →
  superseded by L-1 (mismatch is 400, not silent ignore) and L-2
  (match is accepted, not ignored).
- Phase 3 acceptance "mismatch returns 400" → derived from L-1.

The legacy-admin column in every Phase 3 acceptance table
**references D7a rules L-1 and L-2** instead of restating its
own version.

### D8. Slug-vs-UUID resolution (unchanged)

### D9. Human-token request-scoped binding (unchanged)

### D10. Env split (unchanged)

### D11. Stored `is_admin` provisioning policy (unchanged)

### D12. Estate-membership `role='member'` is read-only (unchanged)

### D13. Smoke harness contract (unchanged)

### D14. Legacy-admin layer hygiene (unchanged)

### D15. `/admin/thought/access-check` query param `target_brain` (unchanged)

### D16. No estate-rename in this work (unchanged)

### D17. Auth-context resolution becomes estate-aware (unchanged)

### D18. Visibility-via-explicit-grants; lookup ⊇ access; D18 governs slug-resolution and read-visibility only (unchanged)

### D19. Default retrieval scope — auth-source split, governed by D2/D9 selector layer; legacy-admin per D7a (unchanged from v18 except legacy-admin row references D7a)

The default-scope table from v18 stays. The legacy-admin row
**references D7a** instead of restating its single-brain rule.

| auth source                                | default read scope                              | Canonical doc          |
|--------------------------------------------|-------------------------------------------------|------------------------|
| `legacy_admin_key`                         | per D7a                                         | D7a (this PRD)         |
| `service_key, is_admin`                    | every brain in `accessContext.householdId`      | ADR-0001 point 11      |
| `service_key, brain-bound`                 | `[key.brain_id]`                                | D6 case 3              |
| `service_key, non-brain-bound, non-admin`  | `listAccessibleBrainIds({mode: 'read'})`        | ADR-0001 point 11      |
| `human_token`                              | `[requestBrain ?? principal.default_brain_id]`  | `docs/17:556 + 744`    |

Tools affected: `search_thoughts`, `list_thoughts`, `ask_brain`,
`/ask`, `/admin/thought/similar`, `stats`.

Explicit `brain` argument is governed by:
- D2/D9 first (selector admissibility).
- D7a if legacy-admin (Rules L-1 and L-2).
- D8 next (slug/UUID resolution).
- D6 last (L4 access check at the requested mode).

D19 itself only governs default scope when no selector is
provided, modulo D7a for legacy-admin.

## Phasing

### Phase 1 — Schema (unchanged)

### Phase 2 — Auth context + helpers (unchanged from v15)

### Phase 3 — Tool & HTTP surfaces (Secondary 1 fix: explicit plumbing list)

This phase has TWO parts in v19: a plumbing checklist and an
acceptance matrix. The plumbing list names every code change
required for the acceptance to be reachable, addressing Codex's
secondary 1 finding.

#### Plumbing checklist (NEW in v19)

**Schema additions** (extend MCP tool / HTTP body schemas to admit
the `brain` field):

| schema target                                        | location                        | change |
|------------------------------------------------------|---------------------------------|--------|
| `captureThoughtSchema`                               | `server.mjs:29`                 | already done in commit `b8ef895` (extends admin endpoint); confirm includes `brain` body field for non-MCP HTTP capture |
| `searchThoughtsSchema`                               | `server.mjs:41`                 | add optional `brain: z.string().optional()` (slug or UUID) |
| `listThoughtsSchema`                                 | `server.mjs:50`                 | same |
| `askBrainSchema`                                     | `server.mjs:55`                 | same |
| `updateThoughtMetadataSchema`                        | `server.mjs:66`                 | already extended in `b8ef895`; confirm `brain` body field is present and validated |
| `similarThoughtLookupSchema`                         | `server.mjs:92`                 | add optional `brain` field |
| `stats` (no schema today)                            | `server.mjs` (`server.tool("stats", ...)`) | add input schema with optional `brain` field |

**Auth-context resolver changes** (already named in D17):

| target                                  | location                  | change |
|-----------------------------------------|---------------------------|--------|
| `loadPrincipalMemberships`              | `auth.mjs:65`             | rename to `loadPrincipalAccess`; return both `brainMemberships` and `estateMemberships` arrays |
| `resolveStoredAccessKeyContext`         | `auth.mjs:241-317`        | slug lookup over `lookupScope(P)` per D8; populate new arrays on `accessContext` |
| `resolveHumanAccessContext`             | `auth.mjs:159-225`        | same: slug lookup over `lookupScope(P)`; populate arrays |
| `resolveAccessContext`                  | `auth.mjs:367`            | detect simultaneous L1 sources → 400; reject query/header for human-token at L1 |

**Helper additions:**

| helper                                          | new location                  |
|-------------------------------------------------|-------------------------------|
| `checkBrainAccess({accessContext, brainId, mode})` | `auth.mjs` or new `access.mjs` |
| `listAccessibleBrainIds({accessContext, mode})` | same |
| `resolveBrainSlug({accessContext, slug})`       | same |
| `resolveBrainUuid({accessContext, brainId})`    | same |
| `effectiveBrainForLegacyAdmin(accessContext)`   | same |
| `GET /admin/thought/access-check` route         | `server.mjs` after existing admin routes |

**Handler-layer changes** (each handler must escape the
single-`effectiveBrainId` model):

| handler                                | location           | change |
|----------------------------------------|--------------------|--------|
| `handleCaptureThought`                 | `server.mjs:312`   | parse args.brain → resolve via D8 → L4 mode='write' → write. Default brain per D7. Apply D7a rules for legacy-admin. |
| `handleSearchThoughts`                 | `server.mjs:369`   | parse args.brain → resolve → L4 mode='read' → fan out per scope. Default scope per D19. Apply D7a for legacy-admin. |
| `handleListThoughts`                   | `server.mjs:697`   | same shape as `handleSearchThoughts`. |
| `handleAskBrain`                       | `server.mjs:450`   | parse args.brain → resolve → L4 mode='read' → fan out. Default scope per D19. Preserve `graph_assisted` admin gate. Apply D7a for legacy-admin. |
| `handleStats`                          | `server.mjs:707`   | parse args.brain → resolve → fan out per scope. Output shape per D5. Apply D7a for legacy-admin. |
| `handleSimilarThoughtLookup`           | `server.mjs:663`   | parse body.brain → resolve → L4 mode='read'. Default scope per D19. Apply D7a for legacy-admin. |
| `updateThoughtMetadata` (called from `/admin/thought/metadata`) | `server.mjs:1085` | parse body.brain → resolve → L4 mode='edit' (always) → SQL update. Apply D7a for legacy-admin. |

**Telemetry update** (D9 from v6):

| target                                 | location                  | change |
|----------------------------------------|---------------------------|--------|
| `appendRetrievalTelemetry`             | `observability.mjs:141`   | accept `brain_scope`, `searched_brain_ids`, `result_brain_ids` via the existing `extra` field. |

This plumbing list is **the work** of Phase 3. Without all rows
checked, the acceptance matrix below is unreachable.

#### Acceptance matrix

(Tables from v18 stay. Per Codex secondary 2, the
`/admin/thought/similar` "identical to `/ask`" shortcut is
replaced with concrete rows below.)

##### Capture path (unchanged from v17)

##### Metadata patch (unchanged from v17)

##### MCP read tools

(Same tables as v18: `search_thoughts`, `list_thoughts`,
`ask_brain`, `stats`. Each has explicit human-token mismatch and
no-route rows that produce 400 per D9. Each has explicit
legacy-admin rows that **reference D7a Rules L-1 / L-2** instead
of restating them.)

**Legacy-admin column in MCP read tables (consolidated per D7a):**

| auth source         | scenario                                                    | expected | reference |
|---------------------|-------------------------------------------------------------|----------|-----------|
| `legacy_admin_key`  | no tool-arg `brain`, no L1                                  | scope = `[effectiveBrainForLegacyAdmin (default)]` | D7a |
| `legacy_admin_key`  | L1 set (route/query/header), no tool-arg `brain`            | scope = `[L1-resolved brain]` | D7a |
| `legacy_admin_key`  | tool-arg `brain` matches `effectiveBrainForLegacyAdmin`     | 200, scope unchanged | D7a Rule L-2 |
| `legacy_admin_key`  | tool-arg `brain` mismatches `effectiveBrainForLegacyAdmin`  | 400 | D7a Rule L-1 |

These four rows apply identically to `search_thoughts`,
`list_thoughts`, `ask_brain`, `stats`. Each tool's table
references "see D7a legacy-admin rows" rather than duplicating.

##### Non-MCP HTTP read routes

**`/ask` acceptance** (unchanged from v18, with legacy-admin rows
referencing D7a).

**`/admin/thought/similar` acceptance** (concrete rows, NOT
"identical to" prose; Secondary 2 fix):

| auth source                                | scenario                                                          | expected |
|--------------------------------------------|-------------------------------------------------------------------|----------|
| `legacy_admin_key`                         | no body `brain`                                                   | scope = `[effectiveBrainForLegacyAdmin]` (D7a) |
| `legacy_admin_key`                         | body `brain` matches effective                                    | 200 (D7a Rule L-2) |
| `legacy_admin_key`                         | body `brain` mismatches effective                                 | 400 (D7a Rule L-1) |
| `service_key, is_admin`                    | no body `brain`                                                   | scope = every brain in household (D19) |
| `service_key, brain-bound`                 | no body `brain`                                                   | scope = `[key.brain_id]` (D19) |
| `service_key, non-brain-bound, non-admin`  | no body `brain`                                                   | scope = `listAccessibleBrainIds({mode:'read'})` (D19) |
| `service_key, non-brain-bound, non-admin`  | body `brain="<accessible>"`                                       | 200, scope = `[<that>]` |
| `service_key, non-brain-bound, non-admin`  | body `brain="<inaccessible>"`                                     | 403 (D8 + D6 mode='read') |
| `service_key, non-brain-bound, non-admin`  | body `brain="<typo>"`                                             | 404 (D8 step 1) |
| `human_token`, no body `brain`             | scope = `[principal.default_brain_id]` (D19)                      | single-brain default |
| `human_token`, body `brain="<accessible-via-membership>"` | 200, scope = `[<that>]`                                       |          |
| `human_token`, body `brain="<inaccessible>"` | 403                                                            |          |
| `human_token`, body `brain="<typo>"`       | 404                                                               |          |
| `human_token`, with `?brain=<anything>` query string | 400 (D2: human-token rejects query/header L1)               |          |
| any                                        | route+query+header L1 disagree                                    | 400 (D2)  |

##### Capture path — Human-token non-MCP HTTP (unchanged from v17)

##### Metadata patch — Human-token non-MCP HTTP (unchanged from v17)

### Phase 4 — Provisioning CLI (unchanged)

### Phase 5 — Per-repo `.envrc` (unchanged)

### Phase 6 — Routing skill (unchanged)

### Phase 7 — Migrate writers (unchanged)

### Phase 8 — Legacy-admin layer hygiene (unchanged)

## Risks and mitigations

(Unchanged from v18, plus:)

- **One topic, one section.** Mitigation: D7a is the only place
  legacy-admin's selector contract lives. Other sections reference
  it by D-number. Future edits to legacy-admin behavior touch only
  D7a; downstream rules don't drift.
- **Phase 3 plumbing checklist names every file and function.**
  Mitigation: implementer cannot pass acceptance without the
  checklist items being green. The "all the plumbing must exist"
  assumption from prior versions is now an explicit list, not an
  implicit one.
- **No "identical to" prose in acceptance.** Mitigation:
  `/admin/thought/similar` has its own concrete table. Future
  read-tool additions get the same treatment (their own table or
  an explicit "uses D7a legacy-admin rows" reference, never silent
  inheritance).

## Out of scope, tracked separately (unchanged)

## Open questions (unchanged)
