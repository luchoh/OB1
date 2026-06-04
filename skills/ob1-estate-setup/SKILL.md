---
name: ob1-estate-setup
description: Initialize OR update the CURRENT repo's OB1 agent identity — scope this repo's agents to a per-repo OB1 principal by setting OB1_MCP_ACCESS_KEY in the repo's gitignored env. Re-runnable: detects prior setup and asks whether to migrate, rotate, reset, or leave it. Asks before changing anything.
disable-model-invocation: true
---

# OB1 Agent Estate — Per-Repo Setup

## What this does, and why it works this way

Every Claude Code instance has a **global** `ob1` MCP server (managed by
system-config's claude-code module) that sends `x-access-key: ${OB1_MCP_ACCESS_KEY}`
to OB1 at a fixed URL. By default `OB1_MCP_ACCESS_KEY` is the **global
legacy-admin** key, so agents talk to OB1 as admin (every brain).

To scope THIS repo, we override **`OB1_MCP_ACCESS_KEY`** in the repo's gitignored
env (loaded by `direnv` on shell entry). A `claude` launched in this repo then
sends the **repo's** key and authenticates as the repo's principal — captures
default to the repo brain, and `brain="agent-common"` for cross-cutting notes.

Facts that make this correct (the previous version of this skill got these wrong):
- The lever is **`OB1_MCP_ACCESS_KEY`** — the var the MCP header actually reads.
  Setting `MCP_ACCESS_KEY` does **nothing** for Claude's MCP connection.
- The MCP **URL is fixed** (prod) in the global config, so no per-repo URL is
  needed. `OPEN_BRAIN_BASE_URL` only matters for direct `curl`/scripts.
- The key authenticates against **prod** (`ob1`), where the estate lives.
- The **OB1 repo itself is NOT scoped** — it keeps legacy-admin for debug. Skip it.
- The plaintext key is born HERE and never leaves; only its sha256 hash goes to OB1.

## Process

### 1. Explore (read-only; do not `ls` paths that may not exist — it spews errors)

- **Slug:** from `git remote -v` or the directory name; must be `[a-z0-9-]`.
- **Is this the OB1 repo?** `test -f scripts/agent_estate/provision.sh && echo "OB1"`.
  If it is, STOP — OB1 keeps the legacy-admin key for global/debug access.
- **Prior state** — inspect this repo's gitignored env (`.env.local`, `.envrc`):
  - **SCOPED** — `OB1_MCP_ACCESS_KEY` is set → already wired correctly.
  - **LEGACY-VAR** — `MCP_ACCESS_KEY` is set but `OB1_MCP_ACCESS_KEY` is not → wired
    by the older skill with the WRONG var name (the key itself is fine, just unused
    by Claude). Needs a one-line migration.
  - **FRESH** — neither is present.

### 2. Present findings and pick an action (ask; one at a time, with plain explainers)

State the slug and detected state, then offer the matching action:

- **FRESH → Set up.** Generate a key here, register its hash in OB1, write the env.
- **LEGACY-VAR → Migrate (recommended).** The existing key is already registered in
  OB1, so just **rename** `MCP_ACCESS_KEY` → `OB1_MCP_ACCESS_KEY` in the env (same
  value). No OB1-side change. (Alternatives: Rotate, or Leave.)
- **SCOPED →** offer:
  - **Leave** — already correct.
  - **Rotate** — replace the key (new key here; register new + revoke old in OB1).
  - **Reset** — revoke all this repo's keys in OB1 and set up fresh.
  - **Repair** — rewrite the env from the existing key (fix a typo, missing
    `direnv` source, etc.) without touching OB1.

### 3. Apply locally

End state for every path: **`OB1_MCP_ACCESS_KEY=<this repo's key>`** in the
gitignored env, loaded by `direnv`.

- **Generate a key** (set-up / rotate / reset):
  ```bash
  KEY="ob1_$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
  HASH="$(node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$KEY")"
  ```
  Write to the gitignored env (create `.env.local` + the `.envrc` source line if absent):
  ```bash
  # .env.local (gitignored)
  export OB1_MCP_ACCESS_KEY=<KEY>
  # optional — only for direct curl/scripts, NOT Claude's MCP (which uses the global URL):
  # export OPEN_BRAIN_BASE_URL=http://10.10.10.100:8788
  ```
  Ensure `.gitignore` covers the env file. **Never** print the key into a chat
  transcript or commit it — keep it in the file.
- **Migrate** (LEGACY-VAR): rename the var in place — `MCP_ACCESS_KEY` →
  `OB1_MCP_ACCESS_KEY`, same value. Nothing else changes.

### 4. Apply in OB1 — only when the key actually changed

Hand the user the command to run **in the OB1 repo** (only the hash crosses;
`--database` MUST match the runtime, `ob1` = prod; idempotent):

- **Set up:**  `./scripts/agent_estate/provision.sh <slug> --key-hash <HASH> --database ob1`
- **Rotate / Reset:**  `./scripts/agent_estate/provision.sh <slug> --revoke-keys --key-hash <HASH> --database ob1`
  (revokes the old key(s), then registers the new one)
- **Migrate / Repair / Leave:** nothing — the key is already registered.

### 5. Verify — the only check that actually proves scoping

- `direnv allow`; `echo $OB1_MCP_ACCESS_KEY` shows THIS repo's key (not the global one).
- **Launch `claude` in this repo, capture a thought, and confirm it landed in the
  `<slug>` brain** — not the legacy-admin default brain. This is the real proof:
  the env var name, `direnv`, and Claude Code's per-launch `${VAR}` substitution all
  have to line up, and only a live capture confirms they do.
- GUI MCP clients read env at process start — restart them after a change.

Finish by telling the user the final state and which files changed.
