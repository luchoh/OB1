# Sysadmin Handoff: Bump production OB1 for PRD-39 packages 1–2

Date: 2026-06-12
Status: STAGED — awaiting release cut + read-only pre-flight, then a window
Owner: System-config (release-tag pin bump; ob1-stable rebuild auto-applies
migrations)
Companion: PRD `39-semantic-reconciliation-prd.md`, docs/33 (migration
rollout pattern), docs/38 (previous bump, 0.4.0)

## Summary

Ships **PRD-39 packages 1 and 2** to prod `ob1` on m2maxstudio. One bump,
but the runtime and the schema split cleanly:

1. **The runtime (`ob1-stable`): a no-op.** The only source change since
   `0.4.0` is the new `src/similarity-probe.mjs`, which **nothing in the
   runtime imports** — it is a manual, read-only CLI tool. The service
   restarts and behaves identically.
2. **The schema: the real payload — two fast, low-risk migrations** the
   ob1-stable deploy wrapper auto-applies (in order, each in its own
   transaction, as `PGUSER=postgres`, `ON_ERROR_STOP=1`):
   - `013_retrieval_sql_correctness.sql` — `CREATE OR REPLACE` of the five
     defect-carrying read functions (`match_thoughts`, `search_thoughts_text`,
     `get_thought_connections`, `list_recent_thoughts`, `thoughts_stats`):
     marks them `STABLE`, rewrites search's `NOT IN (subquery)` as
     `NOT EXISTS`, and aligns its rank fallbacks to the column defaults
     (`importance` 5→3, `quality_score` 0.50→50). Bodies copied verbatim from
     `011`, so the `deleted_at` guards, `statement_timeout`, and
     `security definer`/`search_path` are preserved.
   - `014_drop_legacy_single_tenant_reads.sql` — `DROP FUNCTION IF EXISTS`
     the three dead single-tenant overloads left by `001`
     (`match_thoughts`/4-arg, `list_recent_thoughts`/2-arg, `thoughts_stats`/
     0-arg). They had no brain scoping and no `deleted_at` guard — a latent
     cross-brain + tombstone leak (ADR-0003) one stray caller away. Every
     live caller uses the brain-scoped signatures, so this removes dead code.

**No table rewrites, no index rebuilds.** Unlike the soft-delete rollout
(docs/33, which rebuilt the HNSW index under ACCESS EXCLUSIVE — the long
pole), `013`/`014` take only brief catalog locks. Sub-second at prod scale.

**Package 3 (reconciliation at capture) is NOT in this bump** — it is gated
on the similarity-probe report and remains deferred. Its schema migration is
reserved as the next free number (`015`).

## Prerequisite: cut release `0.5.0` first

Per the git-flow rule (re-established at 0.4.0: prod pins target tagged
release merges), the payload on `develop` @ `77adba8` must be released before
prod is pinned to it. In the OB1 repo:

```
git flow release start 0.5.0
# bump package version 0.4.0 -> 0.5.0 in local/open-brain-mcp/package.json
git flow release finish 0.5.0      # tagged merge develop -> master
git push origin master develop --tags
```

The pin below then targets tag `0.5.0` (fill its merge-commit SHA once cut).

## What's in this revision range

`git log --oneline 0.4.0..develop`:

| Commit | Subject | Deployed effect |
|--------|---------|-----------------|
| `77adba8` | feat(retrieval): PRD-39 packages 1-2 | **migrations 013 + 014**; runtime no-op (new unused CLI tool); docs/tests |
| `e9a7ef3` | docs(prd): PRD-39 retrieval + reconciliation | docs only |

(Plus the PRD edits folded into `77adba8`. The probe tool, its tests, and the
migration tests are dev/CI artifacts — no prod effect.)

## Deploy mechanism (per docs/33, verified there)

`modules/ob1-stable/default.nix` + `scripts/apply-open-brain-local-migrations.sh`:
bump `ob1StablePinnedRevision` in `system-config/hosts/m2maxstudio.nix` →
`darwin-rebuild switch` on m2 → ob1-managed-source fetches `luchoh/OB1@<rev>`
→ the wrapper kills the old service, `npm install`, **applies pending
migrations**, then starts the new runtime.

Consequence: the service is briefly DOWN during migration. Here that window is
tiny (two catalog-only migrations, no rebuild). A migration failure leaves the
service stopped (fail = outage, not silent skip) — pre-flight exists to prevent
that.

## Pre-flight (read-only against prod `ob1` — RUN BEFORE THE WINDOW)

Not yet run from this session (config points at dev; prod untouched). Operator
to run and confirm:

```
# a. 013/014 are the only pending migrations (expect 001..012 present):
psql "$PROD" -c "select name from open_brain_schema_migrations order by name;"

# b. The legacy overloads 014 drops actually exist (informational — IF EXISTS
#    makes the drop a safe no-op either way). Expect three 'NO' (unscoped) rows
#    alongside their brain-scoped siblings:
psql "$PROD" -c "select proname,
       case when pg_get_function_identity_arguments(oid) like 'target_brain_id uuid%'
            then 'scoped' else 'LEGACY' end as kind,
       pg_get_function_identity_arguments(oid) as args
  from pg_proc
 where proname in ('match_thoughts','list_recent_thoughts','thoughts_stats')
 order by proname, kind;"

# c. Blast radius of the rank-fallback fix: rows with NULL importance/quality
#    re-rank (only via search_thoughts_text, the dormant lexical path). Count
#    them so the change is a known quantity, not a surprise:
psql "$PROD" -c "select count(*) filter (where importance is null) as null_importance,
                        count(*) filter (where quality_score is null) as null_quality
                   from thoughts where deleted_at is null;"

# d. Function ownership = postgres (so the managed PGUSER=postgres can REPLACE
#    and DROP them):
psql "$PROD" -c "select proname, pg_get_userbyid(proowner) as owner from pg_proc
                  where proname in ('match_thoughts','thoughts_stats');"
```

Both migrations were applied and verified on `ob1_dev`; full suite 133/133.

## One-way door: NONE (unlike docs/33)

Rollback is clean. The redefined `013` functions keep their exact signatures,
so the OLD runtime calls them unchanged — `STABLE` and the `NOT EXISTS`/rank
fixes are transparent to callers. `014` only drops functions nothing calls.
Re-pinning the prior revision reverts code safely; the applied migrations
persist (the runner records them) and remain forward-compatible with the old
code. There is no capture-breaking schema change here.

## Runbook

1. Cut release `0.5.0` (see Prerequisite); note the tag's merge-commit SHA.
2. Run pre-flight (above); confirm a/c/d are sane. A `pg_dump` of `thoughts`
   is cheap insurance though nothing here is destructive.
3. Pick a low-traffic window (single-user; brief outage acceptable).
4. Bump the pin in `system-config/hosts/m2maxstudio.nix`:
   ```
   ob1StablePinnedBranch   = "master";
   ob1StablePinnedRevision = "<0.5.0 merge-commit SHA>";  # tag 0.5.0
   ```
   Commit the nix change (pin discipline: declared = actual).
5. Deploy: `darwin-rebuild switch` on m2maxstudio. Watch the ob1-stable log:
   "Applying stable OB1 migrations" → `013` → `014` → runtime start.
6. POST-DEPLOY VERIFY (prod) — see next section.
7. If a migration FAILS: the service stays down. Roll FORWARD — read the log,
   fix, re-run `darwin-rebuild` (the runner skips already-applied migrations).

## Post-deploy verification (prod)

```
# a. Runtime healthy (identical code, fresh boot):
curl -sS http://127.0.0.1:8788/health | jq .status        # "healthy"

# b. Migrations recorded:
psql "$PROD" -c "select name from open_brain_schema_migrations
                  where name in ('013_retrieval_sql_correctness.sql',
                                 '014_drop_legacy_single_tenant_reads.sql');"

# c. The five functions are now STABLE ('s') in the prod catalog:
psql "$PROD" -c "select proname, provolatile from pg_proc
                  where proname in ('match_thoughts','search_thoughts_text',
                        'get_thought_connections','list_recent_thoughts','thoughts_stats')
                    and pg_get_function_identity_arguments(oid) not like '%vector, double precision, integer, jsonb'
                  order by proname;"   # expect all 's'

# d. Legacy overloads gone (expect zero LEGACY rows from pre-flight query b).

# e. Smoke: capture a throwaway thought via the normal path and search it back
#    (ask-brain / search_thoughts) — retrieval unaffected by the volatility +
#    anti-join changes.
```

## After the bump: run the probe (Package 3 gate)

With prod healthy, the similarity probe can now gather the go/no-go evidence
for Package 3. It is strictly read-only (`begin transaction read only`):

```
cd local/open-brain-mcp
node src/similarity-probe.mjs --brain-slug <brain> --sample-size 1000 --k 5
# or --json for the machine-readable report
```

It reports the near-duplicate similarity distribution under our embedding
model and a *provisional* skip/reconcile band for the owner to confirm. That
report decides whether Package 3 proceeds.

## Rollback

Re-pin the prior revision (current prod pin) and rebuild — returns the runtime
to today's code. The `013`/`014` schema changes persist and are
forward-compatible with the old runtime (see One-way door), so no schema
rollback is needed or wanted.

## Questions for the operator

- Confirm the prod pin currently live (the rollback target) before bumping.
- Pre-flight (c): if many rows carry NULL `importance`/`quality_score`, the
  re-rank is still confined to `search_thoughts_text` (dormant) — flag if that
  function has been wired into a live path on prod.
