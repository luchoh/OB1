# thought_enrichment

Backfill scripts that classify existing thoughts into the structured
columns added by migration 006 (`type`, `source_type`, `importance`,
`enriched`, `sensitivity_tier`).

Ported from upstream `recipes/thought-enrichment` per PRD-25 §2.3.
Differences from upstream:

- Provider is fixed to **DeepSeek-V4-Flash via mlx-server** (OpenAI-compatible).
  No OpenRouter / Anthropic.
- Reads use **asyncpg** directly against Postgres for paged scans.
- Writes use the **MCP `/admin/thought/metadata` endpoint** (extended in
  the same commit that introduced this script to accept structured-column
  patches), so changes share the same audit/governance path as production
  writes — see ADR-27.
- Brain-scoped via `--brain-id`; nothing runs without it.
- State file is per-brain at
  `scripts/thought_enrichment/data/enrichment-state-<brain>.json`.

## Scripts

### `backfill_sensitivity.py` — pure regex, no LLM

Scans rows whose `sensitivity_tier` is null/empty/standard and upgrades
to `personal` / `restricted` based on PII / health / financial regex
patterns from `sensitivity_patterns.json`.

```
python scripts/thought_enrichment/backfill_sensitivity.py --brain-id <uuid> --dry-run
python scripts/thought_enrichment/backfill_sensitivity.py --brain-id <uuid> --apply
```

Fast (no LLM cost). Run this **first**; restricted rows can then be
excluded from any LLM enrichment pass that would otherwise send sensitive
content to the model.

### `enrich.py` — LLM-driven classification

Reads rows where `enriched` is null/false, classifies via DeepSeek, and
writes back `type` / `importance` / `source_type` / `enriched=true` plus
an enriched metadata bundle (`summary`, `topics`, `tags`, `people`,
`action_items`, `confidence`, `enriched_version`, `enriched_at`,
`enriched_model`).

```
# Eyeball 10 rows before committing
python scripts/thought_enrichment/enrich.py --brain-id <uuid> --dry-run --limit 10

# Apply
python scripts/thought_enrichment/enrich.py --brain-id <uuid> --apply --concurrency 5

# Status
python scripts/thought_enrichment/enrich.py --brain-id <uuid> --status

# Retry rows previously failed
python scripts/thought_enrichment/enrich.py --brain-id <uuid> --apply --retry-failed
```

### Type taxonomy on DeepSeek

Upstream's prompt forces output into one of 8 types (`idea`, `task`,
`person_note`, `reference`, `decision`, `lesson`, `meeting`, `journal`).
DeepSeek-V4-Flash sometimes invents adjacent values (`reminder`,
`note`, etc.); the classifier collapses anything outside the allow-list
to `reference` (upstream's "I don't know" bucket). Expect a long tail of
`type='reference'` after a real run. Re-tuning the prompt is a follow-up.

## Setup

Python dependencies (`asyncpg`, `httpx`) are provided by `devenv.nix`
and available inside `devenv shell`.

Required env (typically sourced from `.env.open-brain-local`):

- `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`
  (or `OPEN_BRAIN_DATABASE_URL` to override)
- `OPEN_BRAIN_BASE_URL` — e.g. `http://[::1]:8787` for the dev MCP
- `MCP_ACCESS_KEY` — required when `--apply` is set
- `LLM_BASE_URL` — e.g. `https://mlx.lincoln.luchoh.net/v1`
- `LLM_MODEL` — defaults to `DeepSeek-V4-Flash-nvfp4`

## What this does NOT do

- Does **not** delete or merge rows.
- Does **not** modify `content` or `embedding`. Only metadata + structured columns.
- Does **not** retry on transient failures inside a single LLM call beyond the
  4-attempt exponential backoff in `lib/llm.py`. Use `--retry-failed` to re-run
  the leftover ID list.
- Does **not** run on a schedule. Call it manually when needed.

## State file

`data/enrichment-state-<brain>.json`:

```
{
  "totalProcessed": 4321,
  "totalFailed": 12,
  "failedIds": ["uuid1", "uuid2", ...],
  "lastProcessedId": "uuid",
  "startedAt": "2026-06-02T08:00:00+00:00",
  "updatedAt": "2026-06-02T08:30:00+00:00"
}
```

Gitignored. Per machine. Crash-safe: a Ctrl-C mid-run resumes from the
last checkpoint when re-launched without `--retry-failed`.
