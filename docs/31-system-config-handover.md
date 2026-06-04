# Handover to system-config — deploy v24 to prod + distribute the OB1 skills

Date: 2026-06-03
Audience: a session working in `~/Dev/system-config`.
Source of changes: `luchoh/OB1` @ branch `master`.
Companion: OB1 `docs/30-agent-estate-deploy-handoff.md` (operational detail),
`docs/29-agent-estate-implementation-roadmap-v24.md` (the spec).

Two independent tasks:
1. **Update production OB1** to the v24 runtime (a managed-source revision bump).
2. **Distribute the OB1 skills** universally (per-user), so `/ob1-estate-setup`
   is available in every repo. (The *setup* is per-repo; the *skill* is universal.)

---

## 1. Update production OB1 (m2maxstudio)

### How prod is wired (verified)

- Prod runs `luchoh/OB1` branch **`master`** (NOT `main` — `main` is unrelated
  upstream and has diverged; ignore it for prod).
- Deployed by `modules/ob1-managed-source` + `modules/ob1-stable`, materialized
  at `/usr/local/lib/ob1-managed/stable/current`, with a stable env snapshot at
  `/usr/local/lib/ob1-managed/stable/env/open-brain-local.env`.
- Pinned in **`hosts/m2maxstudio.nix`**:
  ```nix
  ob1StablePinnedBranch   = "master";
  ob1StablePinnedRevision = "446e8beda8dc96e3a2d30a7a0bd778910dd4bc07";  # current
  ```
- The runtime **and the workers** (telegram bridge, dictation import, IMAP watch)
  all run from the managed root, so the bump moves all of them together.

### Target

Bump to current master HEAD: **`e56c498373f3b9dd9e1f6ec125426657aeb36655`**.
This is a clean **fast-forward** (446e8be is an ancestor) — 14 commits, the v24
brain-selector work (Phases 1–5, 7 + acceptance tests + the setup skill). Last
prod bump precedent: OB1 commit `55cca53`.

### Steps (order matters)

1. **Migrate the PROD database FIRST.** The new resolver reads
   `estate_memberships`; the code will error if migration `009` hasn't run.
   - Same DB server as dev (`10.10.10.100`), **database `ob1`** (dev is `ob1_dev`).
   - Apply with the OB1 migration runner against prod env, or psql directly:
     ```bash
     # from an OB1 checkout, with PROD env (PGDATABASE=ob1, prod creds):
     ./scripts/apply-open-brain-local-migrations.sh
     # migration 009 is additive + idempotent (estate_memberships table +
     # brain_memberships.is_deny). 001–008 are already applied on prod.
     ```
   - Verify: `\d estate_memberships` and `\d brain_memberships` (is_deny column).
2. **Bump the pin** in `hosts/m2maxstudio.nix`:
   ```nix
   ob1StablePinnedRevision = "e56c498373f3b9dd9e1f6ec125426657aeb36655";
   ```
   (branch stays `"master"`). Commit it (e.g. `chore(ob1): bump prod 446e8be -> e56c498 (v24 brain selector)`).
3. **Rebuild** on m2maxstudio: `darwin-rebuild switch`. This materializes the new
   release at the managed root, runs `npm install`, and restarts `ob1-stable` +
   the workers. (`ob1-stable` refuses to launch unless the checkout is on
   `master` at the expected revision — a guard, not a problem.)
4. **Verify**: `curl -sf http://127.0.0.1:8787/health` on the host; check the
   ob1-stable logs; confirm an existing capture path still works (the legacy
   `MCP_ACCESS_KEY` callers — telegram bridge etc. — are unchanged by design, D7).

### ⚠️ Breaking change to announce

The `stats` MCP tool response shape changed (v24 D6): top-level `top_sources` /
`top_types` / `top_people` and the single-brain `overview` moved into a
`per_brain[]` array; top-level `overview` is now an aggregate. **No in-repo
consumer reads the moved fields** (verified), but any external agent/skill that
reads `stats.top_sources` must be updated. `similar` dropped per-result
`retrieval_strategy`/`fallback_used` (its two in-repo consumers read only
`query`+`matches`, so they are unaffected). Full detail in OB1 `docs/30`.

### Rollback

Revert the `ob1StablePinnedRevision` line to `446e8be...` and `darwin-rebuild
switch`. Migration `009` is additive (new table + nullable-default column) — safe
to leave in place; no down-migration needed.

### Owed (not blocking, but track)

- **Rotate credentials** surfaced in a dev session transcript: the `postgres`
  superuser on `10.10.10.100` (governs `ob1` and `ob1_dev`) and the Neo4j default
  password. Update Consul / the secret store + every `.env.open-brain-local` copy.

---

## 2. Distribute the OB1 skills (per-user, universal)

### How skills reach a user today (verified)

- `modules/claude-code/skills.nix` deploys a local `./skills` tree (in that
  module dir) to `~/.claude/skills/` recursively via home-manager, and makes
  `ln-6*` skills into `~/.claude/commands/*.md`.
- The Matt-Pocock fork uses a different path: `packages/matt-pocock-skills.nix`
  fetches an external skills repo at a **pinned commit** and installs it (the
  `home.activation.mattPocockSkillsInstall` flow), because those skills live in
  `luchoh/skills`, not in system-config.

### The OB1 skills to distribute

In the OB1 repo under `skills/`:
- **`ob1-estate-setup`** — user-invokable repo initializer (the one you want
  universal). `disable-model-invocation: true`.
- **`ob1-autodream-brain-sync`** — OB1-specific memory→brain sync with routing.
- **`auto-capture`** — client-agnostic/reusable (optional to ship; not `ob1-`).

### What's needed — pick one

**Option A — vendor (fastest).** Copy the `ob1-*` skill dirs into
`modules/claude-code/skills/` (the tree `skills.nix` already deploys). Re-copy on
each OB1 skill change. Lowest infra, manual sync.

**Option B — fetch pinned from OB1 (recommended; consistent with ob1-managed-source).**
Add an `ob1-skills` package/module mirroring `packages/matt-pocock-skills.nix`:
fetch the `luchoh/OB1` tarball at a pinned commit, extract `skills/ob1-*` (and
optionally `skills/auto-capture`), and deploy them into `~/.claude/skills/`
(symlink for Claude Code; real copy for Codex, per the existing matt-pocock
caveat about symlink-following). Bump the pinned OB1 commit to update — same
discipline as `ob1StablePinnedRevision`. Reuse the existing
`skills-github-token` secret for the fetch (OB1 is a private repo).

Either way the result is: `~/.claude/skills/ob1-estate-setup/SKILL.md` etc. exist
for the user on every machine, and the skill is invokable in any repo.

### After distribution — the per-repo flow (already built)

1. In a target repo, the user runs **`/ob1-estate-setup`**. It derives the slug,
   generates a scoped key locally, writes the repo's **gitignored** `.env.local`
   (`MCP_ACCESS_KEY` + `OPEN_BRAIN_BASE_URL`), and hands back a one-line command.
2. The user runs that command **in the OB1 repo**:
   `./scripts/agent_estate/provision.sh <slug> --key-hash <hash>` — registers the
   principal + brains + memberships and the key hash. The plaintext key never
   leaves the target repo.
3. `direnv allow`; agents in that repo are now the `<slug>` principal.

`ob1-estate-setup` **detects and skips the OB1 repo itself** — OB1 keeps the
legacy-admin `MCP_ACCESS_KEY` so its agents have global/debug access (owner decision).

### Dependencies / sequencing

- Skill **routing to `agent-common`** needs two things live: the v24 `brain`
  param (Part 1 deploy) **and** a provisioned `agent-common` brain. Until both
  exist, `ob1-autodream-brain-sync` passing `brain="agent-common"` is silently
  dropped to the default brain (old servers strip the unknown arg). So: deploy
  Part 1, then run `provision.sh <first-repo>` once (it creates the estate +
  common brain), before relying on routing.
- Nothing is provisioned yet — the agent estate / common brain / repo principals
  do not exist in either DB. First real `provision.sh` run creates them.
