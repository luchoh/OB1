# Sysadmin Handoff: Bump production OB1 to release `0.4.0`

Date: 2026-06-12
Status: Awaiting system-config implementation
Owner: System-config (Nix pin bump; launchd services restart via rebuild)
Companion: PRD `34-architecture-deepening-prd.md` (module 4 + closeout),
docs/16 (telegram service contract), docs/37 (previous bump)

## Summary

Bump the pin to **release tag `0.4.0`** =
`fae7d1d2a2e119c9a3a18aae57d08b73ce77b134`. First release cut with the
re-established git flow (master = releases, develop = integration), so
from now on prod pins always land on tagged release merges.

**One bump deploys two different things this time:**

1. **The runtime (`ob1-stable`): a no-op.** Zero runtime code changed
   since `2df3a96` (currently live) — only the package version string
   (0.1.0 → 0.4.0). The service will restart and behave identically.
2. **The Python ingest services: the real payload.** Module 4 (Capture
   client) shipped: `telegram_bridge.py`, `import-dictation.py`, and
   `shared_docling.py` (used by imap-watch / document import) are now
   adapters over `recipes/shared_capture.py`. Every launchd service
   under `ob1ManagedCurrentRoot` — telegram-bridge(s),
   dictation-import(s), imap-watch — picks this up because the rebuild
   rewrites their store paths and restarts them.

**No migrations. No wire-payload changes** — payload equivalence was
proven with goldens green against both the old builders and the new
adapters (full-dict equality, 9 payloads). The deliberate deltas, all
ratified:

- telegram / dictation / chat-export captures gain **2 retries** on
  5xx + connection errors (was: a momentary server blip lost the
  capture). Safe: capture is a `(brain_id, dedupe_key)` upsert, so a
  replayed POST cannot double-write.
- docling-path ingest timeout 240s → 300s (uniform).
- Capture failures raise a canonical `CaptureError` (a `RuntimeError`
  subclass — existing handlers still catch; only message wording
  changes in logs).

## What's in this revision range

`git log --oneline 2df3a96..0.4.0` (5 commits):

| Commit | Subject | Deployed effect |
|--------|---------|-----------------|
| `fae7d1d` | Merge branch 'release/0.4.0' | the release point |
| `24b6ee8` | chore(release): bump to 0.4.0 | version string only |
| `1bb2e40` | docs(prd): PRD-34 closeout | docs only |
| `2cd7ed7` | feat(capture-client): module 4 | **telegram bridge, dictation, imap/docling path** |
| `9af558c` | docs(deploy): handoff 37 | docs only |

## Order of operations

### 1. Pre-flight (read-only)

```
curl -sS http://127.0.0.1:8788/health | jq .status     # "healthy"
# bridge currently alive? (label per your launchd setup)
launchctl list | grep -i ob1
```

### 2. Bump the pin — and commit it

In `system-config/hosts/m2maxstudio.nix`:

```
ob1StablePinnedBranch   = "master";
ob1StablePinnedRevision = "fae7d1d2a2e119c9a3a18aae57d08b73ce77b134";  # tag 0.4.0
```

Rebuild via the normal pipeline. The changed source root restarts
`ob1-stable` **and** the Python ingest services. Commit the nix change
(pin discipline per docs/37 — declared = actual).

### 3. Post-deploy verification

```
# a. Runtime healthy (identical code, fresh boot):
curl -sS http://127.0.0.1:8788/health | jq .status

# b. Telegram bridge end-to-end — the real test of module 4:
#    send a normal text message to the capture bot. Expect the usual
#    review-flow reply; approve it; confirm the thought landed:
#    search_thoughts for a phrase from the message (or check the
#    bridge's --verbose log for the 201 capture line).

# c. Bridge log shows a clean start (no ImportError — the new
#    cross-module import recipes/shared_capture is the one new
#    startup dependency):
tail -50 <bridge log path> | grep -iE "error|traceback" || echo clean

# d. Dictation / imap-watch: nothing to do actively — confirm their
#    next scheduled run logs cleanly (same import consideration).
```

Optional belt-and-braces: the acceptance suite against prod
(`OPEN_BRAIN_BASE_URL=http://10.10.10.100:8788 PGDATABASE=ob1 python3
-m unittest tests.test_agent_estate`) — expected 21/21, unchanged.

### 4. If a service won't start

The only plausible failure mode is Python import resolution in a
service's environment (the new `from recipes.shared_capture import …`).
Each worker script bootstraps `sys.path` from its own file location, so
this should be unreachable — but if a bridge/dictation service
crash-loops with `ModuleNotFoundError: recipes`, capture the log and
roll back rather than patching live.

## Rollback

Re-pin `2df3a96c62b380d1421ca5923a6008c434dcf402` and rebuild — returns
every service to today's exact code. No data or schema involved.

## Workflow note (new, from this release on)

Git flow is re-established: day-to-day commits land on `develop`;
`master` only moves via `git flow release finish` (tagged merge).
Prod pins should target release tags from now on. This document lives
on `develop` and reaches `master` with the next release.

## Questions for the operator

None blocking.
