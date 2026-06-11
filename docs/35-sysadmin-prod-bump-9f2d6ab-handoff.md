# Sysadmin Handoff: Bump production OB1 to `9f2d6ab`

Date: 2026-06-12
Status: Awaiting system-config implementation
Owner: System-config (Nix pin bump only — no DB work)
Companion: PRD `34-architecture-deepening-prd.md`, ADR-0002, ADR-0003

## Summary

Bump the Nix pin in `system-config/hosts/m2maxstudio.nix` from
`d2d101f8cf6a64d34909562bd3f17a41b053919a` (current prod, verified
2026-06-12 against the file and prod's applied migrations) to
`9f2d6ab` (current `master` tip, pushed to origin).

**Code-only bump. No new migrations** — prod already has 001–012
applied (verified 2026-06-12 via `open_brain_schema_migrations`).
No data changes, no schema changes, no wire-contract changes.

What ships: the Access policy module. Authorization decisions move out
of SQL-in-`auth.mjs` into the pure `src/access-policy.mjs` (73-test
suite), with `auth.mjs` reduced to a fetch-and-map adapter. Seven
deliberate behavior deltas land (ADR-0002 role ladder, ADR-0003
estate-bound reach) — all verified non-breaking for every caller that
exists in prod today (see "Effect on live prod callers").

## What's in this revision range

`git log --oneline d2d101f..9f2d6ab` (3 commits):

| Commit | Subject | Touches prod? |
|--------|---------|---------------|
| `9f2d6ab` | feat(access-policy): Stage 2 — auth.mjs rewired onto the policy module | **YES — auth.mjs, server.mjs** |
| `5f24284` | feat(access-policy): Stage 1 — pure decision module + 73-test suite | **YES — src/access-policy.mjs (new), package.json** |
| `ffc9706` | docs(architecture): deepening PRD + ADR-0002/0003 + CONTEXT.md terms | docs only |

## Behavior deltas (ADR-0002 / ADR-0003)

Each is pinned by an acceptance test in `tests/test_agent_estate.py`
(suite is 18/18 against dev, 2026-06-11):

1. `viewer` brain role and `member` estate role are now **read-only**
   (writes 403; reads unchanged).
2. The metadata-patch path (`/admin/thought/metadata` + MCP tool) is
   now write-gated like capture.
3. A stored admin key's body-arg reach is **home estate ∪ memberships**
   (was: global, any estate).
4. A stored admin key's L1 (query/header) naming **widens** to its
   membership-derived cross-estate brains (previously 404).
5. The brain-bound-key naming clamp is retired — a key's `brain_id` is
   a default-brain hint only.
6. A brain-level DENY row now clamps **every** caller shape, stored
   admin keys included.
7. Capture is explicitly write-gated (previously no role check on any
   write path).

The bare legacy env key (`MCP_ACCESS_KEY`) is **unchanged**: global
reach, full CRUD, never purge.

## Effect on live prod callers (verified against prod data, 2026-06-11)

Prod memberships: 4× brain `owner`, 2× brain `editor`, 1× estate
`admin` (operator on the agent estate). Zero `viewer`, zero `member`,
zero DENY rows.

- `infra`, `system-config` repo keys (editor/owner): writes still
  allowed — **no change**.
- `luchoh` stored admin key: home-estate reach unchanged; agent-estate
  reach still granted via the estate-admin membership; ambient reach
  into any *future* third estate disappears (that is the point of
  ADR-0003) — **no change for anything in use**. Bonus: L1-naming
  agent-estate brains now resolves (used to 404).
- Telegram bridge / enrichment / backfills (legacy env key): **no
  change**.

## Order of operations

### 1. Pre-flight (read-only)

```
# roles still within the verified set; no deny rows appeared since 2026-06-11
PGDATABASE=ob1 psql -tA -c "select role, is_deny, count(*) from brain_memberships group by 1,2;
select role, is_deny, count(*) from estate_memberships group by 1,2;"
```

Expected: only `owner|f`, `editor|f` brain rows and `admin|f` estate
rows. If a `viewer`/`member`/deny row exists, STOP and check who it
belongs to against the deltas above before proceeding.

```
curl -sS http://127.0.0.1:8788/health | jq .status   # "healthy"
```

### 2. Bump the Nix pin

In `system-config/hosts/m2maxstudio.nix` (lines ~99–100):

```
ob1StablePinnedBranch   = "master";
ob1StablePinnedRevision = "<full SHA of 9f2d6ab>";   # git -C ~/Dev/OB1 rev-parse master
```

Rebuild via the normal pipeline; `open-brain-local` restarts
automatically. No migration step.

### 3. Post-deploy verification

Zero-fixture spot checks (existing prod data only):

```
# a. editor key still writes (delta 1 non-breakage):
#    capture via the system-config key -> expect 201; clean up after.
# b. admin L1 widening (delta 4): luchoh admin key, L1-name an
#    agent-estate brain -> expect resolution (was 404 before the bump):
curl -sS "http://127.0.0.1:8788/mcp/brains/agent-common" -H "x-access-key: $LUCHOH_ADMIN_KEY" ...
# c. legacy key unchanged: any existing smoke flow with MCP_ACCESS_KEY.
```

Full check (house precedent — the v24 suite ran against prod):

```
OPEN_BRAIN_BASE_URL=http://10.10.10.100:8788 PGDATABASE=ob1 \
  python3 -m unittest tests.test_agent_estate
```

18 tests; seeds `zzt-acc-*` fixtures and cascade-cleans them.

## Rollback

Re-pin `d2d101f8cf6a64d34909562bd3f17a41b053919a` and rebuild. Nothing
else: no migrations shipped, no data was touched, and the commit range
is forward-only on master. The old code ignores `access-policy.mjs`
entirely.

## Out of scope

- Legacy env key retirement (separate roadmap item, gated on
  provisioning a named ops admin key).
- PRD-34 module 2 (Thought store + soft-delete visibility seam) — next
  on the development sequence, not in this bump.

## Questions for the operator

None blocking.
