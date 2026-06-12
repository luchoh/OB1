# Sysadmin Handoff: Bump production OB1 to `2df3a96` (combined: modules 2+3)

Date: 2026-06-12
Status: Awaiting system-config implementation
Owner: System-config (Nix pin bump only — no DB work)
Companion: PRD `34-architecture-deepening-prd.md` (modules 2 and 3);
**supersedes docs/36** (never executed — this bump takes its range plus
module 3)

## Summary

Bump prod to `2df3a96c62b380d1421ca5923a6008c434dcf402` (current
`master` tip, pushed). **Code-only. No migrations** (prod has 001–012;
nothing new shipped). **No behavior change by design** — both modules
are refactors:

- **Module 2 (Thought store)**: the Thought lifecycle (capture,
  metadata patch, delete, restore, purge, stats) moved into
  `src/thought-store.mjs`; wire responses byte-identical, pinned by
  21 acceptance tests including delete/restore/purge shapes.
- **Module 3 (graph split)**: `graph.mjs` (2,504 lines) became a
  42-line facade over `graph-driver` / `graph-reads` /
  `graph-projection` plus the pure `projection-planner`. Read
  semantics unchanged (verified by function-level diff: the read
  bodies are identical modulo the scrubbing call's relocation to a
  single seam); the projector produces the same plans (planner is a
  verbatim extraction, 25 plan-level tests + live dev round-trip).

**Why this bump matters despite "no behavior change": the fresh boot
is the cold-import proof.** The dev runtime process predates both
rewires (no hot reload — plain `node src/index.mjs`), so no server
anywhere has cold-booted the new module graph yet. The restart that
comes with this bump is the first.

## ⚠️ Still open: the pin drift (carried from docs/35-36)

Prod behaviorally runs `9f2d6ab` (verified 2026-06-12 via delta tests
impossible on older code), but every committed copy of
`system-config/hosts/m2maxstudio.nix` still declares `d2d101f`
(latest pin commit `29c2897`). **A rebuild from committed config
today rolls prod back to pre-access-policy authorization, silently.**
Set the pin to `2df3a96` and **commit it**, noting both the 9f2d6ab
deploy and this one in the message — declared state finally equals
actual.

## What's in this revision range

`git log --oneline 9f2d6ab..2df3a96` (7 commits, 4 substantive):

| Commit | Subject | Touches prod? |
|--------|---------|---------------|
| `2df3a96` | feat(graph): module 3 Stage 2 — split + rewire | **YES — graph*.mjs, retrieval.mjs, package.json** |
| `cb6bb51` | docs(prd): ratified read-only SQL exceptions | docs only |
| `3c91df6` | feat(projection-planner): module 3 Stage 1 | **YES — src/projection-planner.mjs (new)** |
| `178ee12` | docs(deploy): handoff 36 | docs only |
| `d3b7f9b` | feat(thought-store): module 2 Stage 2 — rewire | **YES — server.mjs, retrieval.mjs, package.json** |
| `0b56b39` | feat(thought-store): module 2 Stage 1 | **YES — src/thought-store.mjs (new)** |
| `1ea2083` | docs(deploy): handoff 35 | docs only |

## Order of operations

### 0. Recommended rehearsal: restart dev first

The dev runtime (same host, `:8787`) is serving pre-module-2 code.
Restart it (`devenv up open_brain_local` path), then run the
acceptance suite against dev:

```
OPEN_BRAIN_BASE_URL=http://localhost:8787 python3 -m unittest tests.test_agent_estate
```

21/21 on a fresh dev boot = the exact code path prod is about to take,
rehearsed with zero stakes.

### 1. Pre-flight (read-only)

```
curl -sS http://127.0.0.1:8788/health | jq .status   # "healthy"
```

No data preconditions — no authorization or visibility changes ship.

### 2. Bump the pin — and commit it

In `system-config/hosts/m2maxstudio.nix` (lines ~99–100):

```
ob1StablePinnedBranch   = "master";
ob1StablePinnedRevision = "2df3a96c62b380d1421ca5923a6008c434dcf402";
```

Rebuild; `open-brain-local` restarts. No migration step. Commit the
nix change.

### 3. Post-deploy verification

```
# a. Healthy fresh boot (= every new module's imports resolved cold):
curl -sS http://127.0.0.1:8788/health | jq .status

# b. Full acceptance suite against prod (seeds zzt-acc-* fixtures,
#    cascade-cleans):
OPEN_BRAIN_BASE_URL=http://10.10.10.100:8788 PGDATABASE=ob1 \
  python3 -m unittest tests.test_agent_estate

# c. Graph subsystem spot check (acceptance doesn't cover /graph/*):
#    pick any live prod thought id, then with an admin-capable key:
curl -sS -X POST http://127.0.0.1:8788/graph/neighbors \
  -H "content-type: application/json" -H "x-access-key: $KEY" \
  -d '{"thought_id":"<id>"}' | jq '.center != null'
```

Expected: healthy; 21/21; `true`. The projector loop restarts with the
service — `/admin/graph/*` stats or the projector log lines confirm it
is projecting (it runs the new planner path).

## Rollback

Re-pin `9f2d6ab28ab7f84acd82669d13cb40070722d064` and rebuild. No
migrations, no data changes; forward-only range. (Rolling back further
than 9f2d6ab would also revert the access-policy authorization — don't,
without a fresh decision.)

## Out of scope

- PRD-34 module 4 (Capture client, Python pipelines) — next in
  development; pipeline code is not deployed by the Nix derivation
  anyway.
- Legacy env key retirement (unchanged status).

## Questions for the operator

None blocking.
