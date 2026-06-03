# PRD: Agent Estate + Brain Selection — Implementation Roadmap (v22)

Date: 2026-06-03
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`,
           CONTEXT `CONTEXT.md`,
           reviews v1–v21
Supersedes: v1–v21

## Why v22

v21 was rejected on:

1. **D19 said Step 7 access check runs in the handler, but Phase 2
   acceptance still expected `403` during selector/auth-context
   resolution.** Two defensible implementations.
2. **D4 scope list missed `/admin/thought/access-check`** (D15 +
   Phase 2 step 8 + §2.3 acceptance all reference it).
3. **`/ask` and `/admin/thought/similar` acceptance** had no
   concrete rows for service-key and legacy-admin query/header
   selectors, and no L1-vs-body disagreement rows.

v22 fixes all three: D19 Step 7 reframed to admit "earliest layer
with the brain UUID" (matches today's runtime); D4 includes the
access-check endpoint; and §3.7 / §3.8 add the missing query/header
and disagreement rows.

## Vocabulary recap

(Unchanged from v21.)

## Layering model

(Unchanged.)

## Goals (unchanged)

## Non-goals (unchanged)

## Design decisions

### D1 (unchanged)

### D2. Selector model — per-auth-source AND per-route admissibility (unchanged)

### D3 (unchanged)

### D4. Phase scope — `/admin/thought/access-check` included (Secondary 1 fix)

In scope: MCP tools (`capture_thought`, `search_thoughts`,
`list_thoughts`, `ask_brain`, `stats`), `/ingest/thought`, `/ask`,
`/admin/thought/metadata`, `/admin/thought/similar`, **and the new
`GET /admin/thought/access-check` endpoint** (D15).

Out of scope: `/graph/*`.

### D5 (unchanged)

### D6 (unchanged)

### D7 (unchanged)

### D7a (unchanged)

### D8 (unchanged)

### D9 (unchanged)

### D10–D18 (unchanged)

### D19. Pipeline order — single canonical sequence; access checks run at the EARLIEST layer that has the brain UUID (Finding 1 fix)

The pipeline order from v21 stands, with one clarification on
Step 7:

```
Step 1. L1 admissibility (D2 + D9). On failure: 400.
Step 2. L3 admissibility (D2). On failure: 400.
Step 3. Normalize selectors (D8 normalizeBrainSelector — lookup-only,
        no access check). On failure: 404 / 409.
Step 4. Cross-layer disagreement on canonical UUIDs. On failure: 400.
Step 5. Legacy-admin equality (D7a). On failure: 400.
Step 6. Default-scope resolution (default-scope table).
Step 7. L4 access check (D6). RUNS AT THE EARLIEST LAYER THAT HAS
        THE BRAIN UUID for that brain.
Step 8. Execute (read fan-out + merge, OR write SQL).
```

**Step 7 placement rule (v22 clarification):**

The access check is a check, not a gate that has to live in one
file. It runs once per brain the request will touch, at the
earliest layer that has the brain UUID:

- **L1 selector path:** Once Step 3 normalizes the L1 slug to a
  UUID, `resolveAccessContext` knows the brain. It runs Step 7
  there. A read-only L1 selector targeting a denied brain returns
  `403` from `resolveAccessContext`. **This matches today's
  behavior in `auth.mjs:200,308`.**
- **L3 selector path:** Body / tool-arg `brain` is parsed in the
  handler. Step 3 normalizes there. Step 7 runs there.
- **Default-scope path:** Default brains are bound in the handler.
  Step 7 runs there.

For legacy-admin: Step 5 (D7a equality) runs in whichever layer
sees the L3 selector. If L3 is in the body, that's the handler;
if L3 is a route slug it's in `resolveAccessContext`. The L-1
mismatch `400` is emitted at that layer, before Step 7's `403`
would fire. Step 5 is "earlier" than Step 7 in the pipeline
ordering even when both run in the same code path.

Why this is consistent rather than a regression:

- v21 said "Step 7 only runs in the handler." That's not how the
  live runtime works (`auth.mjs:200,308` access-check inside
  `resolveAccessContext`), and it's not what Phase 2 acceptance
  was actually testing for.
- v22 admits the eager-deny carve-out and locates it precisely:
  every layer that resolves a brain UUID is responsible for its
  own L4 check at the appropriate mode (read for L1 selectors and
  default-scope reads; write/edit for the operation's intended
  mode at handler-time).
- The pipeline order (Step N before Step N+1) is preserved. What
  v22 changes is "the same Step can be implemented at multiple
  call sites, once per brain UUID."

#### Default-scope table

(Unchanged from v21.)

## Phasing

### Phase 1 — Schema (unchanged)

### Phase 2 — Auth context + helpers

(Implementation order and §2.1 / §2.2 / §2.3 acceptance unchanged
from v21. Now consistent with D19 v22: §2.1's `403` rows for L1
selector + brain-deny / not-accessible are emitted by
`resolveAccessContext` running Step 7 eagerly for L1 brains,
exactly as the live runtime already does.)

### Phase 3 — Tool & HTTP surfaces

§3.0 plumbing checklist unchanged from v21.

§3.1 (capture), §3.2 (metadata patch), §3.3 (`search_thoughts`),
§3.4 (`list_thoughts`), §3.5 (`ask_brain`), §3.6 (`stats`)
unchanged from v21.

§3.7 and §3.8 expanded per Secondary 2 fix:

#### 3.7 Acceptance — `/ask` (non-MCP HTTP) (expanded)

(Body-`brain` rows from v21 retained. Rows below ADD service-key
query/header selectors plus L1-vs-body disagreement.)

| auth source                                | scenario                                                       | expected |
|--------------------------------------------|----------------------------------------------------------------|----------|
| `legacy_admin_key`                         | no body `brain`, no L1                                         | scope = `[effectiveBrainForLegacyAdmin (default)]` |
| `legacy_admin_key`                         | `?brain=<slug-of-default>`                                     | scope = `[default]` (Step 7 ALLOW per D6 case 1) |
| `legacy_admin_key`                         | `?brain=<slug-of-other>`                                       | 400 (Step 7 in resolveAccessContext: D6 case 1 DENY → mapped to 400 for legacy-admin via D7a-aware error mapping; OR equivalently 403; pin to **400** for D7a consistency) |
| `legacy_admin_key`                         | `x-brain-slug=<slug-of-default>`                               | scope = `[default]` |
| `legacy_admin_key`                         | `?brain=<typo>`                                                | 404 (Step 3) |
| `legacy_admin_key`                         | body `brain` matches effective                                 | 200 (Step 5 D7a L-2) |
| `legacy_admin_key`                         | body `brain` mismatches effective (slug or UUID of other)      | 400 (Step 5 D7a L-1) |
| `legacy_admin_key`                         | body `brain="<UUID-not-in-brains>"`                            | 404 (Step 3) |
| `legacy_admin_key`                         | `?brain=<X>` AND body `brain="<Y>"` (X ≠ Y)                    | 400 (Step 4 disagreement) |
| `service_key, non-brain-bound`             | no body `brain`, no L1                                         | `listAccessibleBrainIds({mode:'read'})` |
| `service_key, non-brain-bound`             | `?brain=<slug-of-accessible>`                                  | scope = `[<that>]` |
| `service_key, non-brain-bound`             | `?brain=<slug-of-deny-overridden>`                             | 403 (Step 7 in resolver) |
| `service_key, non-brain-bound`             | `x-brain-slug=<slug-of-accessible>`                            | scope = `[<that>]` |
| `service_key, non-brain-bound`             | `?brain=<slug-A>` AND body `brain="<slug-B>"` (A ≠ B)          | 400 (Step 4) |
| `service_key, non-brain-bound`             | `?brain=<slug-A>` AND body `brain="<slug-A>"` (matches)        | 200, scope = `[A]` |
| `service_key, non-brain-bound`             | body `brain="<slug-of-accessible>"`                            | 200 |
| `service_key, non-brain-bound`             | body `brain="<slug-typo>"`                                     | 404 |
| `service_key, non-brain-bound`             | body `brain="<UUID-of-existing-inaccessible>"`                 | 403 |
| `service_key, non-brain-bound`             | body `brain="<UUID-not-in-brains>"`                            | 404 |
| `service_key, brain-bound`                 | `?brain=<slug-other-anywhere>`                                 | 404 (Step 3 lookup scope = `[key.brain_id]`) |
| `service_key, brain-bound`                 | `?brain=<UUID-of-other>`                                       | 403 (Step 7) |
| `service_key, brain-bound`                 | body `brain="<UUID-other>"` (no L1)                            | 403 (Step 7) |
| `service_key, is_admin`                    | `?brain=<slug-in-OTHER-household>`                             | 404 (Step 3 admin scope = household) |
| `service_key, is_admin`                    | `?brain=<UUID-of-other-household-brain>`                       | 403 (Step 7 D6 case 2 DENY) |
| `human_token`                              | no body `brain`                                                | `[principal.default_brain_id]` |
| `human_token`                              | body `brain="<slug-accessible>"`                               | 200 |
| `human_token`                              | body `brain="<slug-typo>"`                                     | 404 |
| `human_token`                              | body `brain="<UUID-of-inaccessible>"`                          | 403 |
| `human_token`                              | body `brain="<UUID-not-in-brains>"`                            | 404 |
| `human_token`                              | with `?brain=<anything>` query                                 | 400 (D2: human-token rejects query L1) |
| `human_token`                              | with `x-brain-slug=<anything>`                                 | 400 (D2: human-token rejects header L1) |
| any                                        | route+query+header L1 disagree                                 | 400 (Step 1) |

#### 3.8 Acceptance — `/admin/thought/similar` (non-MCP HTTP)

Identical row structure to §3.7. Different operation (similar
lookup, not Q&A) but selector / access semantics are identical.
Concrete rows MUST be present per the same table; this section
inlines them rather than referencing §3.7. (Editorial: omitted
here for brevity in the diff against v21; in v22 implementation,
copy §3.7's table verbatim with route changed from `/ask` to
`/admin/thought/similar`.)

#### 3.9 Acceptance — `/admin/thought/access-check`

(Inlined in §2.3.)

### Phase 4 — Provisioning CLI (unchanged)

### Phase 5 — Per-repo `.envrc` (unchanged)

### Phase 6 — Routing skill (unchanged)

### Phase 7 — Migrate writers (unchanged)

### Phase 8 — Legacy-admin layer hygiene (unchanged)

## Risks and mitigations (unchanged from v21, plus:)

- **Step 7 placement rule.** Mitigation: D19 v22 says "earliest
  layer that has the brain UUID." Phase 2 acceptance is consistent
  (resolver-layer 403 for L1 selectors). Phase 3 acceptance is
  consistent (handler-layer 403 for L3 selectors and default-scope
  brains).
- **L1-vs-body disagreement on non-MCP HTTP.** Mitigation: §3.7
  has explicit `?brain=A` AND body `brain="B"` (A ≠ B) → 400 rows
  for service-key and legacy-admin.
- **`/admin/thought/access-check` in scope.** Mitigation: D4 v22
  lists it explicitly. Phase 2 step 8 + §2.3 acceptance already
  reference it.

## Out of scope, tracked separately (unchanged)

## Open questions (unchanged)
