# Repository Guidelines

This file is the repository contract for coding agents working in Open Brain.

Before work:
- Read `WORKING_AGREEMENT.md`.
- Then read this file.
- Treat `CLAUDE.md` as a pointer back here, not a separate policy source.
- Follow the **Brain Protocol** below. It is not optional and not housekeeping:
  retrieve before you act, capture the moment you decide or learn. If you are
  about to start a task or make a decision and have not touched the brain, stop.

## What This Repo Is

Open Brain is a cross-client AI memory system built around:
- PostgreSQL + `pgvector`
- MCP tool access
- reusable extensions, recipes, schemas, dashboards, and integrations

This repo is primarily documentation and reusable building blocks.
It now also contains a local runtime scaffold in [`local/open-brain-mcp`](/Users/luchoh/Dev/OB1/local/open-brain-mcp).

License: `FSL-1.1-MIT`.

## Current Local Stack

Canonical local services:
- inference: discover `mlx-server` through Consul
- embeddings: discover `ob1-embedding` through Consul
- database: PostgreSQL `ob1` with `pgvector`

Local MCP runtime:
- service: [`local/open-brain-mcp`](/Users/luchoh/Dev/OB1/local/open-brain-mcp)
- migrations: [`local/open-brain-mcp/migrations`](/Users/luchoh/Dev/OB1/local/open-brain-mcp/migrations)
- migration runner: [`scripts/apply-open-brain-local-migrations.sh`](/Users/luchoh/Dev/OB1/scripts/apply-open-brain-local-migrations.sh)
- verification: [`scripts/verify-open-brain-local.sh`](/Users/luchoh/Dev/OB1/scripts/verify-open-brain-local.sh)

## Guard Rails

1. Do not commit secrets, tokens, or private local config.
2. Do not add destructive SQL such as `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`, or unqualified `DELETE`.
3. Do not silently change the canonical embedding contract. `1536` dimensions is the current production v1 shape.
4. Do not mutate the `thoughts` schema casually. Changes must be migration-backed and justified against compatibility.
5. Do not invent fake data, fallback data, or “best effort” values in code paths.
6. Do not overwrite curated repo structure without reason:
   - `extensions/` and `primitives/` are curated
   - `recipes/`, `schemas/`, `dashboards/`, and `integrations/` are contribution-oriented

## Operational Rules

1. Prefer the local runtime and migration path over ad hoc SQL edits.
2. If you touch the local runtime, verify with:
   - `cd local/open-brain-mcp && npm run check`
   - `./scripts/verify-open-brain-local.sh`
3. Do not assume old Supabase-only guidance is still the only valid deployment path in this repo.
4. Do not start or stop long-running OB1 services yourself unless the user explicitly instructs you to do so.
5. When you need the local runtime, probe it first:
   - `curl -sf http://localhost:8787/health`
   - if it responds, proceed without asking
   - if it does not, tell the user the service appears down and ask them to start it

## Local Environment

OB1 now supports a repo-managed `direnv` + `devenv` workflow.

- `.envrc` uses `devenv`
- `devenv.nix` loads `.env.open-brain-local`
- the user-managed runtime command is:
  - `devenv up open_brain_local`

Service lifecycle rule:
- do not run `devenv up`, `devenv down`, `npm start`, `npm run dev`, `node local/open-brain-mcp/src/index.mjs`, or similar orchestration commands unless the user explicitly instructs you
- focus on code changes, diagnostics, health probes, and tests

## Brain Protocol (reflex — not optional)

OB1 *is* a memory system. Using it is the first and last step of every task,
not an afterthought. Sessions are estate-scoped to the `ob1` principal, so
`mcp__ob1__*` captures default to the `ob1` brain. Three reflex points, every
session — treat them like `git status`/tests, not like extra credit:

**RETRIEVE — before you act.** Before you research, decide, or answer anything
non-trivial, run `mcp__ob1__search_thoughts` on the task's key terms. The brain
may already hold the answer, a prior decision, a calibration, or a past mistake.
Do this *even when you think you remember* — recall goes stale, the brain is
ground truth. Skipping retrieval is the same class of error as acting on an
unread file.

**CAPTURE — the moment you learn or decide, in the same turn.** When you reach a
finding, make or change a non-obvious decision, root-cause something, change
operational/prod state, or correct an earlier belief — call
`mcp__ob1__capture_thought` *then and there*, before moving on. A finding that
lives only in a chat reply is NOT recorded and will evaporate when the turn
ends. Never defer capture to "later" or "end of task."
- Capture (durable): calibrations, measurements, root causes, decisions **and
  the reasoning behind them**, operational state changes, corrections, gotchas.
- Don't capture (scratch): progress narration, anything derivable from
  code/git, one-off command output, facts true only inside this conversation.
- `dedupe_key` = `<agent>:<topic>:<date>` — re-capture with the same key to
  UPDATE/correct a stale thought (a wrong thought is worse than none). `source`
  = your agent name. OB1 knowledge → `ob1` brain; genuinely cross-repo →
  `brain="agent-common"`; NEVER a personal brain.

**VERIFY — before you end the turn.** Ask yourself: did this turn produce a
durable finding or decision, and is it in the brain (not just my reply)? If not,
capture it now. This backstop is what makes the reflex self-correcting — it is
the same checkpoint as "did I run the tests before claiming done."

Debug escalation (estate-wide admin reach for cross-brain reads or admin HTTP
routes) is deliberate and per-launch, never the resting state:
`OB1_MCP_ACCESS_KEY="$MCP_ACCESS_KEY" claude`. Drop back to the scoped key after.

## Repo Shape

- `docs/` — setup, PRD, operational notes
- `extensions/` — curated MCP-backed builds
- `primitives/` — reusable patterns
- `recipes/` — standalone workflows
- `schemas/` — DB schema add-ons
- `dashboards/` — frontend templates
- `integrations/` — capture sources and connectors
- `local/` — local-only runtime code

## Contribution Standard

- Keep docs short, concrete, and operational.
- Prefer migration-backed DB changes.
- Prefer environment variables over hardcoded paths or secrets.
- When in doubt, preserve compatibility with existing Open Brain content and tool names.
