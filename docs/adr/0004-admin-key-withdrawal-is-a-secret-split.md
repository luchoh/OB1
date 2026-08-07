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

## Amendment 2026-08-07

Two findings from the system-config agent's review. The first is a factual error in the
body above; it is left in place rather than rewritten, because the operator was about to
act on it.

### 1. Narrowing the shared secret to m2 does NOT take it away from the agents

The body says the withdrawal is achieved by giving `ob1-stable` its own secret and
"restricting `secrets.nix` to m2-only". That silently assumes narrowing by **host**
removes the key from the agents. It does not, because on m2 the agents and the server
read the **same file**:

- `modules/pi-cli/default.nix:1072-1075` — `ob1.accessKeyFile` defaults to
  `/run/agenix/ob1-ingest-access-key`, exported as `OB1_MCP_ACCESS_KEY`
  (`:1089-1091`, `:624-625`) and passed into the cage by name (`:502`).
- `hosts/services/m2maxstudio/ob1-stable.nix:23-24` — feeds
  `config.age.secrets.ob1-ingest-access-key.path` to the server's `accessKeyFile`,
  which `modules/ob1-stable/default.nix:125` exports as `MCP_ACCESS_KEY`.
- `modules/codex-cli/default.nix:566-568` — reads the same path directly; claude picks
  it up from `OB1_MCP_ACCESS_KEY` via `lib/mcp-registry.nix:31`.

system-config's own `docs/adr/0009` reaches the same conclusion from the other side:
mbprm4 (harness-only) can drop the secret, but **m2 keeps it**, and its accepted
residual R1 is that ob1-stable runs as uid 501 — the same uid as the harnesses — so a
harness on m2 can read the server's boot secret off disk. Host scoping is therefore not
the boundary. m2 is exactly the host where the harnesses live.

**Corrected plan.** The boundary is per-consumer secrets, not per-host `publicKeys`.
`ob1-stable` gets a fresh, server-only value distributed to nothing else, and claude,
codex, pi and each ingest daemon get **new distinct** scoped credentials in **new
distinct** files. `ob1-ingest-access-key` stops being a shared file; the agents' files
must not be it.

**Corrected success test — behavioural, not declarative.** Not "did `secrets.nix`
change" but: *the value visible inside the cage / inside the harness env is not equal
to the server's boot secret.* Compare hashes, never values: take
`sha256` of the value the client would present and of `/run/agenix/<server secret>`,
assert they differ, and separately assert the client's value fails
`resolveLegacyAdminContext` (an admin-only route such as `/graph/*` must 403 for it).
R1 remains: a harness that goes looking can still `Read` the server's file on m2 while
ob1-stable runs as uid 501. Re-homing the server to a non-501 user is the fix and is
out of scope here — the control being claimed is *what the agent is configured to
present*, not what it is physically prevented from reading.

### 2. The client-side `MCP_ACCESS_KEY` fallback masks a mis-provisioned scoped key

This repo deliberately shipped `OPEN_BRAIN_INGEST_KEY || MCP_ACCESS_KEY` (and the
enrichment equivalent) as a migration cushion — `telegram_bridge.py:79-85`,
`recipes/dictation-import/import-dictation.py:69-75`,
`scripts/ingest-chat-export-sources.py:27-31`,
`scripts/backfill-chat-claim-typing.py:206`, `recipes/shared_docling.py:34`,
`recipes/email-history-import/import-imap.py:44`,
`recipes/chatgpt-conversation-import/import-chatgpt.py:73`. The cushion is also a mask:
a scoped key that is missing, empty, typo'd or registered in the wrong database falls
through to the admin value and the client **tests green**. It only 401s once the admin
key is withdrawn — i.e. after the irreversible step, when the evidence that rollout
succeeded was never evidence of anything. There is no "is this the key I think it is?"
signal anywhere, only "does some key work?".

**Mitigation, required before withdrawal.** Dry-run every client with `MCP_ACCESS_KEY`
**unset** in its environment (and `OPEN_BRAIN_ACCESS_KEY` unset where read), so the
scoped key is the only credential present. A client that fails that dry-run is
mis-provisioned regardless of how green it looks with the fallback in place. This is the
per-client half of the success test above; the three `list_*` operator tools and the
`whoami` tool added in 0.10.0 are the enumeration half — they answer *which* principal a
key resolves to, and let the rollout be audited and re-run idempotently instead of read
off create-only 409s.
