# 52 — Handoff to the OB1 agent on M2

**You are:** an OB1-repo agent running on **M2 (m2maxstudio)**, taking over the cloud-egress boundary work from a session that ran on the M4 laptop. This is your self-contained orientation + task list (the M4 session's cross-session memory does not travel with you — everything you need is here or in the repo).
**First:** read `AGENTS.md` and `WORKING_AGREEMENT.md` (repo rules + the brain-reflex). Then this.

---

## 0. TL;DR — where we are

- **Goal of the whole program:** keep the cloud coding agents (Claude, Codex) *out of* the private/common brains (`luchoh` etc.), and stop external ingest (mail/telegram) from injecting *trusted-looking* content. That's the achievable boundary.
- **Not achievable on this OS:** making a same-user or prompt-injected agent harmless (macOS gives every process you run the same authority). We *raise the bar*, we don't close it. The fancy "identity" layer (Pi / Secure Enclave / signed agents, docs/50) is **DEFERRED** — do **not** build it unless the user re-opens it.
- **The boundary is ~80% built but DORMANT.** `OB1_EGRESS_ENFORCE` is at its default `observe` in prod → **the read-clamps confine nothing today.** The security that matters now is the boring **Stage-0** fixes (§6), not identity.
- **Your immediate job:** finish **enforce-safe ingest** (docs/51) so flipping enforce does not break Telegram/mail/dictation — this is proven-necessary (§3), half-done (code committed), half-remaining (provision keys + repoint daemons).

---

## 1. Read these, in order

| Doc | What it is |
|---|---|
| `AGENTS.md`, `WORKING_AGREEMENT.md` | repo rules; brain-reflex; git flow |
| `docs/51` | **enforce-safe ingest handover** — your immediate task (system-config side + the OB1-side helper) |
| `docs/47` | enforce rollout runbook — the staged operational model (observe → tune → enforce) |
| `docs/50` §7–§8 | the **honest residuals** + the authoritative **Stage-0 build sequence** |
| `docs/45` | FROZEN design (Rev 8) — the source of truth for the boundary's intent |
| `docs/48`, `docs/49` | prior secure-arch + AWS-SSO model. **Context only** — the SSO/Keycloak layer and docs/48 §3.4 are superseded/deferred |
| `docs/44` | veil/reflexive-capture PRD — **NOTE: WIP, may be uncommitted; not needed for the current task** |

---

## 2. Done this session (on `develop`, pushed to `origin`)

| Commit | What |
|---|---|
| `7495350` | legacy-admin key confined under enforce (`resolveRequestBrain` 404s the bare key on local-only brains, read **and write**) |
| `6cf7eba` | graph read-plane clamp (`graph_neighbors`/`source_lineage`/`why_connected` scrub local-only/restricted nodes for cloud_bound) |
| `914472b` | Layer-B per-row clamp (`clampReadRowsByEgress` + `fetchRowEgressById`) |
| `f401b22` | **external-ingest content stamped `cloud_origin + untrusted`** (`deriveCaptureStamp` gained `externalIngest`; `/ingest/thought` sets it) |
| `9f9647f` | **`scripts/provision-ingest-key.sh`** + `docs/51` handover |
| earlier | migrations `016`/`017`/`018` (egress columns + triggers + downgrade guard); the `off`/`observe`/`enforce` staging; runbook `docs/47` |

The 3 read-clamps key off `caller.readEgressClass` and are **source-agnostic** (they don't care how a caller became local_trusted). `buildPrincipalContext` (`auth.mjs:249`) is the single choke point. These are stable — don't refactor them.

---

## 3. CRITICAL live facts (verify these yourself — do not trust prose)

1. **`enforce` is OFF in prod** (`OB1_EGRESS_ENFORCE` unset → `observe`, `config.mjs`). Under `observe` the clamps *report* but do **not** block. So today, in prod, a cloud_bound key can still read a local-only brain. Confinement is *false* until you flip enforce.
2. **Prod `ob1` is UNMIGRATED** — `016`/`017`/`018` are on `ob1_dev` only. The prod flip is **release-gated** (develop → release tag → prod pin; one pin deploys all launchd services). You cannot just flip prod.
3. **Two sub-app bypasses make everything else decorative** (docs/50 §7 "R-FLOOR", verified live):
   - `config.mjs:27` `loadRepoEnv()` autoloads `.env.open-brain-local` (with `PGUSER=postgres` **superuser**) into `process.env` at import → any same-user process talks Postgres beneath the whole app layer.
   - The bare `MCP_ACCESS_KEY` (`auth.mjs:465`, `resolveLegacyAdminContext`) is a global-admin skeleton key, present on M4 too.
   These are the *actual* emergency. Retiring them is Stage-0 (a) and (b).
4. **Flipping enforce as-is BREAKS the importers** (proven on ob1_dev): Telegram/mail/dictation authenticate with the bare admin key (cloud_bound) and write to `luchoh` (private_local); the `7495350` confinement 404s that write. Fix = docs/51, applied **before** the flip.

---

## 4. Your immediate task — enforce-safe ingest (docs/51)

Being *on M2*, you can run the OB1-side directly (dev runtime + DB are local to you). Steps (full detail in docs/51):

1. **Mint a `local_trusted`, non-admin ingest key per daemon** — run against `ob1_dev` first, then (deliberately) `ob1`:
   ```bash
   PGDATABASE=ob1_dev scripts/provision-ingest-key.sh --brain luchoh --principal ingest-imap     --label imap-ingest
   PGDATABASE=ob1_dev scripts/provision-ingest-key.sh --brain luchoh --principal ingest-telegram --label telegram-ingest
   PGDATABASE=ob1_dev scripts/provision-ingest-key.sh --brain luchoh --principal ingest-dictation --label dictation-ingest
   ```
   It prints the plaintext key once (stores only the sha256). Requires `PGUSER`/`PGPASSWORD` + Consul (or `PGHOST`/`PGPORT`).
2. **system-config side** (agenix secret per key + repoint each daemon's `openBrain.accessKeyFile` off `ob1-ingest-access-key` onto its per-source secret). **`system-config` is READ-ONLY from OB1** (hard rule — a separate repo/agent owns it). Confirm who applies it; you hand them the keys + docs/51.
3. **Smoke-test each pipeline under enforce** — you can do this **locally on M2** (dev runtime is `::1:8787`). Send a test email / telegram / dictation; confirm a row lands stamped `cloud_origin | untrusted`.
4. **Sequence (never breaks the services):** mint → repoint → test each → flip enforce → retire the bare key **last**. Fully reversible.

---

## 5. Operating on M2 (the recipe that works)

- **Dev runtime:** `http://[::1]:8787` (loopback — reachable from M2 itself). **DB:** `ob1_dev` via Consul (`10.10.10.100:5432`).
- **Testing NEW code you write:** the *running* M2 dev runtime may not have your latest commits — start your **own** local runtime on your branch (`node local/open-brain-mcp/src/index.mjs`, it binds `:8787`) or restart the dev service on your branch. Don't assume the deployed process is current.
- **NEVER run write-tests against `ob1-stable` (`:8788`) or the `ob1` DB — that is PROD** (`PGDATABASE=ob1`, graph `ob1-graph`). Reads/`/health` are fine; writes pollute the real `luchoh` brain.
- **The exact smoke-test that proved the ingest fix** (adapt the key):
  ```bash
  # under a local runtime on ob1_dev, OB1_EGRESS_ENFORCE=enforce:
  curl -s -H "x-access-key: $KEY" -H "x-ingest-key: $KEY" -H 'content-type: application/json' \
    -X POST http://localhost:8787/ingest/thought \
    -d '{"content":"zzt test","source":"imap","type":"email","dedupe_key":"zzt-smoke-1"}'
  # expect a written thought; then check the stamp:
  #   select origin_egress_class, source_trust_class, sensitivity_tier
  #     from thoughts where dedupe_key='zzt-smoke-1';   -- cloud_origin | untrusted | standard
  ```
  Always use `zzt-` prefixes + a cleanup trap; use `BEGIN … ROLLBACK` for trigger tests so dev data is untouched.

---

## 6. The Stage-0 sequence (docs/50 §8) — the ordered path to a real boundary

This is where the security is. Do it in order; nothing identity-related ships until it's done.
- **(a)** Retire the PG-superuser `.env` autoload (`config.mjs:27`) → least-priv `ob1_app` role; remove import-time side effect. Strip the secret dotenv + bare key from **M4**.
- **(b)** Retire the bare `MCP_ACCESS_KEY` global-admin path (`auth.mjs:465`).
- **(c)** Untrusted stamping — **PARTIALLY DONE** (`f401b22` covers `/ingest/thought`). Remaining: a wire `source_trust_class` field for finer control + a `write_trust_class` key attribute.
- **(d)** DB-enforce **carry-taint-forward on the INSERT path** — the `016` monotone-taint trigger is `BEFORE UPDATE` only, so a fresh INSERT can launder `cloud_origin → local_trusted`. Add an INSERT trigger/CHECK + a promote verb (no `SECURITY DEFINER` bypass).
- **(e)** Classify every brain's `egress_class` (which become `repo`/cloud-readable vs stay `private_local`), then **flip enforce** — dev, then prod (release-gated). Add a boot assertion that refuses to claim confinement while not `enforce`.

Stages 1–3 (request-signing + Keychain ACLs, then Pi, then AF_UNIX code-attestation) are **DEFERRED** — see docs/50; only pursue if the user re-opens the identity layer.

---

## 7. Guardrails (hard rules)

- **Git flow:** commit to `develop`, **never** `main`/`master`. `main` is upstream/community. Push to `origin` (`git@github.com:luchoh/OB1.git`), **never** `upstream` (NateBJones-Projects).
- **`system-config` is READ-ONLY** — look but don't touch; it's a separate repo/agent. OB1 is the only repo you write to.
- **Brain-reflex:** search the brain before acting, capture decisions the same turn, verify stored. NOTE: the `mcp__ob1__` tools point at **prod `luchoh`** — engineering captures ideally belong in a work/`ob1` brain, not `luchoh`.
- **Test on `ob1_dev`, never prod.** `enforce` is instantly reversible (`observe` + restart, data-free).
- **Doubt yourself, especially quick conclusions.** This session had *two* confident-wrong reassurances that a smoke test caught (e.g. "enforce won't break the importers" — it does). **Prove with a test; don't assert.**

---

## 8. Pending decisions (the user's call — confirm before acting)

- **Scope line:** the user was reassessing the whole program and leaning **"Core only"** — finish + flip enforce, defer all identity/Pi/veil work. Confirm before building anything in Stages 1–3.
- **Brain classification for the flip:** `luchoh` = `private_local` (locked). Cloud agents use per-repo `repo`-class brains. Decide each prod brain's class before flipping (getting it wrong = lockout or leak).
- **Ingest target brain:** docs/51 mints ingest keys defaulting to `luchoh` (preserves current visibility). A holding/quarantine brain + promotion is a stronger, later option that changes visibility — separate decision.
- **Expose M2 dev to `0.0.0.0`:** only needed if a *remote* agent must validate the deployed dev runtime; not needed for local M2 work.

---

## 9. Pointers

- Design docs: `docs/44`–`docs/52` (44 veil-WIP, 45 frozen design, 47 runbook, 48/49/50 secure-arch/SSO/signed-agent, 51 ingest handoff, 52 this doc).
- The enforce/ingest work was verified on `ob1_dev` via a local runtime; the M2 dev runtime is loopback-only (fine for you, unreachable from M4).
- When in doubt about a live fact (enforce mode, migrations, a brain's class, a key's egress), **query the DB / `/health` and verify** — this doc is a point-in-time snapshot.
