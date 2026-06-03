# PRD: Agent Estate + Brain Selection — Implementation Roadmap (v18)

Date: 2026-06-03
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`,
           CONTEXT `CONTEXT.md`,
           reviews v1–v17
Supersedes: v1–v17

## Why v18

v17 was rejected on one finding plus one secondary gap, both about
the same recurring failure mode: collapsing the **selector layer**
(D2/D9 — what selector sources are admissible per auth-source per
route) into the **access layer** (D8/D18/D19 — what happens once a
selector resolves).

Specifically:

1. **D19's "explicit `brain` always wins" sentence collided with
   D9.** D9 says human-token MCP selection is route-only and that
   tool-arg `brain` either mirrors the route or is a 400. v17 D19
   said explicit body/tool-arg `brain` resolves to 200/403/404 for
   "any" caller, including human-token MCP. The two contracts
   change the failure class for the same request — selector error
   (400) vs auth/lookup result (403/404).
2. **Phase 3 read-handler rows were named for `search_thoughts`,
   `/ask`, `stats` only.** `list_thoughts`, `ask_brain` MCP, and
   `/admin/thought/similar` rode on "identical rules" prose. Same
   "patch one tool's tests, claim the rest by induction" pattern
   that has been failing every round.

v18 fixes both:

- **D19 explicitly subordinates explicit-`brain` resolution to D2
  and D9.** It applies to read tools **only after** the selector
  layer has admitted the selector source for the current auth
  source and route. For human-token MCP, explicit `brain` is still
  governed by D9 (must match route, mismatch or tool-arg-only is
  400). For human-token non-MCP HTTP, body `brain` is still the
  admitted selector and resolves via D8 → D6 mode='read'.
- **Phase 3 splits read acceptance by route family** (MCP vs non-MCP
  HTTP), with concrete rows per tool. No "identical to" prose.

## Vocabulary recap (unchanged)

## Layering model (unchanged)

## Goals (unchanged)

## Non-goals (unchanged)

## Design decisions

### D1. Estate membership is allow-only (unchanged)

### D2. Selector model — per-auth-source AND per-route admissibility (unchanged from v7)

The L1/L3 admissibility tables remain authoritative:
- L1 admissibility per auth source: human-token MCP rejects
  query/header (route-only); service-key admits route/query/header;
  legacy-admin admits route/query/header.
- L3 admissibility per route: MCP tools admit tool-arg `brain` for
  service-key/legacy-admin freely; for human-token MCP, tool-arg
  must match route or is 400.
- Non-MCP HTTP routes admit body `brain` as the selector for all
  auth sources (for human-token, this is the only mechanism since
  the route doesn't carry a slug).

### D3–D18 (unchanged)

### D19. Default retrieval scope — auth-source split, governed by D2/D9 selector layer (refined for Finding 1)

The auth-source split for default read scope from v17 stays. The
explicit-`brain` rule is **subordinated to the selector layer
(D2/D9)**, not stated as universal.

#### Default read scope when no `brain` argument is provided (unchanged from v17)

| auth source                                | default read scope                              | Canonical doc        |
|--------------------------------------------|-------------------------------------------------|----------------------|
| `legacy_admin_key`                         | `[effectiveBrainForLegacyAdmin]`                | D6 case 1            |
| `service_key, is_admin`                    | every brain in `accessContext.householdId`      | ADR-0001 point 11    |
| `service_key, brain-bound`                 | `[key.brain_id]`                                | D6 case 3            |
| `service_key, non-brain-bound, non-admin`  | `listAccessibleBrainIds({mode: 'read'})`        | ADR-0001 point 11    |
| `human_token`                              | `[requestBrain ?? principal.default_brain_id]`  | `docs/17:556 + 744`  |

Tools affected: `search_thoughts`, `list_thoughts`, `ask_brain`,
`/ask`, `/admin/thought/similar`, `stats`.

#### Explicit `brain` argument — subordinated to D2/D9

When the caller provides an explicit `brain`, the selector layer
(D2/D9) decides admissibility BEFORE D19 does anything. Layered
rule:

1. **D2/D9 first** — is this selector source admissible for this
   auth source on this route?
   - L1 disagreement (route + query/header) → 400.
   - Human-token MCP with tool-arg `brain` mismatching route → 400.
   - Human-token MCP with tool-arg `brain` and no route brain → 400.
   - Human-token MCP with tool-arg `brain` matching route → admitted.
   - Human-token non-MCP HTTP with body `brain` → admitted (no
     route L1 available, body is the selector).
   - Service-key with explicit `brain` (any L1 or L3 source) →
     admitted (per D2 admissibility table).
2. **D8 next** — resolve slug or UUID → 200/403/404/409 per the
   two-step lookup-then-access rule.
3. **D6 last** — L4 access check at the requested mode (read/write/
   edit). Result → ALLOW or 403.

D19 governs only the **default scope** when no selector is provided.
Explicit selectors flow through the layers above D19. Step 1 (D2/D9)
can produce 400 before D19 is consulted at all. Step 2 (D8) can
produce 404/409. Step 3 (D6) can produce 403. D19 itself never
returns those statuses for explicit-`brain` requests; it only
defines the no-selector fallback.

This closes Finding 1: human-token MCP `search_thoughts` with body
`brain` and no route brain is rejected by D9 at 400, never reaches
D8 or D6, and is not subject to D19's "default scope" reasoning at
all.

#### Where the auth-source split applies (sharpened)

The default-scope table applies to:
- MCP read tools when no tool-arg `brain` is set.
- Non-MCP HTTP read routes when no body `brain` is set.

When ANY selector is set:
- For human-token MCP, D9 governs selector admissibility.
- For human-token non-MCP HTTP, D8 + D6 mode='read' govern (no
  selector restriction beyond D2/D9; body `brain` is the only
  mechanism).
- For service-key (any sub-branch), D8 + D6 mode='read' govern.
- For legacy-admin, D6 case 1 governs (single-brain only;
  body/tool-arg `brain` ignored, see D7).

### D20. (renumbered from v17 D20) — none

(No new normative decisions in v18 beyond the D19 refinement.)

## Phasing

### Phase 1 — Schema (unchanged)

### Phase 2 — Auth context + helpers (unchanged from v15)

### Phase 3 — Tool & HTTP surfaces (Finding 1 + Secondary 1 fix)

Handler-layer changes. Acceptance is now split by **route family**
(MCP vs non-MCP HTTP) with concrete rows per tool.

#### Capture path (unchanged from v17)

#### Metadata patch (unchanged from v17)

#### Read path — split by route family

##### MCP read tools: `search_thoughts`, `list_thoughts`, `ask_brain`, `stats`

These admit tool-arg `brain` per D2 (service-key freely; human-token
must match route or 400 per D9; legacy-admin admits but is governed
by D6 case 1).

**`search_thoughts` (MCP) acceptance:**

| auth source                                | scenario                                                          | expected |
|--------------------------------------------|-------------------------------------------------------------------|----------|
| `legacy_admin_key`                         | no tool-arg `brain`                                               | scope = `[effectiveBrainForLegacyAdmin]` |
| `legacy_admin_key`                         | tool-arg `brain="<other>"` (mismatch with effective)              | 400 (D6 case 1 effectively, surfaced as a single-brain mismatch) |
| `service_key, is_admin`                    | no tool-arg `brain`                                               | scope = every brain in household |
| `service_key, is_admin`                    | tool-arg `brain="<in-household>"`                                 | 200, scope = `[<that brain>]` |
| `service_key, is_admin`                    | tool-arg `brain="<in-OTHER-household>"`                           | 404 (D8 lookup miss) |
| `service_key, brain-bound`                 | no tool-arg `brain`                                               | scope = `[key.brain_id]` |
| `service_key, brain-bound`                 | tool-arg `brain="<other>"`                                        | 404 (D8 lookup miss; lookup scope = `[key.brain_id]`) |
| `service_key, non-brain-bound`             | no tool-arg `brain`                                               | scope = `listAccessibleBrainIds({mode:'read'})` (multi-brain) |
| `service_key, non-brain-bound`             | tool-arg `brain="<accessible>"`                                   | 200, scope = `[<that brain>]` |
| `service_key, non-brain-bound`             | tool-arg `brain="<inaccessible-via-deny>"`                        | 403 (D8 lookup hit, D6 case 4 deny) |
| `service_key, non-brain-bound`             | tool-arg `brain="<typo>"`                                         | 404 (D8 lookup miss) |
| `human_token`, route `POST /mcp/brains/ob1`| no tool-arg `brain`                                               | scope = `[ob1]` (D9 single-brain) |
| `human_token`, route `POST /mcp/brains/ob1`| tool-arg `brain="ob1"` (matches route)                            | 200, scope = `[ob1]` |
| **`human_token`, route `POST /mcp/brains/ob1`** | **tool-arg `brain="agent-common"` (mismatches route)** (Finding 1) | **400 (D9 mismatch)** |
| **`human_token`, route `POST /mcp` (no slug)** | **tool-arg `brain="ob1"` (no route L1)** (Finding 1)            | **400 (D9: tool-arg-only forbidden for human-token MCP)** |
| `human_token`, route `POST /mcp` (no slug) | no tool-arg `brain`                                               | scope = `[principal.default_brain_id]` (D19) |

**`list_thoughts` (MCP) acceptance:**

| auth source                                | scenario                                                          | expected |
|--------------------------------------------|-------------------------------------------------------------------|----------|
| `service_key, non-brain-bound`             | no tool-arg `brain`                                               | scope = `listAccessibleBrainIds({mode:'read'})` (multi); rows tagged `brain_id`/`brain_slug` |
| `service_key, non-brain-bound`             | tool-arg `brain="<accessible>"`                                   | 200, scope = `[<that brain>]`; rows still tagged |
| `service_key, brain-bound`                 | no tool-arg `brain`                                               | scope = `[key.brain_id]` |
| `human_token`, route `POST /mcp/brains/ob1`| no tool-arg `brain`                                               | scope = `[ob1]`; D9 single-brain |
| `human_token`, route `POST /mcp/brains/ob1`| tool-arg `brain="agent-common"` (mismatch)                        | 400 (D9) |
| `human_token`, route `POST /mcp` (no slug) | tool-arg `brain="ob1"` (no route L1)                              | 400 (D9) |
| any                                        | tool-arg `brain="<typo>"`                                         | 404 (D8) |
| any                                        | tool-arg `brain="<inaccessible>"`                                 | 403 (D6 mode='read') |

**`ask_brain` (MCP) acceptance:**

| auth source                                | scenario                                                          | expected |
|--------------------------------------------|-------------------------------------------------------------------|----------|
| `service_key, non-brain-bound`             | no tool-arg `brain`                                               | scope = `listAccessibleBrainIds({mode:'read'})` |
| `service_key, non-brain-bound`             | tool-arg `brain="<accessible>"`                                   | 200, scope = `[<that brain>]` |
| `service_key, brain-bound`                 | no tool-arg `brain`                                               | scope = `[key.brain_id]` |
| `service_key, is_admin`                    | no tool-arg `brain`                                               | scope = every brain in household |
| `human_token`, route `POST /mcp/brains/ob1`| no tool-arg `brain`                                               | scope = `[ob1]` |
| `human_token`, route `POST /mcp/brains/ob1`| tool-arg `brain="agent-common"` (mismatch)                        | 400 |
| `human_token`, route `POST /mcp` (no slug) | tool-arg `brain="ob1"` (no route L1)                              | 400 |
| any                                        | tool-arg `brain="<typo>"`                                         | 404 |
| any                                        | tool-arg `brain="<inaccessible>"`                                 | 403 |
| any                                        | `graph_assisted=true` AND not admin                               | 400 (existing `handleAskBrain` rule, preserved) |

**`stats` (MCP) acceptance:**

| auth source                                | scenario                                                          | expected |
|--------------------------------------------|-------------------------------------------------------------------|----------|
| `legacy_admin_key`                         | no tool-arg `brain`                                               | `scope: "legacy"`, today's exact field shape preserved + `scope` field |
| `service_key, is_admin`                    | no tool-arg `brain`                                               | `scope: "multi"` (if >1 brain in household) with `brains[]`, OR `scope: "single"` if exactly one |
| `service_key, brain-bound`                 | no tool-arg `brain`                                               | `scope: "single"`, fields = today's shape + `brain_id`/`brain_slug` |
| `service_key, non-brain-bound`             | no tool-arg `brain`, multi-accessible                             | `scope: "multi"` with `brains[]` |
| `service_key, non-brain-bound`             | no tool-arg `brain`, single-accessible                            | `scope: "single"` |
| `service_key, non-brain-bound`             | tool-arg `brain="<accessible>"`                                   | `scope: "single"` for that one brain |
| `human_token`, route `POST /mcp/brains/ob1`| no tool-arg `brain`                                               | `scope: "single"` for `[ob1]` |
| `human_token`, route `POST /mcp/brains/ob1`| tool-arg `brain="agent-common"` (mismatch)                        | 400 |
| any                                        | tool-arg `brain="<typo>"`                                         | 404 |

##### Non-MCP HTTP read routes: `/ask`, `/admin/thought/similar`

These do not have a route slug. L1 selectors for human-token are
forbidden per D2 (no query/header). Body `brain` is the only
selector for human-token. For service-key, query/header L1 IS
admitted; body `brain` also admitted at L3.

**`/ask` acceptance:**

| auth source                                | scenario                                                          | expected |
|--------------------------------------------|-------------------------------------------------------------------|----------|
| `legacy_admin_key`                         | no body `brain`                                                   | scope = `[effectiveBrainForLegacyAdmin]` |
| `legacy_admin_key`                         | body `brain="<other>"` (mismatch with effective)                  | 400 (D7 legacy sub-rule) |
| `service_key, non-brain-bound`             | no body `brain`                                                   | scope = `listAccessibleBrainIds({mode:'read'})` |
| `service_key, non-brain-bound`             | body `brain="<accessible>"`                                       | 200, scope = `[<that>]` |
| `service_key, non-brain-bound`             | body `brain="<inaccessible>"`                                     | 403 |
| `service_key, non-brain-bound`             | body `brain="<typo>"`                                             | 404 |
| **`human_token`, no body `brain`** (Finding 1)                                  | scope = `[principal.default_brain_id]` (D19, `docs/17:744`)      | **single-brain default; never multi-brain** |
| `human_token`, body `brain="<accessible-via-membership>"`                       | 200, scope = `[<that>]`                                          | |
| `human_token`, body `brain="<inaccessible>"`                                    | 403                                                              | |
| `human_token`, body `brain="<typo>"`                                            | 404                                                              | |
| `human_token`, with `?brain=<anything>` query string (forbidden L1 for human-token) | 400 (D2 admissibility)                                       | |

**`/admin/thought/similar` acceptance:** identical structure to
`/ask`. Concrete rows mirroring the `/ask` table apply.

#### Capture path — Human-token non-MCP HTTP (unchanged from v17)

#### Metadata patch — Human-token non-MCP HTTP (unchanged from v17)

### Phase 4 — Provisioning CLI (unchanged)

### Phase 5 — Per-repo `.envrc` (unchanged)

### Phase 6 — Routing skill (unchanged)

### Phase 7 — Migrate writers (unchanged)

### Phase 8 — Legacy-admin layer hygiene (unchanged)

## Risks and mitigations

(Unchanged from v17, plus:)

- **Selector layer (D2/D9) and access/scope layer (D8/D18/D19) must
  remain separate.** Mitigation: D19 v18 explicitly subordinates
  explicit-`brain` resolution to D2/D9, naming the layer order
  (selector → D8 → D6 → D19 only governs default scope). Phase 3
  acceptance has explicit human-token MCP rows for tool-arg `brain`
  mismatch and tool-arg-only that return 400, distinguishing the
  selector-error class from the auth/lookup classes.
- **Read-handler acceptance is per-tool, not "identical to."**
  Mitigation: Phase 3 has concrete rows for every named read tool
  (`search_thoughts`, `list_thoughts`, `ask_brain`, `stats` for
  MCP; `/ask`, `/admin/thought/similar` for non-MCP HTTP).
  Implementer cannot ride on prose induction.

## Out of scope, tracked separately (unchanged)

## Open questions (unchanged from v17)
