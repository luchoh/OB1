# Agent Estate Implementation PRD (v23 — canonical, self-contained)

Date: 2026-06-03
Supersedes: v1–v22 and all `*-review-v*` rounds. This document does **not**
reference prior versions for any rule. If a rule is not stated here, it is not
in scope.
Source of truth it must obey: [ADR-0001](/Users/luchoh/Dev/OB1/docs/adr/0001-agent-estate-brain-model.md)
and the live runtime in
[auth.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/auth.mjs) /
[server.mjs](/Users/luchoh/Dev/OB1/local/open-brain-mcp/src/server.mjs).

## 0. Why this version exists

The v1–v22 loop never converged because each round patched the paragraph under
review and spawned a fresh contradiction elsewhere, while specifying behavior
against tables that do not exist. This version fixes that by three rules:

1. **Decide every seam once, in §2, and never restate a rule elsewhere.**
2. **Match the live runtime's architecture instead of inventing a parallel one.**
   The resolver denies during resolution today; we keep that. There is no
   separate late "access stage".
3. **Each normative decision carries one concrete acceptance test (§5) and one
   concrete code site (§4).** The test suite, not another review, is the gate.

## 1. Ground truth (verified against the current branch)

- **Schema today** (`migrations/005_household_multitenancy.sql`): `households`,
  `brains(household_id, slug)`, `brain_principals(household_id, slug,
  default_brain_id, principal_type)`, `brain_memberships(principal_id, brain_id,
  role)` PK`(principal_id, brain_id)`, `brain_access_keys(principal_id, brain_id
  nullable, is_admin)`, `principal_identity_bindings`. **There is no
  `estate_memberships` table and no `is_deny` column.** Both are net-new here.
- **Auth resolution** (`auth.mjs:367` `resolveAccessContext`): three branches —
  human token (`resolveHumanAccessContext:159`), stored key
  (`resolveStoredAccessKeyContext:241`), legacy admin
  (`resolveLegacyAdminContext:336`, taken when `key === config.accessKey`, the
  env `MCP_ACCESS_KEY`). Each returns one `accessContext` with a single
  `effectiveBrainId`, and **each denies inline with 403 during resolution**
  (`auth.mjs:209-210, 305-309, 317, 347`).
- **Selectors today**: route `:brainSlug` (`/mcp/brains/:brainSlug`), query
  `?brain=`, header `x-brain-slug` (`auth.mjs:227-239`). **No body/tool-arg
  `brain` exists** — read/write schemas in `server.mjs:29-130` have no `brain`
  field.
- **Handlers today** all act on the single `accessContext.effectiveBrainId`:
  capture write `server.mjs:344-345`, metadata patch scoped by `id AND brain_id`
  `server.mjs:579,627-628,644` (cross-brain patch → "Thought not found"), search
  `:369`, ask `:450`, similar `:672`, list `:697`, stats `:709`.
- **Graph tools** (`graph_neighbors/source_lineage/why_connected/expand_context`)
  are admin-gated (`ensureGraphAdmin`, `server.mjs:773-777`) and key off global
  `canonical_id` with no brain filter. They stay out of scope (§2 D13).
- **Legacy-admin `?brain=<other-existing-slug>` succeeds today**: it resolves
  globally and becomes the effective brain (`auth.mjs:336-363`,
  `resolveBrainBySlugGlobal:121-138`). Any rule that turns this into a deny is
  wrong against the runtime.

## 2. Canonical decisions (the single source for every rule)

### 2.1 The four layers (named once)

| Layer | Name | Question | Lives in |
|------|------|----------|----------|
| **L1** | Selector admissibility | Which inputs may carry a brain for this auth source + route? | `auth.mjs` + handler |
| **L2** | Lookup scope | Which brains can this principal even *name*? | `auth.mjs` membership load |
| **L3** | Effective brain | The one brain a request acts on, or the read-set for default multi-brain reads | `auth.mjs` / `resolveRequestBrain` |
| **L4** | Access decision | Allow/deny the chosen brain for this operation's `mode` | `resolveRequestBrain` / handler |

L4 runs **at the point the brain is chosen** — inside `resolveAccessContext` for
L1 selectors, inside the new `resolveRequestBrain` helper for body/tool-arg
selectors. There is no separate later stage. This is deliberate and matches the
live resolver.

### 2.2 Lookup scope and access set (D1)

For principal `P` (non-legacy-admin):

```
estateBrains(P)  = brains in any household where P has an estate_membership ALLOW
brainGrants(P)   = brains where P has a brain_membership row with is_deny = false
denied(P)        = brains where P has a brain_membership row with is_deny = true
lookupScope(P)   = estateBrains(P) ∪ brainGrants(P)          // what P may NAME
accessSet(P)     = lookupScope(P) \ denied(P)                 // what P may USE
```

Invariant: `accessSet(P) ⊆ lookupScope(P)`. There is **no implicit home-estate
visibility** — being homed in an estate does not grant lookup of its brains; an
estate_membership row does.

### 2.3 Status-code contract (D2) — the single rule, applied everywhere

| Situation | Status |
|---|---|
| Selector source not admissible for this auth source/route (e.g. human token sends `?brain=`, or MCP tool-arg `brain` differs from route brain) | **400** |
| Named slug/UUID resolves to **no brain in `lookupScope(P)`** (never granted; existence not disclosed) | **404** |
| Named brain **is in `lookupScope(P)` but denied** — either a `brain_membership` deny row overriding an estate allow, **or** role/`mode` insufficient (e.g. read-only member attempts write) | **403** |
| Slug ambiguous across multiple brains the resolver may see (legacy-admin global lookup only) | **400** |

This is the only status table in the document. Every acceptance row in §5 is an
instance of it. Slug vs UUID never change the status: both resolve through
`lookupScope`/`accessSet` identically (404 if unreachable, 403 if reachable-but-denied).

### 2.4 Per-auth-source selector + default rules (D3)

| Auth source | Admissible L1 selectors | Tool/body `brain` | Default brain when omitted |
|---|---|---|---|
| **human_token** | route `:brainSlug` **only** (query/header → 400) | non-MCP HTTP: body `brain` is the selector. MCP: tool-arg `brain` must **equal** route brain or 400 (no per-call switching) | `principal.default_brain_id` |
| **service_key** | route, query, header | body/tool-arg `brain` is a selector | brain-bound key → `key.brain_id`; else `principal.default_brain_id` |
| **legacy_admin_key** | route, query, header (resolved **globally**) | body/tool-arg `brain` is a selector; if an L1 selector is also present and differs → 400 | first person principal's `default_brain_id` (`resolveDefaultAdminBrain`) |

Legacy admin (`isAdmin=true`) is exempt from L2/L4 denial: any existing brain it
names becomes the effective brain (200). Its only failures are 404 (slug not
found globally) and 400 (ambiguous slug, or L1-vs-body mismatch).

### 2.5 Read vs write defaults (D4) — the rule v8 broke

- **Writes** (`capture_thought`/`/ingest/thought`, `update_thought_metadata`/
  `/admin/thought/metadata`): when `brain` is omitted, the operation targets
  **exactly `default_brain_id`**. A write **never** fans out across multiple
  brains. Cross-brain write requires an explicit `brain` and passes L4 `mode='write'`/`'edit'`.
- **Reads** (`search_thoughts`, `list_thoughts`, `ask_brain`, `stats`): when
  `brain` is omitted, the operation spans **all of `accessSet(P)`** (ADR-0001
  point 11), with per-row `brain_id`/`brain_slug` (D6). An explicit `brain`
  narrows to that one brain.

### 2.6 L4 runs on every write surface (D5) — the rule v9/v10 chased

Capture and metadata both resolve a brain and then check `mode` against role
**before** touching `thoughts`. No handler writes to `accessContext.effectiveBrainId`
without an L4 check. Write/edit roles:

| Grant | read | write (capture) | edit (metadata) |
|---|---|---|---|
| brain_membership `viewer` | ✓ | ✗ (403) | ✗ (403) |
| brain_membership `editor`/`owner` | ✓ | ✓ | ✓ |
| estate_membership `member` | ✓ | ✗ (403) | ✗ (403) |
| estate_membership `admin` | ✓ | ✓ | ✓ |
| brain_membership `is_deny` | ✗ (403) | ✗ (403) | ✗ (403) |
| legacy_admin | ✓ | ✓ | ✓ |

### 2.7 Multi-brain read response shape (D6)

Every read result row gains `brain_id` and `brain_slug`. `stats` returns
`per_brain: [{brain_id, brain_slug, overview, top_*}]` **plus** an aggregate
`overview`. Single-brain (explicit `brain`) responses keep today's flat shape
with the two new fields added. This is additive; existing single-brain callers
keep parsing.

### 2.8 Legacy-admin no-regression (D7)

`MCP_ACCESS_KEY` (env, `config.accessKey:349`) keeps full global admin behavior
unchanged. Existing scripts that send it bare (no `brain`) keep hitting
`resolveDefaultAdminBrain`'s brain exactly as today. `.envrc` for repo principals
uses a **separate** stored key (`OB1_OPERATOR_ACCESS_KEY` / per-repo key); it does
**not** repoint `MCP_ACCESS_KEY`. Enrichment/backfill tooling that must patch a
non-default brain passes explicit `brain` (now possible via D3) instead of relying
on the old single-brain behavior.

### 2.9 Out of scope (D13)

Graph tools stay admin-only with no `brain` parameter; the household→estate
rename (ADR Vocabulary) is a separate migration; edit/delete-content and audit-log
emission (ADR-27) are not added here. `stats` graph block stays admin-only.

## 3. Phasing (independently landable, test-first)

Each phase lands with its tests green before the next starts. Phases are vertical:
schema → resolver → handlers → response-shape → rollout.

- **Phase 1 — Schema.** Migration `009_estate_memberships.sql`: create
  `estate_memberships(principal_id, household_id, role text not null, primary key
  (principal_id, household_id))`; `alter table brain_memberships add column
  is_deny boolean not null default false`; indexes on both. No behavior change yet.
- **Phase 2 — Resolver (L1/L2/L3/L4 for L1 selectors).** Teach `auth.mjs` to load
  estate + brain memberships and compute `lookupScope`/`accessSet` (D1); apply the
  D2 status contract; keep legacy-admin global (D3). Output: `accessContext` gains
  `accessSet` (array of `{brainId, brainSlug}`) alongside `effectiveBrainId`.
- **Phase 3 — Body/tool-arg selector + write L4.** Add optional `brain` to the six
  schemas (`server.mjs:29,41,50,55,66,92`); add helper `resolveRequestBrain(
  accessContext, explicitBrain, {mode})` implementing D2/D3/D4/D5; route capture
  and metadata through it with `mode='write'`/`'edit'` (D5).
- **Phase 4 — Multi-brain reads + response shape.** Make search/list/ask/stats
  honor explicit `brain` (narrow) or `accessSet` (fan out, parallel-and-merge),
  add `brain_id`/`brain_slug` per row and `per_brain` stats (D6).
- **Phase 5 — Rollout.** Provision repo principals + memberships via CLI; set
  per-repo `.envrc` stored keys (D7); migrate enrichment scripts to explicit
  `brain`; prove operator visibility end to end.

## 4. Code sites that must change (named, not aspirational)

| Work | File:line today | Change |
|---|---|---|
| estate membership load | `auth.mjs:65 loadPrincipalMemberships`, `:241 resolveStoredAccessKeyContext` | also select `estate_memberships`; compute lookupScope/accessSet |
| stop brain-membership-only authz | `auth.mjs:209, 308` | replace membership-existence check with `accessSet`/`lookupScope` + D2 statuses |
| legacy-admin unchanged | `auth.mjs:336-363` | keep; only confirm L1-vs-body mismatch → 400 in handler |
| `accessContext.accessSet` | `auth.mjs` return objects (`:213, :320, :353`) | add `accessSet` field |
| `brain` schema fields | `server.mjs:29,41,50,55,66,92` | add `brain: z.string().optional()` (slug or UUID) |
| `resolveRequestBrain` helper | new in `auth.mjs` or `server.mjs` | central L2/L3/L4 for explicit `brain` |
| capture L4 | `server.mjs:312-350` | resolve brain + `mode='write'` before `upsertThought` |
| metadata L4 + cross-brain | `server.mjs:1085-1100, 566-646` | resolve brain + `mode='edit'`; patch by chosen brain |
| read fan-out + row shape | `server.mjs:360,694,707,663` + `retrieval.mjs` | accept brain set; tag rows with brain_id/brain_slug |
| stats per-brain | `server.mjs:707-771` | per-brain breakdown + aggregate |

## 5. Acceptance matrix (inlined; each row is an instance of D2)

Notation: `D`=default brain, `A`=accessible non-default brain (estate or brain
grant, allow), `X`=denied brain (in lookupScope via estate-allow, brain-deny row),
`O`=brain not in lookupScope, `U(...)`=UUID form of a brain.

### 5.1 Selector resolution (Phase 2)

| auth | selector | expect | rule |
|---|---|---|---|
| human_token | `POST /mcp/brains/D` | 200, eff=D | D3 |
| human_token | `POST /mcp/brains/A` (membership) | 200, eff=A | D3 |
| human_token | `POST /mcp/brains/X` | 403 | D2 reachable-denied |
| human_token | `POST /mcp/brains/O` | 404 | D2 unreachable |
| human_token | `?brain=A` (query) | 400 | D3 query forbidden for human |
| service_key (non-bound) | `?brain=A` | 200, eff=A | D3 |
| service_key (non-bound) | `?brain=U(A)` | 200, eff=A | D2 slug/UUID identical |
| service_key (non-bound) | `?brain=X` | 403 | D2 |
| service_key (non-bound) | `?brain=U(X)` | 403 | D2 (UUID does not downgrade to 404) |
| service_key (non-bound) | `?brain=O` | 404 | D2 |
| service_key (brain-bound, non-admin) | `?brain=<other>` | 403 | D3 key bound |
| legacy_admin | `?brain=<any-existing-global>` | 200, eff=that | D3 admin global |
| legacy_admin | `?brain=<nonexistent>` | 404 | D2 |
| legacy_admin | bare (no selector) | 200, eff=default-admin-brain | D7 |

### 5.2 Writes (Phase 3)

| auth | route | body `brain` | expect | rule |
|---|---|---|---|---|
| service_key (editor on D) | `/ingest/thought` | omitted | 200 → D only | D4 write default |
| service_key (editor on A) | `/ingest/thought` | `A` | 200 → A | D4/D5 |
| service_key (viewer on A) | `/ingest/thought` | `A` | 403 | D5 write role |
| estate_member (role=member) | `/ingest/thought` | `A` | 403 | D5 estate member read-only |
| estate_admin | `/ingest/thought` | `A` | 200 → A | D5 |
| service_key | `/admin/thought/metadata` thought in A | `A` | 200 | D5 cross-brain edit by explicit brain |
| service_key | `/admin/thought/metadata` thought in A | omitted | 404 "not found" | D4 (scoped to D, thought not in D) |
| human_token (viewer on A) | `/admin/thought/metadata` | body `A` | 403 | D5 |
| legacy_admin | `/admin/thought/metadata` thought in A | `A` | 200 | D7 |
| any | capture | body `O` | 404 | D2 |

### 5.3 Reads (Phase 4)

| auth | tool | `brain` | expect | rule |
|---|---|---|---|---|
| service_key (accessSet={D,A}) | `search_thoughts` | omitted | 200, rows from D∪A, each tagged brain_id/slug | D4 read default |
| service_key | `search_thoughts` | `A` | 200, rows from A only | D4 narrow |
| service_key | `search_thoughts` | `X` | 403 | D2 |
| service_key | `search_thoughts` | `O` | 404 | D2 |
| human_token MCP (route=D) | `search_thoughts` tool-arg `brain=A` | — | 400 | D3 MCP no per-call switch |
| human_token MCP (route=D) | `search_thoughts` tool-arg `brain=D` | — | 200, D | D3 match allowed |
| any | `stats` | omitted | 200, `per_brain[]` + aggregate over accessSet | D6 |
| legacy_admin | `search_thoughts` | `<any-global>` | 200, that brain | D7 |

## 6. Definition of done

1. Migration 009 applied; `npm run check` + `./scripts/verify-open-brain-local.sh`
   green.
2. Every §5 row has a passing test in the runtime test suite.
3. No handler writes to `effectiveBrainId` without an L4 check (grep gate).
4. Existing bare-`MCP_ACCESS_KEY` smoke flow
   (`scripts/smoke-open-brain-running-service.sh`) passes unchanged (D7).
5. Operator end-to-end: `luchoh` principal with estate_membership over the agent
   estate reads a thought captured by a repo principal, and the wife's brain (no
   membership) returns 404 to that operator. Both proven by test, not assertion.

## 7. Known residual decisions (call them out, do not bury)

- **`ask_brain` default scope under multi-brain.** Reads fan out per D4; if answer
  synthesis quality degrades across brains, restrict `ask_brain` default to
  `default_brain_id` and require explicit `brain` for cross-brain — decide during
  Phase 4 with a real eval, not in prose.
- **Ambiguous slug for multi-estate operators.** Only legacy-admin can hit global
  ambiguity today (→400). If a future principal gains memberships in two estates
  sharing a slug, lookup is still household-scoped per membership, so no ambiguity
  arises; revisit only if cross-estate slug collision becomes reachable.
- **Audit-log emission (ADR-27).** Write surfaces should emit audit rows; tracked
  separately, not gated here.
</content>
</invoke>
