---
status: accepted
date: 2026-08-07
---

# A named admin credential must exist before the legacy path is withdrawn

Once `resolveLegacyAdminContext` is unreachable (ADR-0004), nothing in the repo can
mint a stored admin key, and roles never confer purge. These capabilities become
permanently unreachable by any caller:

- `purge` — `authorizePurge` requires the named-admin-service-key shape
  (`access-policy.mjs:145-151`, `:226-233`); the ladder explicitly excludes it
  (`:181-183`, and ADR-0002).
- all four `/graph/*` routes — `ensureGraphAdmin` throws 403 for `!isAdmin`
  (`server.mjs:860-863`, called at `:921`, `:935`, `:949`, `:968`).
- `graph_assisted` ask (`server.mjs:577`) and graph stats (`server.mjs:840-849`).

Every minting path writes `is_admin=false` as a hard-coded literal:
`agent_estate/provision.sh:154`, `:176`; `provision-ingest-key.sh:107-109`;
`mint-authority-init.mjs:325-330`; and all of `repo-key-minting.mjs`. The only
`is_admin=true` path is `bootstrap-open-brain-household.sh:268-299`, which registers
`MCP_ACCESS_KEY` itself — the very thing being withdrawn.

We will therefore ship a **one-shot named-admin issuance script** before withdrawal,
on the `mint-authority-init.mjs` pattern: operator-typed key read with no echo, stored
hash-only, bound to one named admin principal, idempotent, and the sole grantor of
that capability.

Purge is the erasure path — the thing needed when something sensitive lands in a
brain. Losing it to a config change that cannot be reversed without editing code is
not an acceptable trade.

## Considered options

- **Accept the loss** (purge and the graph plane via direct SQL/Cypher forever):
  rejected — it moves the most destructive operation in the system from an
  authorized, audited API path to unaudited hand-written SQL.
- **Re-use `bootstrap-open-brain-household.sh`**: rejected — it blesses whatever is in
  `MCP_ACCESS_KEY`, which after ADR-0004 is the server's own boot secret. That is the
  regression the gate exists to prevent.

## Consequences

- The named admin key is **strictly more powerful than today's legacy key**: a stored
  admin key can purge; the legacy path cannot. This is a deliberate increase in the
  ceiling of a single credential, justified by it being attributable, revocable, and
  held only by the operator.
- It is one more high-value secret to custody, and it must never appear in any harness
  environment, any `.env` file, or any cage.
