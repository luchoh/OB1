# PRD: Agent Estate + Brain Selection — Implementation Roadmap (v24)

Date: 2026-06-03
Status: Plan (derived from accepted ADR-0001)
Owner: Retrieval / Tenancy
Companion: ADR `docs/adr/0001-agent-estate-brain-model.md`, `CONTEXT.md`
Supersedes: v1–v23.

## Why v24 (read this first)

v24 is a deliberate reset back to the **base roadmap** plus the handful of
fixes the v1–v22 review loop actually earned. A drift audit of v23 found that
the loop invented requirements no source ever asked for (a 404-vs-403
existence-hiding contract; a role→capability enforcement matrix; per-auth-source
400 selector rules) and, while polishing those, dropped real ADR deliverables
(the routing skill, the provisioning CLI, the `.envrc` rollout, telemetry).

Two scope decisions, made by the owner, define v24:

1. **Access failures return `403`. Period.** No existence-hiding behind `404`.
   Privacy (the spouse's brain) is preserved by *absence of a membership row* +
   `403`, exactly as ADR-0001 point 4 states. A slug/UUID that resolves to **no
   brain at all** is a plain `404` ("not found"); a brain that exists but the
   principal cannot access is `403`. There is one access set, not two.
2. **Role is recorded but not enforced** (base's explicit open-question stance).
   Access is allow/deny at brain/estate granularity. No role enum, no role-gated
   write/edit. Agent-side write-authz stays out of scope (base "Out of scope").
   Wiring role enforcement is a separate, later, explicitly-decided work item.

What v24 **keeps** from the loop (genuinely source-required fixes):

- Per-row `brain_id`/`brain_slug` on multi-brain reads (ADR-0001 point 11).
- Writes target exactly the default-when-omitted brain; **reads** fan out across
  accessible brains. Writes never fan out (ADR-0001 points 10–11).
- Legacy-admin (`MCP_ACCESS_KEY`) keeps full behavior; repo principals get a
  **separate** stored key (fixes the base's false "no-op" back-compat claim —
  the env key routes through the principal-less legacy-admin path).
- `/admin/thought/metadata` and capture validate brain access on the **chosen**
  brain, and a cross-brain patch is honestly surfaced (fixes the base's "no
  writer changes" miss).
- Cross-estate slug resolution (so the operator can actually name an agent brain
  in a different household — the headline goal the base's home-scoped resolver
  could not reach).

## Goals (from base, unchanged)

- Per-repo agent isolation with cross-repo recall via a common brain.
- Operator visibility into agent brains without granting cross-human access.
- No regression to any existing capture/retrieval path during rollout.

## Non-goals (from base, unchanged)

- Human-side multi-tenancy (federated identity, OIDC binding).
- Renaming `households` → `estates` at the DB level (cosmetic; tracked separately).
- Edit/delete of thought content; thought-audit (ADR-27).
- **Role-based write authorization** (deferred by decision; see §Why v24).
- Existence-hiding / enumeration-oracle resistance beyond `403` (deferred).

## Ground truth (verified against the current branch)

- Schema (`migrations/005`): `brain_memberships(principal_id, brain_id, role
  text not null)`; **no `estate_memberships`, no `is_deny`** (both net-new here).
  `role` has no CHECK/enum and is read by no code today (only `'owner'` is ever
  seeded, by `scripts/bootstrap-open-brain-household.sh`).
- `resolveAccessContext` (auth.mjs:367) resolves human → stored → legacy-admin,
  **denies inline with 403** during resolution, and hands handlers one
  `effectiveBrainId`. The human branch returns (auth.mjs:369) **before** any
  query/header selector is read (auth.mjs:378), so any selector the human path
  must honor needs new plumbing in `resolveHumanAccessContext`.
- Slug lookup is **home-household-scoped** (`resolveBrainBySlugForHousehold`,
  auth.mjs:106, called at :201-203 and :293). It cannot resolve a brain in a
  different household, so cross-estate operator visibility needs a new resolver.
- Read SQL is single-brain: `match_thoughts`, `list_recent_thoughts(target_brain_id)`,
  `thoughts_stats(target_brain_id)` (migration 005). Fan-out is app-level.
- MCP tool errors surface as `{isError:true}` tool results over HTTP **200**
  (server.mjs:143-160, 1180); only the REST routes return real HTTP status via
  `errorStatus` (server.mjs:171-179). `errorStatus` maps a plain `Error` → 500,
  so the metadata "Thought not found" path (server.mjs:645) is **500 today**.
- No schema has a `brain` field yet (server.mjs:29,41,50,55,66,92).

## Design

### D1. Access check — one flat helper, allow/deny, 403 on failure

A principal `P` has access to brain `B` iff, in order:

1. `brain_memberships(P, B, is_deny=false)` exists → **ALLOW**.
2. `brain_memberships(P, B, is_deny=true)` exists → **DENY**.
3. `B`'s estate `E` has `estate_memberships(P, E, is_deny=false)` → **ALLOW**.
4. otherwise → **DENY**.

Brain-level rows (1,2) override estate-level (3), per ADR-0001 point 2. There is
no estate-level deny (ADR: "absence is denial"). `legacy_admin_key` (env
`MCP_ACCESS_KEY`) is `isAdmin` and bypasses this check (global), unchanged.

`accessibleBrains(P)` = every brain that evaluates to ALLOW. This single set
drives read fan-out. Because `role` is not consulted (decision #2), **access ⇒
both read and write**; there is no separate write capability tier.

### D2. Status contract — 403-only for access; 404 only for genuine not-found

| Situation | Status |
|---|---|
| Brain access check returns DENY (exists, not accessible — incl. brain-deny override) | **403** |
| Selector resolves to **no brain at all** (bad slug/UUID) | **404** |
| Slug ambiguous within the lookup set | **409** (pass UUID) |
| Bad request shape (malformed body, missing required field) | **400** |

There is **no policy that converts an inaccessible-but-existing brain into 404.**
That was the reviewer-invented existence-hiding; it is gone.

**Surface note:** this table is HTTP status for the REST routes
(`/ingest/thought`, `/ask`, `/admin/thought/*`, `/mcp` handshake). For **MCP
tool calls**, the same conditions surface as a tool result `{success:false,
error, isError:true}` over HTTP 200 (the transport's contract). Acceptance rows
state which surface they target.

### D3. Brain selector — uniform across auth sources (ADR point 9)

`brain` (slug or UUID) may be supplied by route `:brainSlug`, query `?brain=`,
header `x-brain-slug` (the **L1** selectors, resolved in `resolveAccessContext`),
or **body/tool-arg** `brain` (resolved per-call in `resolveRequestBrain`).
Resolution, for any auth source:

1. **L1 selector** (if present) resolves and authorizes in `resolveAccessContext`,
   becoming the request's effective brain.
2. **Body/tool-arg `brain`** (if present) resolves and authorizes in
   `resolveRequestBrain`: blank/whitespace is treated as omitted; admins (env
   legacy key **or** stored `is_admin`) resolve **globally**; everyone else
   resolves across their **lookup set** (D5). Not found → **404**, ambiguous →
   **409**, resolves-but-denied (D1) → **403**.
3. **L1-vs-body agreement:** if both an L1 selector and a body `brain` are given
   and resolve to **different** brains → **400** (conflicting selectors). Equal
   is fine; body-only sets the brain; the deny/not-found checks run *before* the
   conflict check so they are never masked.

No per-auth-source admissibility rules, no "MCP can't switch per call" rule
(ADR point 9 explicitly allows per-call brain). Human tokens may pass a selector
like anyone.

**Known deferral:** a brain-bound stored key is restricted to its own brain at
the L1 layer but **not yet** at the body layer (`resolveRequestBrain` authorizes
by principal scope, not `key_brain_id`). No brain-bound key exists yet; tighten
this when one is provisioned. Stored `is_admin` keys resolving globally (like the
env key) is intentional and matches the only live key's shape.

### D4. Defaults when `brain` omitted (ADR points 10–11)

- **Write** (`capture_thought`/`/ingest/thought`,
  `update_thought_metadata`/`/admin/thought/metadata`): target exactly the
  **omitted-default brain** = `key.brain_id` for a brain-bound stored key, else
  `principal.default_brain_id` (matches the live resolver, auth.mjs:312-314). A
  write **never** fans out. Cross-brain write requires an explicit `brain`.
- **Read** (`search_thoughts`, `list_thoughts`, `ask_brain`, `stats`): span
  **`accessibleBrains(P)`**; fan out, merge, dedup. An explicit `brain` narrows
  to one.

### D5. Lookup set for slug/UUID resolution (cross-estate fix)

Resolution scope = the brains in `accessibleBrains(P)` **plus** the brains in any
estate where `P` has an `estate_membership` (so an operator can *name* an agent
brain that lives in a different household). Replace the home-household-scoped
`resolveBrainBySlugForHousehold` with a resolver over this set. For
`legacy_admin_key`, scope is global (unchanged, `resolveBrainBySlugGlobal`).
Ambiguity within the set → 409.

### D6. Multi-brain read response shape (ADR point 11)

Every read result row carries `brain_id` and `brain_slug`. `stats` and other
reads on an omitted `brain` always return a `per_brain: [{brain_id, brain_slug,
…}]` array **plus** an aggregate (even when `accessibleBrains` has one element,
so the shape never flips as memberships change). An explicit-`brain` read returns
the flat single-brain shape with the two fields added. Read fan-out merges
per-brain results and re-ranks by similarity (search/ask) or recency (list);
`match_count`/`threshold`/`recency_weight` apply per-brain pre-merge, then the
merged set is truncated to `match_count`. Fan-out iterates **`accessibleBrains`**
(never a wider "nameable" set), so brain-deny rows are excluded from default reads.

### D7. Legacy-admin no-regression

`MCP_ACCESS_KEY` keeps full global admin behavior, unchanged. Existing scripts
that send it bare keep hitting `resolveDefaultAdminBrain`'s brain. Repo
principals use a **separate** stored key in their `.envrc` (Phase 4); v24 does
**not** repoint `MCP_ACCESS_KEY`. Enrichment/backfill that must patch a
non-default brain passes explicit `brain` (now possible via D3).

## Phasing (each independently deployable; test-first)

### Phase 1 — Schema (migration 009)

```sql
create table if not exists estate_memberships (
  principal_id uuid not null references brain_principals(id) on delete cascade,
  estate_id    uuid not null references households(id) on delete cascade,
  role         text not null,            -- recorded, not enforced (see Non-goals)
  is_deny      boolean not null default false,  -- reserved; estate-deny is unused per ADR
  created_at   timestamptz not null default now(),
  primary key (principal_id, estate_id)
);
create index if not exists estate_memberships_estate_idx on estate_memberships (estate_id);

alter table brain_memberships
  add column if not exists is_deny boolean not null default false;
```

No code reads these yet. Safe to apply to prod. (`estate_id` column name is
forward-looking; FK targets `households(id)` until the rename.)

### Phase 2 — Resolver: estate-aware access + cross-estate selector

- Teach `loadPrincipalMemberships` (auth.mjs:65) and
  `resolveStoredAccessKeyContext` (auth.mjs:241) to also load `estate_memberships`
  and compute `accessibleBrains` per D1.
- Replace `resolveBrainBySlugForHousehold` calls (auth.mjs:201-203, 293) with the
  D5 lookup-set resolver.
- Teach `resolveHumanAccessContext` (auth.mjs:159) to read the selector
  (`explicitServiceBrainSlug` + route) so a human `?brain=`/`x-brain-slug`/body
  brain is honored, not silently dropped.
- `accessContext` gains `accessibleBrains: [{brainId, brainSlug}]`.
- Inaccessible → 403, not-found → 404 (D2). No 404 existence-hiding.

### Phase 3 — Selector + write paths on tools/HTTP

- Add optional `brain: z.string()` (slug or UUID) to the six schemas
  (server.mjs:29,41,50,55,66,92).
- Add `resolveRequestBrain(accessContext, brain, {mode})` (D3); route capture
  (server.mjs:312) and metadata (server.mjs:1085) through it. Access is the only
  gate (no role tier). A write with omitted `brain` uses D4's omitted-default.
- Convert the metadata "Thought not found" plain `Error` (server.mjs:645) to
  `HttpError(404, …)` so the REST route returns 404, not 500.
- Thread the resolved brain (not bare `accessContext.effectiveBrainId`) into the
  handlers so cross-brain explicit writes work.

### Phase 4 — Multi-brain reads + response shape (D6)

- search/list/ask/stats honor explicit `brain` (narrow) or fan out across
  `accessibleBrains` (parallel-and-merge in JS; the SQL stays single-brain).
- Tag rows with `brain_id`/`brain_slug`; emit `per_brain[]` + aggregate for
  omitted-brain reads.
- Telemetry: every read records `accessible_brain_count` and
  `searched_brain_count`; capture records the resolved `destination_brain_id`
  (restored from base).

### Phase 5 — Provisioning CLI (restored from base)

`scripts/agent_estate/provision.py <repo-slug>`, idempotent by slug:

1. Create the agent estate (singleton) if absent.
2. Create the common brain in the agent estate (singleton) if absent.
3. Create repo principal `<slug>` (`principal_type='agent'`) in the agent estate.
4. Create repo brain `<slug>` in the agent estate.
5. Set the repo principal's `default_brain_id` = repo brain.
6. Add `brain_memberships(repo-principal, repo-brain, role='owner')` and
   `brain_memberships(repo-principal, common-brain, role='member')`.
7. Generate a fresh access key, hash + store in `brain_access_keys` scoped to the
   principal (no `brain_id`). Print plaintext once. `rotate-key` subcommand for rotation.
8. First run also seeds `estate_memberships(luchoh, agent-estate, role='admin',
   is_deny=false)` — the operator-visibility row. Never touches the spouse estate.

### Phase 6 — Per-repo `.envrc` rollout (restored from base)

Per repo: add to `.envrc` (sourcing a gitignored `.env.local` per repo
convention) the repo principal's **stored** key (a `OB1_*`/`MCP_ACCESS_KEY`
value distinct from the legacy admin key — D7), plus `OPEN_BRAIN_BASE_URL`; run
`direnv allow`; confirm tools in that shell inherit the env.

### Phase 7 — Routing logic in the existing capture skills (ADR point 7)

Do **not** mint a standalone `agent-brain-routing` skill (the base's plan). The
two existing capture skills are the real write paths and the correct home; both
call `capture_thought` with no `brain` today.

**Canonical routing rule (the one place it is stated):** capture to the **common
brain** (`brain="agent-common"`) when the thought is a tool/technique/pattern,
a cross-project operator preference, or an environment/infra fact any agent
might need; otherwise omit `brain` (→ repo default brain). When in doubt: repo.
Reads: default (no `brain`) spans all accessible brains; pass `brain` only to scope.

- **`skills/autodream-brain-sync`** (already OB1-coupled — hardcodes
  `mcp__open-brain__capture_thought`): fold the rule in directly. Its existing
  memory-type prefix is the signal — `[project]` → repo (omit `brain`);
  `[user]`/`[feedback]`/`[reference]` about tooling/operator → `brain="agent-common"`.
  Add a "choose brain" step before the capture call.
- **`skills/auto-capture`** (deliberately client-agnostic): keep the core
  generic. Add one *optional* "OB1 brain routing" note that applies the canonical
  rule to ACT-NOW items (codebase-specific → repo; reusable technique → common)
  and is a no-op for non-OB1 deployments.

This preserves auto-capture's reusability while making routing real on the path
that is already OB1-specific. Ship any system-config changes via the doc-26 Nix
path. Acceptance: a `[project]` memory lands in the repo brain; a `[feedback]`
memory about tooling lands in `agent-common` (verified by `thoughts.brain_id`).

### Phase 8 — Migrate writers (incremental, restored from base)

Telegram bridge, FastAPI ingest, autodream-brain-sync keep working unchanged
(default-brain shim). Each may opt into explicit `brain` when useful. No forced
change.

## Acceptance (each row is an instance of D1/D2; surface noted)

### Resolver / access (Phase 2)

| auth | input | expect | surface |
|---|---|---|---|
| service_key (member of D,A) | `?brain=A` | 200, eff=A | REST |
| service_key | `?brain=<accessible UUID>` | 200 | REST |
| service_key | `?brain=<existing but inaccessible>` | **403** | REST |
| service_key | `?brain=<inaccessible UUID>` | **403** (no 404 downgrade) | REST |
| service_key | `?brain=<no such slug/uuid>` | 404 | REST |
| service_key (brain-deny on A, estate-allow) | `?brain=A` | **403** | REST |
| human_token | `?brain=A` (accessible) | 200, eff=A (selector honored, not dropped) | REST |
| operator (estate_membership over agent estate) | `POST /mcp/brains/<agent-repo-brain in other household>` | **200** (cross-estate resolve) | REST |
| legacy_admin | `?brain=<any existing global>` | 200, eff=that | REST |

### Writes (Phase 3)

| auth | route | brain | expect | surface |
|---|---|---|---|---|
| service_key (accessible A) | `/ingest/thought` | `A` | 200 → A | REST |
| service_key (no access to Z) | `/ingest/thought` | `Z` | 403, nothing written | REST |
| service_key (default D) | `/ingest/thought` | omitted | 200 → D only | REST |
| brain-bound key (key_brain=K) | capture | omitted | 200 → K (D4) | MCP isError=false |
| service_key (access A) | `/admin/thought/metadata`, thought in A | `A` | 200 | REST |
| service_key | `/admin/thought/metadata`, thought not in chosen brain | (any) | **404** (Error→HttpError) | REST |
| capture | tool-arg `brain=<no such>` | — | isError, "not found" | MCP |

### Reads (Phase 4)

| auth | tool | brain | expect |
|---|---|---|---|
| service_key (accessible {D,A}) | `search_thoughts` | omitted | 200, rows from D∪A, each tagged brain_id/slug |
| service_key (brain-deny on A) | `search_thoughts` | omitted | 200, rows from D only — **A excluded** |
| service_key | `search_thoughts` | `A` | 200, A only |
| service_key | `search_thoughts` | `<inaccessible>` | 403 |
| any | `stats` | omitted | 200, `per_brain[]` (even N=1) + aggregate |

### Provisioning / rollout (Phases 5–7)

- Migration 009 visible; `provision.py` idempotent (re-run = no dupes).
- Operator has `estate_memberships(luchoh, agent-estate, role='admin')`.
- From the OB1 shell, `echo $MCP_ACCESS_KEY` shows the repo key; a no-`brain`
  capture lands in the `ob1` brain.
- `skills/agent-brain-routing/SKILL.md` exists and ships.

## Definition of done

1. Migration 009 applied; `npm run check` + `./scripts/verify-open-brain-local.sh` green.
2. Every acceptance row above has a passing test, with REST vs MCP surface asserted correctly.
3. Existing bare-`MCP_ACCESS_KEY` smoke flow passes unchanged (D7).
4. Operator reads a repo-principal thought via estate membership; the spouse
   brain (no membership) returns **403** to that operator — proven by test.

## Open questions (explicitly deferred, not buried)

- **Role enforcement.** Deferred by decision. If/when wanted: add a role
  CHECK/enum in a migration, normalize existing rows (only `'owner'` exists
  today), and gate write/edit — as its own PRD.
- **ask_brain across many brains.** Fans out per D4; if synthesis quality
  degrades, scope its default to `default_brain_id` — decide with a real eval in
  Phase 4, not in prose.
- **Existence-hiding.** Deferred; current model discloses existence via 403 vs
  404 for genuine not-found. Revisit only if an enumeration threat becomes real.
- **household→estate rename** and **`move_thought`** tool: tracked separately.
</content>
