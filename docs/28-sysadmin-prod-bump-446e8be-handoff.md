# Sysadmin Handoff: Bump production OB1 to `446e8be`

Date: 2026-06-02
Status: Awaiting system-config implementation
Owner: System-config (Nix pin bump) + ops (DB migrations)
Companion: PRD `25-upstream-port-roadmap.md`, ADR `27-adr-thought-audit-log.md`

## Summary

Bump the Nix pin in `system-config/hosts/m2maxstudio.nix` from
`5e831ae4fdfae852d60dcf5092a9686fb3267fd8` (current prod) to
`446e8beda8dc96e3a2d30a7a0bd778910dd4bc07` (current `master`),
rebuild, and apply three new database migrations.

After this, the prod brain has:

- New retrieval-side columns and indexes on `thoughts` (type, source_type,
  sensitivity_tier, importance, quality_score, enriched, status,
  status_updated_at, plus tsvector / trgm GIN indexes).
- New SQL functions: `search_thoughts_text`, `brain_stats_aggregate`,
  `get_thought_connections`, `match_thoughts_recency`.
- Extended `/admin/thought/metadata` MCP endpoint that can patch
  structured columns (required by the new enrichment scripts).
- A `recency_weight` parameter on the `search_thoughts` MCP tool.

No production data is destroyed by any of these changes. All migrations
are additive (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
`CREATE OR REPLACE FUNCTION`).

## What's in this revision range

`git log --oneline 5e831ae..446e8be` (10 commits, 9 substantive):

| Commit | Subject | Touches prod? |
|--------|---------|---------------|
| `446e8be` | feat(enrichment): port thought-enrichment scripts to Python | scripts only — not deployed |
| `b8ef895` | feat(mcp): extend admin/thought/metadata to patch structured columns | **YES — server.mjs** |
| `49104e5` | docs(adr): thought-audit log decision | docs only |
| `4e84598` | feat(mcp): expose recency_weight on search_thoughts tool | **YES — server.mjs, retrieval.mjs** |
| `aeb9289` | feat(retrieval): add match_thoughts_recency RPC | **YES — migration 008** |
| `c0516fe` | feat(retrieval): add workflow status columns to thoughts | **YES — migration 007** |
| `6b7ec0b` | docs(handoff): system-config deploy for live-retrieval skill | docs only |
| `21923a5` | docs(port): port survey + roadmap PRD | docs only |
| `fa9fee1` | feat(retrieval): lexical search columns + indexes, classify text captures | **YES — migration 006, server.mjs, telegram_bridge.py** |
| `6a595fc` | skills: import upstream skills tree at f16479e | static skills/ — not deployed |

Of these, four touch production-relevant artifacts:

- **migrations 006, 007, 008** in `local/open-brain-mcp/migrations/`
- **`local/open-brain-mcp/src/server.mjs`** — extended ingest, extended admin
  endpoint, recency-aware retrieval
- **`local/open-brain-mcp/src/retrieval.mjs`** — recency wiring
- **`integrations/telegram-capture/telegram_bridge.py`** — typed text
  captures now opt into `extract_metadata` (was `false`, now `true` for
  thought rows)

The skills/ tree and `scripts/thought_enrichment/` directory are not
deployed by the Nix derivation; they ship in the repo only.

## Order of operations

These steps should be done in order. Steps 1-2 are reversible without
data loss; step 3 is reversible per ADR-27 (audit log not yet wired,
all changes are additive).

### 1. Verify current prod state

Before changing anything, confirm baseline:

```
# On the prod host (m2maxstudio is also the dev host; addr 10.10.10.100)
PGPASSWORD="$PGPASSWORD" psql "host=10.10.10.100 port=5432 dbname=ob1 user=ob1" -c \
  "select name from open_brain_schema_migrations order by name;"
```

Expected today: `001_ob1_core.sql` through `005_household_multitenancy.sql`
applied, nothing newer.

```
# Confirm the running service revision matches the current pin
curl -sS http://127.0.0.1:8788/health | jq .
```

Expected: a JSON body identifying revision `5e831ae...` (or whatever
the current `system-config/hosts/m2maxstudio.nix` declares).

### 2. Bump the Nix pin in system-config

In `system-config/hosts/m2maxstudio.nix`:

```
ob1StablePinnedBranch = "master";
ob1StablePinnedRevision = "446e8beda8dc96e3a2d30a7a0bd778910dd4bc07";
```

Replace the X's with the actual SHA at the tip of `luchoh/OB1` master
when you're ready to deploy. As of writing it is `446e8be` plus the
trailing characters; verify with:

```
git -C /Users/luchoh/Dev/OB1 rev-parse master
```

Apply via your normal `nix run / nixos-rebuild / darwin-rebuild`
pipeline. The `open-brain-local` service should restart automatically.

### 3. Apply DB migrations 006, 007, 008

After the new revision is live, run the same migration script that's
already in the deployed tree:

```
# On the prod host, with prod PG credentials in the environment
./scripts/apply-open-brain-local-migrations.sh
```

This will skip 001-005 (already applied) and apply 006, 007, 008 in
order. Each migration is idempotent (`IF NOT EXISTS` / `CREATE OR
REPLACE`) and safe to re-run.

Expected output:

```
Skipping already-applied migration: 001_ob1_core.sql
Skipping already-applied migration: 002_thought_dedupe_key.sql
Skipping already-applied migration: 003_retrieval_role.sql
Skipping already-applied migration: 004_thought_graph_projection_state.sql
Skipping already-applied migration: 005_household_multitenancy.sql
Applying migration: 006_lexical_search.sql
... (lots of NOTICEs about word-too-long-to-be-indexed; these are tsvector chatter, not errors)
Applying migration: 007_workflow_status.sql
Applying migration: 008_recency_boosted_match.sql
All migrations applied.
```

Index build time on prod depends on row count. On dev (6,749 rows) it
took <1 minute. Upstream estimated 1-2 minutes for ~90,000 rows. The
build takes a normal (non-CONCURRENT) lock against `thoughts` writes
during that window — if prod traffic is heavy, schedule for low usage.

### 4. Smoke-test prod after the bump

Three checks:

a. **Health endpoint reports the new revision:**
   ```
   curl -sS http://127.0.0.1:8788/health | jq .
   ```
   Expected: revision `446e8be...`.

b. **Capture and search round-trip works:**
   ```
   # Telegram a typed message to the prod bot. Then:
   curl -sS -X POST http://127.0.0.1:8788/mcp \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -H "x-access-key: $PROD_MCP_ACCESS_KEY" \
     -H "x-ingest-key: $PROD_MCP_ACCESS_KEY" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_thoughts","arguments":{"query":"<your test phrase>","match_count":3}}}'
   ```
   Should return the thought you just captured, with `type` populated
   (DeepSeek classified it during ingest because the bridge now opts
   into `extract_metadata`).

c. **`recency_weight` works:**
   Add `"recency_weight":0.5,"half_life_days":30` to the arguments
   above. Newer rows should rank higher than they did with weight=0.

## Once prod is bumped: enrichment

Backfilling the `type`/`source_type`/`sensitivity_tier`/`enriched`
columns on existing prod rows is a separate, manual step run from any
host that has the dev tooling. See `scripts/thought_enrichment/README.md`.
Sequence:

1. `--status` to see how many rows are unenriched.
2. `--dry-run --limit 5` to eyeball DeepSeek's classifications.
3. `backfill_sensitivity.py --dry-run`, eyeball false positives, then
   `--apply` if happy.
4. `enrich.py --apply --concurrency 5`. Expect 1-3 s per row → hours
   for a typical brain. Resumable on Ctrl-C; `--retry-failed` cleans
   up afterward.

## Out of scope / not in this bump

- The `live-retrieval` Claude Code skill (separate handoff doc 26).
- The `thought-audit` log (ADR-27, schema not yet implemented).
- Wiring `recency_weight` into any caller other than the search_thoughts
  MCP tool itself.

## Rollback

If anything goes wrong:

- **Nix pin:** revert `m2maxstudio.nix` to `5e831ae...` and rebuild.
  All commits in this range are forward-only on the master line, no
  branches to chase.
- **Migrations:** there is no down-migration script today. The only
  destructive part of 006 is `update thoughts set type = ...`, which
  fills NULL columns; reverting would be `update thoughts set type = NULL`
  — destructive, do not do without a fresh decision. Migrations 007
  and 008 only add columns and a function; reverting is "leave them
  in place," they are unused without the new server code.
- **Telegram bridge:** the `extract_metadata: True` flip can be reverted
  by checking out the old `telegram_bridge.py` from `5e831ae`. Future
  rows would land without DeepSeek classification, same as before.

## Questions for the operator

None blocking. If the host network setup doesn't expose prod's PG to
the migration script via Consul (it does for dev), set `PGHOST` /
`PGPORT` explicitly in the env before running.
