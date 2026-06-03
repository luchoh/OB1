# PRD: Agent Estate + Brain Selection — Implementation Roadmap (v16)

Date: 2026-06-03
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`,
           CONTEXT `CONTEXT.md`,
           reviews v1–v15
Supersedes: v1–v15

## Why v16

v15 was rejected on one finding plus one secondary gap. Both are
about **propagating the same change to every layer it touches**:

1. **Human-token contract was made executable on MCP routes only.**
   v15 added Phase 2 acceptance rows for `POST /mcp/brains/:slug`
   but left Phase 3 (non-MCP HTTP body-`brain` path) inherited from
   v11. D9 explicitly says body `brain` is the human-token
   mechanism on those routes. So an implementer who passes v15's
   Phase 2 still has freedom to leave `/ingest/thought` and
   `/admin/thought/metadata` body-brain paths inconsistent for
   human-token.
2. **D18's "403 = deny override" overstates the invariant.** That
   claim is correct for slug-resolution and read-visibility, but
   Phase 3 has role-based 403 cases (member can't edit, plain
   estate-member can't write) that aren't deny-override-driven at
   all. D18 risks teaching the wrong rule.

v16 fixes both:

- New Phase 3 acceptance section explicitly covering human-token
  non-MCP HTTP body-`brain` cases. Mirrors the MCP route matrix on
  the body-brain selector.
- D18 wording scoped: the "403 = deny override" rule applies to
  **slug-resolution / read-visibility only**. Mode-based 403s
  (write/edit denial without a deny row) remain valid; D18 doesn't
  describe them.
- Migration narrative names the handler-layer call sites
  (`server.mjs:312` for capture, `server.mjs:1085` for metadata
  patch) alongside the auth-context resolvers, not just the latter.

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

### D8. Slug-vs-UUID resolution — visibility tracks explicit grants, with deny override visible (refined migration sites)

The two-step structure stays. The lookup-scope-per-auth-source
table stays unchanged from v15. The accessible-set / lookup-scope
inline definitions stay. The orphan-deny-row case stays.

The migration narrative (Finding 1 fix part 1) is widened to name
the handler-layer call sites. Auth-context changes alone are NOT
sufficient to land the new human-token contract — the body-`brain`
parsing and write paths in non-MCP HTTP handlers must also be
updated.

#### Migration sites (v16, expanded)

**Auth-context layer:**
- `loadPrincipalAccess` (replaces `loadPrincipalMemberships` at
  `auth.mjs:65`).
- `resolveStoredAccessKeyContext` (`auth.mjs:241-317`): slug lookup
  over `lookupScope(P)`.
- `resolveHumanAccessContext` (`auth.mjs:159-225`): slug lookup
  over `lookupScope(P)`. Same change as the stored-key resolver.
- `resolveAccessContext` selector unification (route+query+header).

**Handler layer (NEW in v16, Finding 1 fix):**
- `handleCaptureThought` (`server.mjs:312`): parse body `brain`,
  resolve via D8, run L4 `mode='write'`. Default = effective brain
  per D7 v9. Closes the human-token non-MCP HTTP body-`brain` path
  for capture.
- `/admin/thought/metadata` route (`server.mjs:1085`): parse body
  `brain`, resolve via D8, run L4 `mode='edit'`. Default = effective
  brain per D7 v9. Closes the same path for metadata patch.
- `handleAskBrain`, `handleSimilarThoughtLookup`: parse body
  `brain`, run L4 `mode='read'`. Default = effective brain.
- `handleSearchThoughts`, `handleListThoughts`, `handleStats`:
  multi-brain default for non-human-token / non-brain-bound;
  human-token defaults to single brain (D9).

The handler-layer changes are not optional. Without them, an
implementer can update auth resolvers, pass Phase 2 acceptance
(MCP routes), and leave the non-MCP HTTP human-token path doing
the old single-effective-brain behavior. v16 names the sites so
that gap is visible during implementation.

### D9. Human-token request-scoped binding (unchanged from v15; reaffirmed)

For human-token on non-MCP HTTP routes, body `brain` IS the
selection mechanism. Phase 3 acceptance now covers this explicitly
(below).

### D10. Env split (unchanged)

### D11. Stored `is_admin` provisioning policy (unchanged)

### D12. Estate-membership `role='member'` is read-only (unchanged)

### D13. Smoke harness contract (unchanged)

### D14. Legacy-admin layer hygiene (unchanged)

### D15. `/admin/thought/access-check` query param `target_brain` (unchanged)

### D16. No estate-rename in this work (unchanged)

### D17. Auth-context resolution becomes estate-aware (unchanged)

### D18. Visibility tracks explicit grants; lookup ⊇ access; 403/404 semantics scoped to slug-resolution and read-visibility (Finding secondary 2 fix)

The v15 properties stand:
- Visibility-via-explicit-grants: home estate gives no implicit
  visibility.
- Lookup ⊇ access: lookup is a strict superset of access, differing
  only by deny rows that overlap an allow path.
- 404 means "no current allow path covers this brain for this
  principal."

**Scope clarification (v16, Finding secondary 2):**

The 403/404 framing in D18 describes **slug-resolution and
read-visibility** outcomes only. It is the answer to "can this
principal *find* this brain?" — i.e., what `resolveBrainSlug`,
`resolveBrainUuid`, and `mode='read'` access checks return for the
selector layer.

D18 does NOT describe **mode-based access denial** at the operation
layer. Those produce 403 too, for entirely different reasons:
- mode='write' denied for a principal with read-only access
  (D6 case 4 + D7).
- mode='edit' denied for a principal with role='member' on a brain
  (D6 case 4 mode='edit' requires editor/owner).
- mode='write'/mode='edit' denied for a principal with only
  estate-membership of role='member' (D12).

These mode-based 403s are not deny-row-driven. They are role/mode
mismatch denials. They co-exist with D18's slug-visibility 403s.
Both are valid 403s in the system. v16 says so explicitly so a
future implementer doesn't try to "unify" them and break either.

If you ever want a unified taxonomy, that's a separate doc. v16
keeps the layering: D18 governs visibility (where the principal
can look); D6 + D7 govern operations (what the principal can do
with what they find).

## Phasing

### Phase 1 — Schema (unchanged)

### Phase 2 — Auth context + helpers (unchanged from v15)

The Phase 2 matrix from v15 stays. It covers the access-context
layer and MCP route selection. Non-MCP HTTP body-`brain`
acceptance moves to Phase 3 explicitly (Finding 1 fix).

### Phase 3 — Tool & HTTP surfaces (expanded human-token coverage; Finding 1 fix)

Handler-layer changes at `server.mjs:312` (capture) and
`server.mjs:1085` (metadata patch) plus the read handlers. Same
shape as v11/v12/v13/v14/v15 except the acceptance section now
makes the human-token non-MCP HTTP body-`brain` path explicit.

**Capture path** (`capture_thought`, `/ingest/thought`):

(Unchanged. L4 mode='write' always. Default per D7.)

**Read path** (`search_thoughts`, `list_thoughts`, `ask_brain`,
`/ask`, `/admin/thought/similar`):

(Unchanged.)

**`stats`:** (Unchanged. D5 multi-brain shape.)

**`/admin/thought/metadata`:** (Unchanged. L4 mode='edit' always.)

**`/graph/*`:** unchanged.

**Acceptance — Finding 1 closure (metadata patch, from v10):**

(Unchanged.)

**Acceptance — Finding 2 closure (capture path, from v11):**

(Unchanged.)

**Acceptance — D8 v11 status codes on body `brain`:**

(Unchanged.)

**Acceptance — Human-token non-MCP HTTP body-`brain` (NEW in v16):**

The four MCP-route human-token rows from Phase 2 each have a
mirror on non-MCP HTTP. Body `brain` is the selector.

| auth, scenario                                                                                | route + body                                                            | expected | rationale |
|-----------------------------------------------------------------------------------------------|-------------------------------------------------------------------------|----------|-----------|
| `human_token`, brain-membership exists                                                        | `POST /ingest/thought` body `brain="ob1"`                               | 200      | L4 mode='write' allows |
| `human_token`, brain-membership exists                                                        | `POST /admin/thought/metadata` body `brain="ob1"` (role='editor')       | 200      | L4 mode='edit' allows |
| **`human_token`, no membership to target, target in same household** (NEW Finding 1)          | **`POST /ingest/thought` body `brain="<same-household-no-grant>"`**     | **404**  | **D8 lookup miss; supersedes `docs/17:565`** |
| **`human_token`, no membership to target, target in same household** (NEW)                    | **`POST /admin/thought/metadata` body `brain="<same-household-no-grant>"`** | **404**  | **same** |
| **`human_token`, brain-deny override of estate-allow** (NEW)                                  | **`POST /ingest/thought` body `brain="<denied-via-brain-deny>"`**       | **403**  | **D8 lookup hit via estate, deny wins** |
| **`human_token`, brain-deny override of estate-allow** (NEW)                                  | **`POST /admin/thought/metadata` body `brain="<denied-via-brain-deny>"`** | **403**  | **same** |
| **`human_token`, body `brain` is a typo / not in scope** (NEW)                                | **`POST /ingest/thought` body `brain="<typo>"`**                        | **404**  | **D8 step 1 miss** |
| **`human_token`, estate-only access** (NEW)                                                   | **`POST /ingest/thought` body `brain="<brain-in-membership-estate>"`**  | **200**  | **D8 lookup includes estateBrains** |
| **`human_token`, estate-only access, edit attempt without estate-admin role** (NEW)           | **`POST /admin/thought/metadata` body `brain="<brain-in-membership-estate>"`** (estate-`member`, not admin) | **403**  | **D7 + D12: mode='edit' denied for plain estate-member; this is a mode-based 403, NOT a deny-override 403** |
| **`human_token`, no body `brain` on metadata patch** (Finding 1 from v9, reconfirmed)         | **`POST /admin/thought/metadata` no body brain, target row in non-default brain** | **404**  | **D7 v9: scope to default brain, target not found there** |

The eight new rows are the executable contract for the
human-token non-MCP HTTP body-`brain` path. The "estate-member
edit attempt" row is the canonical mode-based 403 that D18
v16 carve-out preserves.

**Other acceptance** (legacy admin, brain-bound, repo principal,
admin in household, human-token MCP routes from v15 Phase 2):
unchanged.

### Phase 4 — Provisioning CLI (unchanged)

### Phase 5 — Per-repo `.envrc` (unchanged)

### Phase 6 — Routing skill (unchanged)

### Phase 7 — Migrate writers (unchanged)

### Phase 8 — Legacy-admin layer hygiene (unchanged)

## Risks and mitigations

(Unchanged from v15, plus:)

- **The handler-layer migration is part of Phase 3, not just
  Phase 2.** Mitigation: D8 v16 names the call sites. Phase 3
  acceptance has executable rows for human-token on non-MCP HTTP
  body-`brain`. Implementer cannot pass Phase 3 without updating
  both the auth context AND the handlers.
- **D18 governs slug-visibility and read-visibility only.**
  Mitigation: D18 v16 says so explicitly. Phase 3 mode-based 403
  rows are clearly labeled as such, not as D18 deny-override 403s.
  A future "unify all 403 reasons" effort would have to amend
  both D6 and D18.

## Out of scope, tracked separately (unchanged)

## Open questions (unchanged)
