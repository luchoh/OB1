# Sysadmin Handoff: Bump production OB1 to `d3b7f9b`

Date: 2026-06-12
Status: Awaiting system-config implementation
Owner: System-config (Nix pin bump only — no DB work)
Companion: PRD `34-architecture-deepening-prd.md` (module 2), docs/35
(previous bump), docs/32 (D9: wire shapes are law)

## Summary

Bump prod to `d3b7f9b37c3a84d2c9b152067e6bde0f65a4afbd` (current
`master` tip, pushed). **Code-only. No migrations** (prod has 001–012;
nothing new shipped). **No behavior change by design**: this bump is
the Thought-store refactor — every wire response is byte-identical to
what prod serves today, verified by 21/21 acceptance tests including
three new pins on the delete/restore/purge response shapes.

What ships: the Thought lifecycle (capture, metadata patch, delete,
restore, purge, stats, graph re-hydration reads) now lives in one
module, `src/thought-store.mjs`, with audit emission, idempotency, and
soft-delete invisibility as internal guarantees. `server.mjs` shrank by
~400 lines; lifecycle SQL exists in exactly one file.

## ⚠️ First: close the pin drift from the previous bump

Prod behaviorally runs `9f2d6ab` (verified 2026-06-12: the post-deploy
acceptance run passed delta tests impossible on older code), but every
committed copy of `system-config/hosts/m2maxstudio.nix` still declares
`d2d101f` (latest pin commit: `29c2897`). The 9f2d6ab deploy went out
through uncommitted state. **A rebuild from committed config today
would silently roll prod back to pre-policy authorization.**

This bump is the opportunity to close that: set the pin to `d3b7f9b`
**and commit it** in system-config, restoring declared = actual.

## What's in this revision range

`git log --oneline 9f2d6ab..d3b7f9b` (3 commits):

| Commit | Subject | Touches prod? |
|--------|---------|---------------|
| `d3b7f9b` | feat(thought-store): module 2 Stage 2 — handlers rewired onto the store | **YES — server.mjs, retrieval.mjs, package.json** |
| `0b56b39` | feat(thought-store): module 2 Stage 1 — lifecycle store + 17-test DB suite | **YES — src/thought-store.mjs (new)** |
| `1ea2083` | docs(deploy): prod pin-bump handoff for the access-policy rollout | docs only |

(`test/` and `tests/` changes ride along but are not exercised by the
service.)

## Order of operations

### 1. Pre-flight (read-only)

```
curl -sS http://127.0.0.1:8788/health | jq .status   # "healthy"
```

No data preconditions — this bump changes no authorization or
data-visibility behavior.

### 2. Bump the pin — and commit it

In `system-config/hosts/m2maxstudio.nix` (lines ~99–100):

```
ob1StablePinnedBranch   = "master";
ob1StablePinnedRevision = "d3b7f9b37c3a84d2c9b152067e6bde0f65a4afbd";
```

Rebuild via the normal pipeline; `open-brain-local` restarts
automatically. **Commit the nix change** (this also retroactively
documents the 9f2d6ab deploy in the history — note both in the commit
message).

### 3. Post-deploy verification

The fresh boot itself is a real check this time: it proves the rewired
`server.mjs` resolves its `thought-store.mjs` imports cold (the dev
runtime only ever hot-reloaded it).

```
# a. Service is up and healthy after restart:
curl -sS http://127.0.0.1:8788/health | jq .status

# b. Full acceptance suite against prod (house precedent; seeds
#    zzt-acc-* fixtures, cascade-cleans):
OPEN_BRAIN_BASE_URL=http://10.10.10.100:8788 PGDATABASE=ob1 \
  python3 -m unittest tests.test_agent_estate
```

Expected: 21/21 — the 3 new tests round-trip delete→restore (both
idempotency shapes) and pin purge's `graph_purged` + confirmation-409
against the live store path.

## Rollback

Re-pin `9f2d6ab28ab7f84acd82669d13cb40070722d064` and rebuild. No
migrations, no data changes; the range is forward-only on master.

## Out of scope

- PRD-34 module 3 (graph split + projection planner) — next in
  development, not in this bump.
- Legacy env key retirement (unchanged status).

## Questions for the operator

None blocking.
