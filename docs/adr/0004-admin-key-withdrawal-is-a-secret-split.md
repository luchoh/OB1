---
status: accepted
date: 2026-08-07
---

# Withdrawing the global admin key is a secret split, not a deletion

`MCP_ACCESS_KEY` is a **required boot variable** — `config.mjs:383` reads it through
`envString`, which throws on unset or empty (`config.mjs:29-35`). The server cannot
start without one. "Remove the global admin key" therefore cannot mean unsetting it.

Today one agenix secret (`ob1-ingest-access-key`) serves two unrelated roles: the
server's own boot secret, and the credential held by claude, codex, pi and the four
ingest daemons. That single file is why an injected agent presenting it resolves to
`resolveLegacyAdminContext` — global admin, full CRUD, every brain.

The withdrawal is a **split**. `config.accessKey` has exactly one consumer in the
whole server: `auth.mjs:581`, `if (key === config.accessKey)`. Give `ob1-stable` its
own secret holding a fresh random value that is distributed to nothing else, and that
branch becomes unreachable by any caller while the server still boots. No OB1 code
change is required; the work is a system-config secret split plus removing the value
from every shared env file.

Sequencing decided with the operator: **rotate first, then narrow.** The current value
has been exported into every interactive zsh on mbprm4 for months and must be assumed
widely copied; rotating and restricting `secrets.nix` to m2-only is one step, and
rotation is safe because the m2 daemons read the same rotated file.

The legacy branch **stays in the code** as break-glass. Migrations are forward-only
and there is no `list_keys` tool; removing the only global actor while holding no way
back is a bad trade for a homelab of one.

## Considered options

- **Delete the legacy branch from `auth.mjs`** (make the value inert even if held):
  rejected for now — it removes the only break-glass credential for a system whose
  migrations cannot be rolled back. Revisit once scoped provisioning is proven.
- **Leave distribution as-is** and rely on the cage plus the firewall: rejected — the
  operator's stated end state is that no agent holds admin, and every scoped-key
  control is meaningless while a skeleton key sits beside it in the same env.

## Consequences

- "No global admin key" means **no *agent* holds one**. Compromise of m2 itself still
  yields admin, because the server's boot secret *is* that value. Accepted.
- `.env.open-brain-local` autoloads into `process.env` at import (`config.mjs:18-27`),
  and on mbprm4 its `MCP_ACCESS_KEY` is byte-identical to the agenix secret
  (docs/48). The dev server needs the same server-only treatment, or the bridge is
  renamed rather than withdrawn.
- `bootstrap-open-brain-household.sh:268` inserts a **stored** admin key whenever
  `MCP_ACCESS_KEY` is set, with `on conflict ... set is_admin = true`. After the split
  that variable is the server's boot secret, so one re-run would bless it as a
  globally reachable stored admin key — strictly worse than today, because stored
  admin can purge and the legacy path cannot. Gating this is a prerequisite for
  withdrawal, not a nicety.
