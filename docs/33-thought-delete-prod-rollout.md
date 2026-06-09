# Prod rollout: thought-delete feature (M1–M5)

Status: STAGED — pre-flight complete and green; awaiting a maintenance window.
Companion: docs/32 (decision/spec), docs/30 (deploy handoff pattern).

Deploys the soft-delete / restore / purge feature to the live `ob1` Postgres +
`ob1-graph` Neo4j on m2maxstudio. Everything below was developed and verified
DEV-only (`ob1_dev` / `ob1-graph-dev`); this is its first prod exposure.

## What ships

Code (OB1 `master` @ `d2d101f8cf6a64d34909562bd3f17a41b053919a`):
- M2/M2.5 read-path + graph-read scrub, M3 delete/restore handlers + authz + audit,
  M4 projector delete path, M5 purge + D8 orphan reconcile.
- New HTTP-only admin routes (NOT MCP tools, by D9): `/admin/thought/delete`,
  `/admin/thought/restore`, `/admin/thought/purge`, `/admin/graph/reconcile-orphans`.

Migrations auto-applied by the ob1-stable deploy wrapper, in order, each in its own
transaction, as `PGUSER=postgres` (confirmed):
- `010_thought_soft_delete.sql` — `deleted_at` column + partial dedupe unique index
  (DROP + CREATE, ACCESS EXCLUSIVE on `thoughts`, fast at this scale).
- `011_thought_soft_delete_reads.sql` — re-issues read RPCs with `deleted_at is null`
  + makes the HNSW index partial (DROP + CREATE, the long pole).
- `012_thought_delete_authz_audit.sql` — role CHECK on brain/estate memberships,
  `thought_audit` table + append-only trigger.

## Deploy mechanism (verified)

`modules/ob1-stable/default.nix` + `scripts/apply-open-brain-local-migrations.sh`:
bump `ob1StablePinnedRevision` in `system-config/hosts/m2maxstudio.nix` →
`darwin-rebuild switch` on m2 → ob1-managed-source fetches `luchoh/OB1@<rev>` →
the wrapper **kills the old service**, `npm install`, **applies pending migrations**
(`ON_ERROR_STOP=1`), then **starts the new runtime**.

Consequences:
- The service is DOWN during migration → a short maintenance window.
- A migration failure leaves the service stopped (wrapper exits before start) →
  failure = outage, not a silent skip. Pre-flight exists to prevent this.

## Pre-flight (DONE — results recorded)

Read-only checks against prod `ob1`, <DATE: 2026-06>:
- Role values: brain `owner`×4, `editor`×2; estate `admin`×1 — all within the
  012 allowed sets → CHECK will pass.
- Table ownership: `thoughts` / `brain_memberships` / `estate_memberships` owned by
  `postgres`; managed env `PGUSER=postgres` → runner has owner/superuser privileges.
- Applied migrations: `001`–`009`; `010`/`011`/`012` pending.
- Corpus: 6,778 thoughts (all embedded), 332 MB — same scale as DEV → short HNSW
  rebuild. No out-of-band concurrent-index work needed; accept the window.

## One-way door

Once `010` applies, the OLD code cannot serve capture: its bare
`on conflict (brain_id, dedupe_key)` no longer matches the now-partial index and
throws. Therefore **roll forward (fix + redeploy), do not revert the pin**, once
migrations have started. This is why the pre-flight had to be green first.

## Runbook

1. BACKUP (purge is irreversible — this is the net):
   - `pg_dump` prod `ob1` (at least `thoughts`, `brain_memberships`,
     `estate_memberships`, `thought_graph_projection_state`).
   - Confirm a recent Neo4j `ob1-graph` backup/snapshot exists.
2. Pick a low-traffic window (single-user system; brief outage acceptable).
3. Bump the pin: `system-config/hosts/m2maxstudio.nix`
   `ob1StablePinnedRevision = "d2d101f8cf6a64d34909562bd3f17a41b053919a";`
   (Leave `packages/ob1-skills.nix` `commit` as-is — skills unchanged since the
   current pin; re-fetch would be a no-op.) Commit system-config.
4. Deploy: `darwin-rebuild switch` on m2maxstudio. Watch the ob1-stable service log
   for "Applying stable OB1 migrations" → each of 010/011/012 → runtime start.
5. POST-DEPLOY VERIFY (prod):
   - `select name from open_brain_schema_migrations` includes 010, 011, 012.
   - MCP `tools/list` still returns the 9 non-destructive tools (no delete/restore/
     purge leaked to agents).
   - Smoke: capture a throwaway thought, search it, confirm projector health.
   - Wiring proof without data loss: a NON-admin key on `/admin/thought/delete`
     returns 403; the bare legacy key on `/admin/thought/purge` returns 403.
   - Optional: one controlled delete → restore on a throwaway prod thought; confirm
     it disappears from search + graph and comes back.
6. If a migration FAILS: the service stays down. Roll FORWARD — read the log, fix the
   offending condition, re-run `darwin-rebuild` (the runner skips already-applied
   migrations via `open_brain_schema_migrations`). Do not revert the pin once 010 has
   applied (see One-way door).

## Post-rollout follow-ups

- Rotate the postgres superuser + Neo4j default passwords (firewalled-env deferral).
- D9 per-principal destructive rate limit remains deferred (documented in docs/32).
- Delete remains operator/HTTP-only; agents have no destructive MCP tool by design.
