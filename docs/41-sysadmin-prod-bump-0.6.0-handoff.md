# Sysadmin Handoff: Bump production OB1 to release `0.6.0`

Date: 2026-06-14
Status: STAGED — release cut + pushed; awaiting read-only pre-flight, then a window
Owner: System-config (release-tag pin bump; ob1-stable rebuild auto-applies migrations)
Companion: docs/40 (previous bump, 0.5.0 / migrations 013+014), docs/39 (PRD),
docs/33 (migration rollout pattern)

## Summary

Bump the prod pin to **release tag `0.6.0`** =
`e6083486b93827f6b93f0bcabbf90e2adb96d85e` (master HEAD). One bump, three
things — but the runtime itself is a near-no-op:

1. **The runtime (`ob1-stable`): effectively a no-op.** The new `src/` modules
   in this release (`reconciliation-decision.mjs`, `calibration-*.mjs`) are
   **standalone and NOT imported by the runtime** — the decision core is unused
   (Package 3 reconciliation is shelved) and the calibration files are manual
   scripts. The MCP server behaves identically, *except* for the retrieval
   change that arrives via migration 015 (below).
2. **The schema: migration 015** the ob1-stable wrapper auto-applies (in order,
   own transaction, `PGUSER=postgres`, `ON_ERROR_STOP=1`):
   - `015_exclude_conversation_records_from_reads.sql` — redefines the five
     ranked read functions (`match_thoughts`, `match_thoughts_recency`,
     `search_thoughts_text`, `list_recent_thoughts`, `get_thought_connections`)
     to EXCLUDE the content-free `*_conversation_record` pointer thoughts
     (`metadata->>'type' in ('chatgpt_conversation_record',
     'claude_conversation_record')`). Bodies copied verbatim from live 013/011;
     only the exclusion predicate is added (STABLE, parallel-safe,
     statement_timeout, security definer all preserved). Five
     `CREATE OR REPLACE FUNCTION` — brief catalog locks, online-safe, fast (no
     table rewrite, no index rebuild).
3. **The Python ingest path: the VLM-fallback mojibake fix** (commit `b31b17a`,
   `recipes/shared_docling.py` + `import-imap.py`). The imap-watch / docling
   ingest services pick this up on rebuild (their store paths are rewritten and
   they restart). It prevents recurrence of the 2026-03-15 Cyrillic-scan
   mojibake (a strictly-worse granite-VLM fallback is no longer accepted, and
   identical chunk texts are deduped per attachment).

**Observable behavior change to expect (intended):** after 015, ranked
retrieval (ask-brain seed, search, recent listing, connections) stops returning
the **1,587 content-free `*_conversation_record` pointer thoughts** (27% of the
`luchoh` corpus). Search/recent result *counts* visibly drop — this is the
point: those rows are title+date+UUID boilerplate, not content. The rows are
KEPT (their `user_metadata.raw_export_json` is the only lossless copy of the raw
conversations) and `thoughts_stats` still counts them; they are only excluded
from *ranked retrieval*.

## What's in this revision range

`git log --oneline 0.5.0..0.6.0` (non-merge):

| Commit | Subject | Deployed effect |
|--------|---------|-----------------|
| `bbf6f3b` | chore(release): bump to 0.6.0 | version string only |
| `56d080b` | calibration sampler record-exclusion | dev tooling, no prod effect |
| `fb4893c` | **migration 015 — exclude conversation_record from reads** | **retrieval behavior change (auto-applied)** |
| `90c0066` | calibration re-measure tool | dev tooling, no prod effect |
| `78b6179` | calibration eval-harness | dev tooling, no prod effect |
| `2b9033d` | reconciliation decision core (pure) | new src module, NOT runtime-wired |
| `d501d7a` | docs(agents): brain reflex | docs only |
| `037c9a7` | docs(agents): estate-scope OB1 | docs + repo `.envrc` (dev direnv only) |
| `b31b17a` | **fix(ingest): VLM fallback guard + chunk dedupe** | **imap-watch / docling ingest** |

## Deploy mechanism (per docs/33/40, verified there)

`modules/ob1-stable/default.nix` + `scripts/apply-open-brain-local-migrations.sh`:
bump `ob1StablePinnedRevision` in `system-config/hosts/m2maxstudio.nix` →
`darwin-rebuild switch` → ob1-managed-source fetches `luchoh/OB1@<rev>` → the
wrapper kills the old service, `npm install`, **applies pending migrations**,
restarts the runtime. The module-4 ingest services (imap-watch, telegram,
dictation) are rebuilt and restart, picking up the recipes change. The migration
window is tiny here (one catalog-only migration, no rebuild).

## Pre-flight (read-only against prod `ob1` — run before the window)

```
# a. 015 is the only pending migration (013/014 already applied 2026-06-12):
psql "$PROD" -c "select name from open_brain_schema_migrations order by name;"

# b. The record pointers that 015 will hide are present (~1,587 expected):
psql "$PROD" -c "select count(*) from thoughts
                  where deleted_at is null
                    and metadata->>'type' in ('chatgpt_conversation_record','claude_conversation_record');"

# c. Function ownership = postgres (so the managed PGUSER can REPLACE them):
psql "$PROD" -c "select proname, pg_get_userbyid(proowner) owner from pg_proc
                  where proname='match_thoughts';"
```

Both migration 015 and the suite were verified on `ob1_dev`: **156/156 tests
green**, all five functions remain `STABLE`, and a record fixture is absent from
every ranked read while non-records remain and `thoughts_stats` still counts it.

## One-way door: NONE

Rollback is clean. 015 is `CREATE OR REPLACE` with unchanged signatures, so the
old runtime calls the functions identically; the record-exclusion is transparent
to callers and forward-compatible. Re-pinning the prior revision reverts code;
the applied 015 functions persist harmlessly (they just keep excluding
content-free pointers). The ingest fix is pure Python logic — no schema, no data
change. No capture-breaking change.

## Runbook

1. Run pre-flight (above); confirm 015 pending and the record count.
2. Low-traffic window (single-user; brief outage acceptable).
3. Bump the pin in `system-config/hosts/m2maxstudio.nix`:
   ```
   ob1StablePinnedBranch   = "master";
   ob1StablePinnedRevision = "e6083486b93827f6b93f0bcabbf90e2adb96d85e";  # tag 0.6.0
   ```
   Commit the nix change (pin discipline: declared = actual).
4. `darwin-rebuild switch` on m2maxstudio. Watch the ob1-stable log:
   "Applying stable OB1 migrations" → `015` → runtime start.
5. POST-DEPLOY VERIFY (below).
6. If a migration FAILS: the service stays down. Roll FORWARD — read the log,
   fix, re-run `darwin-rebuild` (the runner skips already-applied migrations).

## Post-deploy verification (prod)

```
# a. Runtime healthy:
curl -sS http://127.0.0.1:8788/health | jq .status      # "healthy"

# b. Migration recorded:
psql "$PROD" -c "select name from open_brain_schema_migrations
                  where name = '015_exclude_conversation_records_from_reads.sql';"

# c. Record pointers excluded from ranked reads (expect 0):
psql "$PROD" -c "select count(*) from list_recent_thoughts(
                   (select id from brains where slug='luchoh'), 500) r
                  join thoughts t on t.id = r.id
                  where t.metadata->>'type' like '%_conversation_record';"

# d. ask-brain / search a known phrase — confirm no contentless
#    'Canonical raw export record' pointer appears in results.

# e. imap-watch: confirm its next scheduled run logs cleanly (the new
#    recipes/shared_docling guard is the one ingest-path change).
```

## Rollback

Re-pin the prior revision (current prod pin) and rebuild — returns the runtime
to today's code. The 015 function redefinitions persist and are
forward-compatible (see One-way door); no schema rollback needed.

## Questions for the operator

- Confirm the prod pin currently live (the rollback target) before bumping.
- The result-count drop in search/recent after 015 is expected (1,587 pointers
  hidden) — not a regression. Flag if any downstream consumer counted on those
  rows appearing.
