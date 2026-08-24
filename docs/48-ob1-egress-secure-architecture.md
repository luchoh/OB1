# 48 — OB1 Secure Architecture Proposal (Enforce-Flip Gating Design)

**Status:** Gating design for implementation — approve before code. **⚠️ PARTIALLY SUPERSEDED 2026-06-26 by [docs/49](49-ob1-local-trusted-sso-session-model.md):** the human-write-path (§3.4 operator standing `local_trusted` key + second listener) is **retired** in favour of an ephemeral AWS-SSO-style browser-IdP session (no standing `local_trusted` key anywhere). §3.2/I4 (`write_trust_class`/taint), §3.1/§3.3/I2/I7 (PG superuser + `MCP_ACCESS_KEY`), §4 transport, and §6 residuals are re-scoped there. The custody/trust-axis/scoped-ingest analysis below remains valid; read docs/49 for the `local_trusted` model.
**Date:** 2026-06-25.
**Provenance:** produced by a fanned-out design + adversarial red-team pass (1 threat-model lead → 4 area designers → 4 red-teamers → 1 architect synthesis), then fact-checked live by the operator's session. Several premises in the raw area-designs were **false** and are corrected inline (see the verified-facts box).
**Operator decisions already baked in (grilling 2026-06-25):** flip `OB1_EGRESS_ENFORCE=enforce` soon; `pi` = distinct `local_trusted` principal; `luchoh` brain stays `private_local`; cloud agents use per-repo repo-class brains; provision an operator `local_trusted` admin key and retire the bare `MCP_ACCESS_KEY`. Telemetry data-at-rest accepted as on-box for v1.

> ### Verified live 2026-06-25 (corrections to the raw design)
> - **The ingest/admin key is `bothHosts`, and it is ON THE LAPTOP (M4).** `secrets/secrets.nix:54` → `"ob1-ingest-access-key.age".publicKeys = bothHosts`. On `mbprm4` (M4), `/run/agenix/ob1-ingest-access-key` (0400 `luchoh`) is **byte-identical** to `.env.open-brain-local:MCP_ACCESS_KEY` — the bare key that resolves to **global admin** via `resolveLegacyAdminContext`. The red-team's "m2Only / not on M4" correction was **wrong**; the original finding stands.
> - **M4 holds the full secret set.** `.env.open-brain-local` on the laptop (0600 `luchoh`) defines `PGPASSWORD`, `IMAP_PASSWORD`, `MINIO_ACCESS_KEY/SECRET_KEY`, `CONSUL_HTTP_TOKEN`, `MCP_ACCESS_KEY`. So **"M4 only holds a scoped key" is FALSE** — a cloud coding harness on the laptop already has (a) a remotely-presentable global-admin key and (b) the Postgres password (a direct-to-prod-DB bypass of the entire egress layer). The M2/M4 physical split protects much less than assumed; what is M2-only is the *running service* + a few `m2Only` secrets (telegram tokens, the IMAP env bundle), not the OB1 admin key or PG password.
> - **Prod `ob1` is NOT migrated.** Migrations 016/017/018 are present only on `ob1_dev`; prod has no `egress_class`/`read_egress_class` columns. The enforce flip on prod is therefore release-gated (develop → release tag → prod pin) *in addition to* the work below.
> - **Telegram bridge location:** `integrations/telegram-capture/telegram_bridge.py` (the red-team couldn't find it at the cited path; it exists).
> - **Grounding verified in code:** `deriveCaptureStamp` hardcodes `sourceTrustClass = TRUSTED` (`access-policy.mjs:664`) with a comment (:656) describing an untrusted-ingest path that **does not exist**; `assessTrust` (`access-policy.mjs:562`) already computes trust as worst-of(writer-taint × content-trust) — the read-side primitive exists but is unwired from the writer; `resolveLegacyAdminContext` returns `isAdmin:true` whenever `key === config.accessKey` (`auth.mjs:465,532`); `loadRepoEnv()` runs at import (`config.mjs:27`); migration 016 adds the trust columns to the `thoughts` **table**, but `match_thoughts`'s `RETURNS TABLE` (latest def ≤015) does **not** expose them — so evidence rows ship `trust=null` unless enriched; `models.mjs:374-377` answer prompt carries no provenance/trust instruction.

---

## 1. Threat model & invariants (condensed)

### Attacker positions (ranked by live exploitability × blast radius)

1. **Remote emailer → IMAP importer (HIGHEST live severity).** Arbitrary external content (prompt-injection, forged provenance) enters via `recipes/email-history-import/import-imap.py → POST /ingest/thought`, authenticated with the bare `MCP_ACCESS_KEY` (== `config.accessKey`). It resolves to **global admin / cloud_bound**, and `deriveCaptureStamp` stamps it **trusted + standard**, `review_state=none` → fully retrievable and fed to the answer model with **no trust caveat**. `enforce` does **not** close this channel (legacy-admin writes are not egress-filtered).
2. **Same-user process holding the secrets (strongest, enforce-PROOF) — and now confirmed on BOTH M2 and M4.** Any `luchoh` process reads `/run/agenix/*` (0400) and the in-repo `.env.open-brain-local`, which `loadRepoEnv()` autoloads into `process.env` at import — injecting the **Postgres superuser** login plus Neo4j/MinIO/IMAP/Consul secrets and every key string. Superuser SQL bypasses the entire app egress/ACL/clamp layer. **Verified: this holds on the laptop (M4) where the coding harnesses actually run, not just on M2.** `enforce` does nothing here.
3. **Leaked bare ingest/admin key.** `key === config.accessKey` ⇒ global admin presentable to the public MCP endpoint (`ob1.lincoln.luchoh.net`): read (clamped), **delete/purge** (`isAdmin` gates), re-point. One string is the master credential. **Verified `bothHosts` — it is on M4 and M2.** `enforce` does not revoke it.
4. **Trust-laundering re-capture.** A `local_trusted` write that re-captures/edits cloud-origin/untrusted content re-stamps it `local_trusted + trusted` — no source taint carry-forward at write time. (Read-side `assessTrust` is monotone, but the **write** path can still mint a fresh clean row.)
5. **Cloud harness with a scoped `cloud_bound` per-repo key.** The *intended* contained position under enforce (016/018 + brain confinement + per-row/graph clamp). Residual: `deriveCaptureStamp` lets its authored/relayed content land **trusted**, and the answer model treats retrieved cloud-origin evidence as authoritative.
6. **Telegram sender.** Same skeleton-key write path as mail, but gated by `TELEGRAM_REVIEW_MODE=full` (human Commit) + chat-id allow-list. Lower live risk; collapses to the mail position if config is downgraded.
7. **Principal-borrow (`pi`'s bearer).** A `luchoh` process reads `pi`'s key string ⇒ *is* `pi`. Principal separation is a DB/logical distinction with **no OS isolation** on darwin/launchd (no `DynamicUser` equivalent).

### Invariants (the design must hold all)

- **I1 — Fail-closed everywhere.** Unknown/absent caller egress, unparseable processor URL, missing brain egress_class, missing `source_trust_class` ⇒ most-restricted outcome (`cloud_origin` / local-only / deny / quarantine / **untrusted**). Never default to trusted/standard.
- **I2 — No skeleton key.** Server-admin, ingest-write, and per-pipeline write authority are **separate least-privilege credentials**; the remotely-presentable `resolveLegacyAdminContext` global-admin path is retired and replaced by a deliberately-issued operator `local_trusted` admin key.
- **I3 — Externally-authored ⇒ untrusted.** Any content whose author is not a `local_trusted` principal (mail, telegram, import, cloud-origin captures) is stamped `source_trust_class='untrusted'` on ingest. The wire schema carries `source_trust_class`; the hardcoded `'trusted'` in `deriveCaptureStamp` is removed; the path the :656 comment promises is built.
- **I4 — Trust taint is monotone, never laundered.** A `local_trusted` re-capture/edit of untrusted/cloud_origin content **preserves** the more-restrictive source trust + origin.
- **I5 — Authority is credential/process-bound, not string-readability-bound.** Reading a `local_trusted` key string must not confer secret-custody/admin authority. `local_trusted` **read ≠ write/admin/secret** authority.
- **I6 — Enforce closes the mail channel.** Under enforce, externally-authored ingest is egress-filtered (untrusted + quarantine, or deny), never exempt via an unfiltered global-admin path.
- **I7 — No SQL-level ACL bypass.** The app egress/ACL/clamp layer is the only write path to brain data. No in-repo entrypoint obtains a Postgres superuser (or any ACL-bypassing) login by importing config.
- **I8 — Provenance reaches the answer model.** Retrieved evidence carries `source_trust_class`/origin to the grounded-answer prompt; the model is instructed to treat untrusted/cloud-origin/quarantined content as **non-authoritative**.
- **I9 — Principal separation is enforced, not advisory** (target end-state; bounded by darwin reality — see §6).

---

## 2. Target architecture (end-state, one coherent whole)

Four axes interlock. **Custody constrains the write path** (no credential-bound trust axis is meaningful while a same-user process holds superuser SQL); the **ingest-principal decision carries the trust axis** (trust rides the key); the **human write path** depends on both (the operator key must be a non-skeleton credential the trust stamp can attribute as trusted).

**Custody (the dominant root — now confirmed an M4 problem too).** OB1 daemons on M2 run as a dedicated `_ob1` service account; the secret `.env.open-brain-local` is **deleted from the luchoh-owned repo** and re-delivered via agenix as `_ob1:_ob1 0400`, with the in-repo `.env` holding only non-secret host/port/dbname defaults. `loadRepoEnv()` autoload is removed (opt-in `OB1_LOAD_REPO_ENV` for tests). DB connects as a **least-privilege `ob1_app` role** (not superuser). Neo4j + MinIO creds move under `_ob1` **in the same slice**. **And on M4:** the `bothHosts` skeleton key + secret dotenv must be removed from the laptop entirely — a coding-harness host should hold **only** its scoped `cloud_bound` per-repo key, never the admin key or PG password. This converts positions 2/3/7 from *enforce-proof* to *contained* — explicitly **not** universally closed (see §6 residuals).

**Trust axis (credential-bound, not writer-declared).** Each principal/key carries a new `write_trust_class` (column on `brain_access_keys`, mirrors 017). `deriveCaptureStamp` computes `sourceTrustClass = TRUSTED` **only if** `caller.writeTrustClass === TRUSTED` **AND** `caller.readEgressClass === LOCAL_TRUSTED`; otherwise `UNTRUSTED` (fail-closed, I1). The wire schema *also* gains `source_trust_class` so importers may **ratchet toward untrusted**, never up to trusted. The read side already has worst-of `assessTrust`; we feed it real values and extend `match_thoughts`/evidence so both axes are live end-to-end.

**Scoped ingest.** `config.accessKey` is repointed to a dedicated **server-identity** secret so a presented importer key no longer hits `resolveLegacyAdminContext`. Per-source **non-admin `cloud_bound`** principals (enumerate the *actual six* M2 consumers: `ob1-stable`, `ob1-imap-watch`, `ob1-telegram-bridge(s)`, `ob1-dictation-import(s)` — incl. plural variants and dictation's two surfaces) each get `write_trust_class=untrusted` and a default **holding brain**. Mail-class ingest additionally gets an `untrusted ⇒ review_state=unreviewed` rule in `deriveCaptureStamp` so the **row** quarantines — because standard tier never triggers the existing `cloud_origin+restricted ⇒ unreviewed` path, and a `quarantine_review` *brain* confines egress but does **not** mark rows unreviewed.

**Human write path.** The operator gets a deliberately-issued `local_trusted` admin principal + key (replacing the bare key). Operator writes are attributable-trusted **only because** the trust axis is wired (without it, operator == mail at the stamp). A **second 127.0.0.1-only listener** carries a trusted-transport marker; `local_trusted` resolution is clamped to marked requests; the **public listener downgrades `local_trusted` → `cloud_bound` regardless of key**, so a leaked operator key on the public endpoint is inert. `local_trusted` keys are refused via `?key=` (header/bearer only). Headless operator automation routes through the loopback listener or is disallowed — **never** a fallback key file.

**Answer model.** `match_thoughts`/`match_thoughts_recency` return (or `askBrain` enriches via the already-called `fetchRowEgressById` map) `source_trust_class/origin_egress_class/review_state`; evidence is split into **two arrays — trusted and untrusted** — and the prompt instructs the model to treat untrusted/cloud-origin/quarantined items as non-authoritative leads, never truth anchors.

---

## 3. Per-area decisions (chosen option + why, red-team fixes folded in)

### 3.1 Custody — adopt `_ob1` service account + secret-file relocation + least-priv `ob1_app`; **defer the pg_hba `scram` flip**; **strip the skeleton key + secret dotenv from M4**.
- **Why:** Same-user custody is the root of the strongest positions, and it is now confirmed live on the laptop, not just M2.
- **Red-team fixes folded in:** (a) **make relocation concrete** — *delete* the secret `.env.open-brain-local` from the luchoh repo and agenix-deliver it to `_ob1`; killing only the autoload is cosmetic while the file is still `cat`-able. (b) **Do NOT flip global `local all all trust` → scram in v1** — it can brick the managed-DB provisioner (CREATE EXTENSION over the local socket) for all three prod DBs; get the win from the `ob1_app` least-priv role alone, defer scram to a maintenance window with tested rollback. (c) **`_ob1` toolchain:** a bare `knownUsers` darwin account has **no** `/etc/profiles/per-user/_ob1/bin`; pin interpreter/tool paths as absolute nix-store paths in the wrapper and validate `sudo -u _ob1 /path/to/wrapper` execs **before** flipping any `UserName`. (d) **Pull Neo4j + MinIO custody into the same slice** — else the bypass merely moves from PG to graph/blob. (e) **Honesty:** an `ob1_app` that *owns* its tables still bypasses the JS egress layer at SQL level — this is blast-radius reduction, **not** closure of I7 (true closure needs RLS/policy-in-PG or removing direct DB creds from the harness surface). (f) **New, from live check:** remove `/run/agenix/ob1-ingest-access-key` and the secret dotenv from M4 — the laptop is a harness host and must hold only its scoped key.

### 3.2 Trust axis — credential-bound; ship write-side + read-side in v1; defer holding-brain ask UX.
- **Why:** Wire-declared trust is forgeable by exactly the modeled attackers; credential-bound is tamper-resistant. `assessTrust` already implements the correct two-axis worst-of logic — we only need to feed it real values.
- **Red-team fixes folded in:** (a) **`deriveCaptureStamp` fail-closes:** `UNTRUSTED` unless `writeTrustClass===TRUSTED && readEgressClass===LOCAL_TRUSTED`. Thread `writeTrustClass` through the single choke point `buildPrincipalContext` (`auth.mjs:249`) for **all three** caller shapes (stored-key, anon, legacy) — miss one and it fails *closed* to untrusted (I1). (b) **"projection-only effort-S" is FALSE** — `match_thoughts` `RETURNS TABLE` (≤015) does **not** expose the trust columns; `select *` reads the function's table, not `thoughts`. **Required v1:** migrate both `match_thoughts`/`match_thoughts_recency` to add the three output columns, **or** (preferred, no migration) enrich evidence in `askBrain` from the **already-called** `fetchRowEgressById` map before `evidenceCitation`. (c) **Structural boundary:** split evidence into **two arrays (trusted/untrusted)**, not a single soft-tagged array, so injection can't ride a model ignoring a skepticism instruction. (d) **`write_trust_class` column** on `brain_access_keys` (additive, NULL⇒untrusted); a reviewed migration backfills rows the old hardcode stamped `trusted`.
- **Explicit non-claims:** this does **not** retire the leaked bare key (it stays global-admin with delete/purge/read — only its *writes* down-stamp), and does **not** touch the PG-superuser SQL bypass or same-user custody.

### 3.3 Scoped ingest — server-identity decouple + non-admin per-source `cloud_bound` principals + holding brain; **bundled with the wire/stamp change (never standalone)**.
- **Why:** `resolveLegacyAdminContext` fires only on `key === config.accessKey` (verified `auth.mjs:532`), so repointing `config.accessKey` to a server-identity secret cleanly demotes every importer key out of global admin.
- **Red-team fixes folded in:** (a) **Correct premises with the live facts** — ingest key **is `bothHosts` and on M4** (not m2Only); the M4-harness-holds-it case is **real**, not phantom. (b) **Enumerate all six consumers** + decide singular-vs-plural topology and dictation's two surfaces **before** minting keys. (c) **The split ALONE leaves mail trusted+standard** — co-require the trust-axis wire change (§3.2) + the `untrusted ⇒ unreviewed` rule so **rows** actually quarantine. (d) `provision.sh` writes `read_egress_class` **and** `write_trust_class` in **both** insert branches + any `ON CONFLICT DO UPDATE` set-list; confirm cols 016/017/018 are live (they are **not** on prod yet — Phase 0).
- **Honest scope:** scopes a *leaked* key's blast radius; does **nothing** for same-user custody until §3.1.

### 3.4 Human write path — operator `local_trusted` admin principal + second loopback listener; **necessary-not-sufficient (NOT the enforce gate)**.
- **Why:** `resolveStoredAccessKeyContext` already fail-closes non-`local_trusted` to `cloud_bound` (verified `auth.mjs:419-460`), so a properly-issued operator key is a sound attributable write path.
- **Red-team fixes folded in:** (a) **Drop the peer-address `auth.mjs` variant** — no peer read exists and there is a single listener; build a **distinct 127.0.0.1-only listener** with a trusted-transport marker and clamp `local_trusted` to it; public listener **downgrades** `local_trusted`. (M-effort.) (b) **Reject `?key=` for `local_trusted` in v1** (authKey reads query first — log/shell-history leak). (c) Operator path is **not** trust-distinguishable from mail until §3.2 ships ⇒ hard co-requisite. (d) **Headless policy decided now:** loopback listener or disallow — never a fallback key file (Keychain-over-SSH is locked per `ssh-auth.nix`). (e) The optional broker is end-state only; it stops a **confused deputy**, not an active same-user adversary, and its on-box audit sink is itself same-user-tamperable unless shipped to an external append-only boundary.

---

## 4. What must change — code (OB1) vs config (system-config, READ-ONLY)

### Code — OB1 (`local/open-brain-mcp/`, `recipes/`)
- **`access-policy.mjs`** — remove hardcoded `sourceTrustClass = TRUSTED` (:664); make `deriveCaptureStamp` consume `caller.writeTrustClass`, fail-closed-untrusted unless `writeTrustClass===TRUSTED && readEgressClass===LOCAL_TRUSTED`; add `untrusted ⇒ review_state=unreviewed`; preserve source taint on re-capture/edit (I4); make the :656 comment's promise real.
- **`auth.mjs`** — thread `writeTrustClass` through `buildPrincipalContext` (:249) for all three caller shapes; add public-listener `local_trusted`→`cloud_bound` downgrade; reject `?key=` for `local_trusted`; clamp `local_trusted` to the trusted-transport marker.
- **`config.mjs`** — remove `loadRepoEnv()` import-time autoload (:27); gate behind `OB1_LOAD_REPO_ENV`.
- **`index.mjs`** — add the second 127.0.0.1-only listener with a trusted-transport marker.
- **`server.mjs`** — add `source_trust_class` (+`origin_egress_class`) to `captureThoughtSchema` and `/ingest/thought` plumbing (ratchet-toward-untrusted only).
- **`models.mjs`** — split evidence into trusted/untrusted arrays; add the provenance/non-authoritative instruction (:374-377); project trust class in `sanitizeEvidenceItems`.
- **Retrieval** — migrate `match_thoughts`/`match_thoughts_recency` `RETURNS TABLE` to expose the three columns, **or** enrich from `fetchRowEgressById` in `askBrain` (preferred).
- **Migrations** — add `write_trust_class` to `brain_access_keys` (additive, NULL⇒untrusted); reviewed backfill UPDATE for rows the old hardcode stamped trusted.
- **`provision.sh`** — write `read_egress_class` + `write_trust_class` in both insert branches + ON CONFLICT set-lists; a **non-bootstrap** one-shot admin-key issuance path (§5 Step 0) that does **not** re-register `MCP_ACCESS_KEY`.
- **Recipes** — `import-imap.py`: repoint `OPEN_BRAIN_INGEST_KEY` to the scoped untrusted mail key (one env swap). Confirm `integrations/telegram-capture/telegram_bridge.py` shares the same env key before scoping.

### Config — system-config (READ-ONLY; describe, operator executes)
- **secrets.nix** — add a `m2Only` `ob1-server-identity` secret (new `config.accessKey` source) + per-source ingest secrets + an operator `local_trusted` admin secret. **Re-scope `ob1-ingest-access-key` off `bothHosts`** so it stops decrypting on M4.
- **ob1-stable.nix** — repoint `accessKeyFile` to the server-identity secret; keep non-null (sequence with operator-key provisioning so admin env isn't void mid-deploy).
- **Service modules (six M2 consumers + ob1-stable)** — run under `_ob1`; absolute nix-store tool paths; grant `_ob1` repo/state traversal; chown `/usr/local/var/ob1-*` + review-state dirs.
- **agenix** — re-deliver `.env.open-brain-local` (secrets) as `_ob1:_ob1 0400`; move Neo4j/MinIO under `_ob1`.
- **managed-databases** — least-priv `ob1_app` role (non-superuser) + `PGUSER` change; **do not** flip global `local all all trust` in v1.
- **M4 (mbprm4) / codex-cli** — stop decrypting the ingest key on M4 and remove the secret dotenv; the laptop holds only the scoped per-repo key.
- **bootstrap** — gate auto-registration of `MCP_ACCESS_KEY`-as-admin behind an explicit flag (known gotcha).

---

## 5. Sequenced rollout (exploitability × cost)

**Gating principle:** the enforce flip is gated by the **mail channel + skeleton key + wire schema + PG-superuser/.env autoload + M4 secret removal** — *not* by the operator transport, the broker, the pg_hba scram, or the holding-brain UX. No single area's v1 may signal "enforce unblocked." (Prod also needs migrations 016/017/018 shipped via a release tag — they are dev-only today.)

### Phase 0 — Pre-flight (no lockout, no regression)
- **Step 0 (HARD PREREQUISITE):** issue a single deliberately-scoped admin key via a **non-bootstrap** one-shot path (direct hashed-key insert under controlled custody, or bootstrap-with-auto-admin-disabled) — **must not** re-bless `MCP_ACCESS_KEY`. Use it once to create the operator `local_trusted` admin principal/key; verify; deactivate the one-shot key. *(Zero active admin keys since 2026-06-13; the naive bootstrap route regresses the retirement in flight.)*
- Ship migrations 016/017/018 + the egress code to prod via a release tag (prod is unmigrated).
- Validate `sudo -u _ob1 /path/to/wrapper` execs with absolute tool paths.

### Phase A — Must close BEFORE the enforce flip
1. **Mail-injection channel (HIGHEST).** Scoped `cloud_bound write_trust_class=untrusted` mail principal + holding brain; repoint `import-imap.py`; ship the **wire schema + `deriveCaptureStamp` un-hardcode + `untrusted⇒unreviewed`** co-slice so injected mail lands untrusted + quarantined, egress-filtered. *(I3, I6.)*
2. **Skeleton-key retirement.** Server-identity decouple; remove the remotely-presentable `resolveLegacyAdminContext` global-admin branch; per-source key split; public-listener `local_trusted`-reject; **re-scope `ob1-ingest-access-key` off M4**. Sequence with Step 0. *(I2.)*
3. **Custody — PG superuser + .env autoload + secret-file relocation, M2 *and* M4.** Remove `loadRepoEnv()` autoload; delete secret `.env` from repos, agenix-deliver to `_ob1`; least-priv `ob1_app`; move Neo4j/MinIO under `_ob1`; strip M4 secrets. *(I7 partial, partial I5 — blast-radius reduction, not full I7 closure.)*
4. **Provenance to the answer model.** Two-array trusted/untrusted evidence + prompt instruction + `match_thoughts` enrichment. *(I8.)*
5. **Verify enforce read-safety on real data** — confirm no `cloud_bound` caller reads luchoh's `private_local` rows once the key split lands (validates H1 `1a7d596` on prod data).

### Phase B — After the flip
6. Operator second-loopback listener + `?key=`-reject hardening *(necessary, not the gate)*.
7. Holding-brain `ask_brain` review/promote UX. Until then, the two-array boundary + quarantine keeps untrusted mail off the trusted prompt path.
8. pg_hba `local all all trust` → scram *(maintenance window + tested rollback)*.
9. RLS/policy-in-PG or full DB-cred removal from the harness surface *(true I7 closure)*.
10. Broker for headless/confused-deputy operator writes *(precisely-bounded guarantee)*.
11. `pi` principal-separation hardening *(bounded by darwin — §6)*.

---

## 6. Accepted residuals & open questions

### Accepted residuals (post-Phase-A, under enforce)
- **R1 — Same-user active adversary not fully closed.** Darwin/launchd has **no per-service-user enforcement** (no `DynamicUser`); `_ob1` + least-priv is *contained*, but an active malicious `luchoh` process can scrape an unlocked session/capability and borrow authority. I5/I9 are approximated, not OS-enforced. **Dominant residual.**
- **R2 — `ob1_app` table-owner still bypasses the JS egress layer at SQL level** until RLS/policy-in-PG (Phase B #9).
- **R3 — Leaked operator `local_trusted` key on M2** is inert on the public endpoint but valid on the loopback listener for a co-resident process (same-user residual, R1).
- **R4 — Pre-promotion review UX gap.** Until #7, quarantined mail is invisible to `ask_brain`.
- **R5 — Backfill** of historically trusted-stamped external rows needs a reviewed corrective migration (`assessTrust` fail-closes NULL⇒untrusted on read, but explicitly-`trusted` rows need the keyed UPDATE).

### Open questions (operator decides before/at implementation)
1. **Telegram trust:** operator-*committed* (human-gated) telegram notes will read as **untrusted** under credential-bound trust. Accept, or carve a trusted operator-commit path?
2. **Tunnel/traefik topology:** does the public tunnel deliver traffic as a `127.0.0.1` peer? If so the loopback signal collapses and the second listener must be a non-Consul-registered, separately-bound port. **Confirm against system-config before relying on the marker.**
3. **Dictation topology:** one principal or two for dictation's two surfaces; singular vs plural service variants.
4. **Headless operator automation:** broker, or disallow? (No fallback key file.)
5. **`pi` separation depth:** accept advisory DB-level separation (R1 reality on darwin), or invest in a broker/remote-attestation path?
6. **`match_thoughts` migration vs `askBrain` enrichment** as the single trust source.
7. **M4 hardening scope:** is removing the skeleton key + secret dotenv from the laptop (and re-scoping `ob1-ingest-access-key` off `bothHosts`) acceptable operationally, or do M4-resident recipes need a scoped ingest key of their own?
