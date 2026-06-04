# Agent Estate (v24) — Deploy & Handoff Notes

Date: 2026-06-03
Scope: rollout + operational follow-ups for the v24 agent-estate brain selector.
Companion: PRD [`docs/29-agent-estate-implementation-roadmap-v24.md`](29-agent-estate-implementation-roadmap-v24.md).

## What shipped

Seven commits on `master` (`22af2b1`..`f72d3d0`) implement v24 Phases 1–5, 7 and
the acceptance suite. The runtime, migration, provisioning CLI, capture-skill
routing, and tests are done and verified against `ob1_dev`.

| Phase | What | Commit |
|---|---|---|
| 1 | migration `009` — `estate_memberships` + `brain_memberships.is_deny` | `22af2b1` |
| 2 | estate-aware auth resolver (stored + human keys), `accessibleBrains` | `22af2b1` |
| 3 | per-call `brain` param + cross-brain metadata `404` (was `500`) | `6bf6223` |
| 4 | multi-brain read fan-out + per-row `brain_id`/`brain_slug` | `e2ab348`, `b1020ab` |
| 5 | `scripts/agent_estate/provision.sh` | `f674ed5` |
| 7 | brain routing in `auto-capture` / `autodream-brain-sync` skills | `efa7125` |
| — | `tests/test_agent_estate.py` (8/8 green vs live service) | `f72d3d0` |

Applied to **`ob1_dev` only**. PROD migration is deferred (same DB server,
DB name `ob1`).

## ⚠️ BREAKING: `stats` response shape (v24 D6)

The `stats` MCP tool no longer returns top-level `top_sources` / `top_types` /
`top_people` or a single-brain `overview`. New shape:

```jsonc
{
  "success": true,
  "brains": 3,
  "overview": { "total_thoughts": <sum>, "embedded_thoughts": <sum>,
                "first_capture": <min>, "last_capture": <max> },   // aggregate
  "per_brain": [ { "brain_id", "brain_slug", "overview", "top_sources",
                   "top_types", "top_people" }, ... ]
}
```

- Top-level `overview` is now the **aggregate** across brains; per-brain detail
  (incl. the `top_*` lists) moved into `per_brain[]`.
- The shape is **stable regardless of membership count** (always `per_brain[]`,
  even for one brain) — it no longer flips when a key gains a membership.
- **No in-repo consumer reads the moved fields** (verified). Any *external*
  agent/skill reading `stats.top_sources` must be updated before relying on it.

`similar` (`/admin/thought/similar`) also dropped per-result
`retrieval_strategy` / `fallback_used` and added `brains_searched`; matches now
carry `brain_id`/`brain_slug`. The two in-repo consumers (telegram bridge,
dictation import) read only `query` + `matches`, so they are unaffected.

## Owed before / at PROD rollout

1. **Rotate credentials** (accidentally surfaced in a dev session transcript;
   firewalled, low risk, but owed): the `postgres` superuser on `10.10.10.100`
   (governs `ob1_dev` **and** `ob1`/prod) and the Neo4j default password. Update
   Consul / secret store and every `.env.open-brain-local` copy (incl.
   `~/Dev/quantum-iqm/.env.open-brain-local`).
2. **Run migration `009` on PROD** via `./scripts/apply-open-brain-local-migrations.sh`
   (psql provided by `nix shell nixpkgs#postgresql_16` if not on PATH). Additive
   and idempotent.
3. **Communicate the `stats` shape change** to any external agent/skill consumer.

## Provisioning a repo (Phase 5)

```bash
./scripts/agent_estate/provision.sh <repo-slug>     # e.g. ob1, system-config
```

Idempotent. First run for a slug mints a service key and writes the plaintext to
`.agent-estate-keys/<slug>.key` (gitignored — never stdout). Re-runs keep the
existing key. It also creates the singleton **agent estate** + **common brain**
(`agent-common`) on first use and grants the operator (the `person` principal)
an estate-level membership for visibility into all agent brains.

Slugs are overridable for testing: `AGENT_ESTATE_SLUG`, `COMMON_BRAIN_SLUG`.

## Phase 6 — per-repo `.envrc` (operator step, not yet done)

Goal: each repo's shell carries its repo principal's key, so agents working
there authenticate as that repo principal and capture to its repo brain by
default. This is **manual per repo** and intentionally not scripted (it places a
real secret).

Per repo you want agents in:

1. Provision the principal (above); read the key from
   `.agent-estate-keys/<slug>.key`.
2. Store the key in the repo's **gitignored** local env (do not commit it). Two
   layouts, pick what the repo already uses:
   - direnv sourcing a gitignored file:
     ```bash
     # .envrc (tracked)
     [ -f .env.local ] && source_env .env.local
     # .env.local (gitignored)
     export MCP_ACCESS_KEY=<repo principal key>
     export OPEN_BRAIN_BASE_URL=http://127.0.0.1:8787
     ```
   - or a direct `export` in a gitignored `.envrc` if the repo gitignores it.
3. `direnv allow` in the repo.
4. Verify: from that repo's shell, `echo $MCP_ACCESS_KEY` shows the repo key
   (not the legacy admin `MCP_ACCESS_KEY`), and a no-`brain` capture lands in the
   repo brain (`select brain_id from thoughts ...`).

Caveats / decisions baked into v24:
- **Do not reuse the legacy admin key.** The env var name is the same
  (`MCP_ACCESS_KEY`), but the *value* must be the repo principal's stored key.
  The legacy admin key (current global `MCP_ACCESS_KEY`) stays as-is for the
  existing single-tenant scripts (Telegram bridge, FastAPI ingest) — see D7.
- A repo principal key is **non-admin, non-brain-bound**: it reads across its
  accessible brains (repo + common) and writes to its default (repo) brain unless
  it passes `brain="agent-common"` (the skill does this for cross-cutting notes).
- CLIs inherit the shell env automatically. MCP clients with their own config
  inherit env at process start — restart the client after changing `.env.local`.

## Phase 8 — writer migration (optional)

No writer is forced to change: the default-brain shim keeps existing callers
working. Migrate a writer only when it should target a specific brain — e.g. an
ingest path that should write to `agent-common` passes `brain="agent-common"`;
otherwise leave it on its principal's default brain.

## Verifying a deploy

```bash
set -a; source .env.open-brain-local; set +a
python3 -m unittest discover -s tests -p test_agent_estate.py -v
```

Self-skips if the runtime (`OPEN_BRAIN_BASE_URL`, default `localhost:8787`) or DB
is unreachable. The dev runtime runs `node --watch`, so it hot-reloads `src`
edits — no manual restart needed after code changes.
