---
name: ob1-estate-setup
description: Initialize the CURRENT repo for the OB1 agent estate — give it a scoped agent principal + access key and wire the repo's local shell env so agents working here capture to this repo's brain by default and can also reach the shared common brain. Run once per repo. Asks before creating anything.
disable-model-invocation: true
---

# Initialize This Repo for the OB1 Agent Estate

OB1 gives each repository its own agent identity: an agent working in repo X
authenticates as the `X` principal, captures to the `X` brain by default, and can
also read/write the shared `agent-common` brain. This skill sets that up for the
**current** repo — it provisions (or registers) a scoped key and wires the repo's
gitignored shell env so `cd` into this repo silently becomes the right identity.

The plaintext key is generated **here** and never leaves this repo. OB1 only ever
stores its sha256 hash. Companion: OB1 `docs/30-agent-estate-deploy-handoff.md`.

## When to use

Run once in a repo where you want OB1 agents scoped to that repo. Re-run only to
rotate the key or repair the local env.

## Process

### 1. Explore (read-only)

Gather context before changing anything:

- Repo slug: derive from the git remote (`git remote -v`) or the directory name.
  Must be `[a-z0-9-]`, short and human (e.g. `system-config`, `dotfiles`).
- Is this the **OB1 repo itself**? If the repo root has
  `local/open-brain-mcp/` and `scripts/agent_estate/provision.sh`, STOP and tell
  the user: the OB1 repo intentionally keeps the legacy-admin key so its agents
  have global/debug access — do not scope it. Nothing to do here.
- OB1 server reachability: `curl -sf http://127.0.0.1:8787/health`. If down, tell
  the user the OB1 runtime appears down and ask them to start it before continuing.
- Existing config: is there already an `MCP_ACCESS_KEY` in this repo's `.envrc` /
  `.env.local`? If so, this repo may already be initialized — confirm before overwriting.

### 2. Present findings and ask (one decision at a time)

Summarize what's present/missing, then walk the user through each decision. Assume
they may not know the terms; start each with a one-line explainer, then the choices
and the default.

#### Section A — repo slug

Explain: the slug is this repo's agent identity and brain name in OB1. Default to
the derived slug. Confirm or let the user override.

#### Section B — key strategy

Explain: agents authenticate with a key tied to this repo's principal. Two ways:

- **Generate here, register in OB1 (default).** This skill mints a key, stores the
  plaintext in this repo's gitignored env, and gives you a one-line command to run
  in the OB1 repo that registers only the *hash*. The plaintext never leaves here.
- **Supply an existing key.** You paste a key you already hold (e.g. from a prior
  `provision.sh` run); the skill writes it to the local env and gives you the same
  register command for its hash.

#### Section C — which OB1 runtime, and local env layout

Explain: the key authenticates against **one** OB1 runtime, and a key only works
against the runtime whose database holds it. A repo principal provisioned into
**production** must point at the **production** runtime — pointing at the local
dev runtime (a different database) will fail auth. Confirm the target:

- **Production (default for real use):** `http://10.10.10.100:8788`
  (the `ob1-stable` service on m2maxstudio; also reachable as
  `http://m2maxstudio.lincoln.luchoh.net:8788`).
- **Local dev:** `http://127.0.0.1:8787` — only if the principal was provisioned
  into `ob1_dev` and you are testing against the laptop runtime.

Pick the one matching where the principal was (or will be) provisioned, and use
it as `OPEN_BRAIN_BASE_URL` below.

Explain: the key lives in a **gitignored** file that `direnv` loads on shell entry.
Default layout (adapt to what the repo already uses):

```bash
# .envrc (tracked)
[ -f .env.local ] && source_env .env.local
# .env.local (gitignored)
export MCP_ACCESS_KEY=<this repo's key>
export OPEN_BRAIN_BASE_URL=http://10.10.10.100:8788   # prod; use 127.0.0.1:8787 only for dev
```

### 3. Write the local env

- If generating: create the key as `ob1_<random>`. Compute its hash:
  ```bash
  KEY="ob1_$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
  HASH="$(node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$KEY")"
  ```
- Write `MCP_ACCESS_KEY` + `OPEN_BRAIN_BASE_URL` into the gitignored env file
  (create `.env.local` and the `.envrc` source line if absent).
- Ensure `.gitignore` covers the env file. **Never commit the key.** Never print
  the plaintext key into a chat transcript — keep it in the file.

### 4. Register the principal in OB1

Hand the user this exact command to run **in the OB1 repo** (only the hash crosses;
OB1 holds DB credentials, this repo does not). **`--database` MUST match the
runtime chosen in Section C** — `ob1` for production, `ob1_dev` for local dev —
or the key gets registered in the wrong database and auth fails:

```bash
# run inside ~/Dev/OB1
./scripts/agent_estate/provision.sh <slug> --key-hash <HASH> --database ob1   # prod
# (use --database ob1_dev only if you pointed at the local dev runtime)
```

This idempotently creates the agent estate (first time), the common brain, the
`<slug>` principal + brain, the two memberships (repo=owner, common=editor), and
registers the supplied hash as the principal's active key.

### 5. Verify and done

After the user has run the register command:

- `direnv allow` in this repo.
- `echo $MCP_ACCESS_KEY` shows this repo's key (not the legacy admin key).
- A no-`brain` capture lands in the `<slug>` brain; a `brain="agent-common"`
  capture lands in the common brain. (The capture skills route cross-cutting notes
  to `agent-common` automatically.)
- GUI MCP clients read env at process start — restart them after the first setup.

Tell the user which files were written and that this repo's agents are now scoped
to the `<slug>` principal.
