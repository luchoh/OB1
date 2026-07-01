# 49 — OB1 `local_trusted` Access — Updated Architecture (AWS-SSO Session Model)

**Status:** Authoritative. Supersedes docs/48 §3.4 (operator standing-key + second-listener design) and the prior "loopback = local_trusted" trust-topology. Locks the **ephemeral browser-IdP session** model ("same as `aws sso login`", operator-locked 2026-06-26) with the red-team residuals folded in as hard constraints, not deferred footnotes.
**Provenance:** produced by a fanned-out re-evaluation (1 model-spec → 5 per-artifact re-evaluators → 5 adversarial red-teamers → 1 architect synthesis) of the implementation shipped this session against the SSO model; every code citation independently verified by the red-team. All file:line citations are against live code on `develop`.

**Operator lock summary:** the boundary is **credential scope + server enforcement**, never machine location. The red-team proved "drop location, token-sufficient" is only safe when three things hold simultaneously — **(a)** the token is sender-constrained (DPoP), **(b)** the privilege-lift is fail-closed-on-slip and gated on a *fresh* gesture, **(c)** the taint-laundering write path is closed *first*. None hold today, so the model ships in **staged scopes**, not one flip.

> ### Headline for the impatient
> - **What I shipped this session is sound and KEPT.** The three read-confinement clamps (legacy-admin confinement `7495350`, graph-plane scrub `6cf7eba`, per-row clamp `914472b`) key off `caller.readEgressClass` and are **source-agnostic** — they don't care whether `local_trusted` came from a key or an SSO session. `buildPrincipalContext` (`auth.mjs:249`) is the single parameterized choke point. Verified, zero change required (one hardening: generalize `brainIsLocalOnly` to drop its `kind` gate).
> - **The danger is entirely net-new** in the SSO authority layer. Six critical/high holes (acr≠freshness, audience confusion, header-injection, algorithm-confusion, device-flow phishing, promotion-laundering) must all be closed *in the same commit* that lifts conferral.
> - **`migration 017`'s per-key `local_trusted` becomes vestigial** (no key is ever `local_trusted` again) — deprecate the column, keep the `CALLER_EGRESS_CLASS.LOCAL_TRUSTED` value (the SSO path sets it dynamically).

---

## 1. The AWS-SSO Session Model — Final Spec

### 1.1 Login flow

**Actors:** `ob1 login` CLI (public client `ob1-cli`, no secret) · Keycloak realm `lincoln` (issuer `https://auth.lincoln.luchoh.net/realms/lincoln`) · operator browser/authenticator · OB1 resource server (`aud:ob1`).

**Grant decision — SPLIT by attendedness (revised from a blanket device-grant).** RFC 8628 device grant is natively phishable (an attacker initiates the request, relays `verification_uri_complete`; the operator's *real* WebAuthn gesture authorizes the *attacker's* `device_code` — WebAuthn does not defend this). Therefore:
- **Interactive / attended:** **authorization-code + PKCE + loopback redirect.** PKCE cryptographically binds the issued code to the initiating CLI process, eliminating the relay vector. The loopback listener here is a *transient redirect receiver on an OS-assigned ephemeral port*, opened for one login and closed — **not** the standing "second listener" of docs/48 §3.4 (retired); it confers no runtime trust.
- **Headless / SSH only:** RFC 8628 device grant with mandatory mitigations — short `expires_in`, realm rate-limit on device-auth initiation, verification page displays the requesting client + a CLI-printed binding code the operator confirms, and prefer `verification_uri` *without* embedded code (force manual `user_code` entry).

UX parity with `aws sso login` is preserved for headless; attended is strictly safer than parity.

### 1.2 What confers `local_trusted` — the IFF (fail-closed, affirmative-upgrade)

Today `resolveHumanAccessContext` (`auth.mjs:407-416`) hardcodes `isAdmin:false`/`CLOUD_BOUND` — a fail-SAFE constant a bug can only *under*-privilege. We replace it with a conjunction where **`CLOUD_BOUND` stays the structural default and each clause AFFIRMATIVELY upgrades** (an absent/unknown claim keeps the caller `cloud_bound`, never a throw landing in a default-true branch). Confers `readEgressClass = LOCAL_TRUSTED` **iff ALL hold**:

1. **JWT signature valid** against realm JWKS, **`algorithms:['RS256']` pinned** (net-new; `verifyHumanJwt` at `auth.mjs:75-85` pins none today).
2. `iss === configured issuer`.
3. **`aud` is EXACTLY `['ob1']`** — not jose's array-containment match (jose accepts any token whose `aud` *contains* `ob1`; a token minted for another client with `ob1` injected would pass). Assert exact audience post-verify.
4. **`azp === 'ob1-cli'`** — pin the authorized party; audience-pinning alone is config-fragile.
5. **`exp` not passed** (jose) **AND freshness floor:** `now − auth_time ≤ STEP_UP_MAX_AGE`.
6. **`acr ∈ {ob1-stepup}` AND `amr` contains a WebAuthn method** (`acr` alone is a realm label a misconfigured LoA map can stamp on a cookie-only session; `amr` asserts the method actually used).
7. **`sub` resolves** to an active `principal_identity_bindings` row (`auth.mjs:378-401`).

If 1–4,7 hold but 5 or 6 fail → caller authenticates as **`cloud_bound`, non-admin** (graceful degrade to today's behavior). If 1–4 or 7 fail → 401/403.

**`isAdmin` is NOT conferred by this IFF in v1.** The SSO session grants `local_trusted` READ and (post-§4) attributable trusted WRITE, **never global admin**. Admin stays an explicit, separately-provisioned break-glass path; the OB1 DB remains the authority on admin (never a JWT realm-role claim).

### 1.3 The freshness problem — why `acr` is not liveness

Keycloak's `acr-to-LoA` map satisfies a requested LoA from the *existing SSO cookie* if the session already reached it — the WebAuthn execution is **skipped**, yet `acr:ob1-stepup` is still stamped and `auth_time` reflects the original login. So `acr` proves no liveness. Resolution:
- **Keycloak (sysadmin prereq):** the step-up WebAuthn execution for the `ob1-cli` flow must be **forced/unconditional** (`max_age=0`/`force`), so `auth_time` only advances on a real authenticator interaction. **Not expressible in the current read-only Nix module** (§6).
- **OB1 belt:** bind the login to an **OB1-issued `state` nonce** the server records, so an out-of-band token can't satisfy the gate even with the right `acr`/`amr`.

### 1.4 Lifetimes, cache, revoke

- **Access-token `exp`: 10–15 min** (`accessTokenLifespan`) — bounds the stolen-bearer window.
- **`STEP_UP_MAX_AGE` (real session length, enforced by OB1 on `auth_time`): 8–12 h.**
- **Refresh: `ob1-cli` issues NO refresh token** (no `offline_access`). This is the *only enforceable* honoring of the freshness floor — OB1 cannot see/prevent a client↔Keycloak refresh, so "forbid silent refresh" client-side is unenforceable. No refresh → re-`ob1 login` on `exp`. `ssoSessionMaxLifespan ≤ STEP_UP_MAX_AGE` as defense-in-depth.
- **Cache:** `~/.ob1/sso/cache/<issuer-hash>.json`, `0600`. **No refresh token cached** — what makes the §1.7 "≤ exp" blast-radius honest.
- **Transport:** `Authorization: Bearer` only, never `?key=` (`humanToken` already header/bearer-only, `auth.mjs:42-55`). See §1.5 for the `x-auth-request-access-token` header constraint + DPoP.
- **Revoke:** *fast kill* — `principal_identity_bindings.is_active=false` → `UPDATE … RETURNING` 0 rows → 403 (`auth.mjs:399`), no `exp` wait (coarse: whole binding). *Per-session* — **token introspection on the hot path is REQUIRED for the privilege-lifting path** (promoted from "optional"): the credential reaches `private_local`, so a single leaked token must be killable without de-authing the operator. *Local* — `ob1 logout` deletes the cache.

### 1.5 Transport decision — token-sufficient, but ONLY with three locks

"Token-sufficient, drop the loopback gate" is defensible **only with all three** in place (none are today):
1. **Sender-constrain the token (DPoP / `cnf`, RFC 9449) — REQUIRED, not a fallback.** A bare bearer in `~/.ob1/sso/cache` is exfiltratable and replayable *from any network* for the full `exp` window — categorically larger than AWS SSO (which scopes to a role + per-call SigV4). DPoP binds the token to the CLI's key so a copied bearer is inert off-box. Closes the remote-replay vector *without* re-introducing machine location.
2. **Pin `x-auth-request-access-token` provenance.** `humanToken` reads this oauth2-proxy forward header *before* the bearer (`auth.mjs:43`). Cloudflare→Traefik→OB1 presents public traffic as a `127.0.0.1` peer (verified), so OB1 cannot distinguish a loopback-origin forward from a tunnel-origin one. A client-set header via the tunnel = injection bypass. **The edge MUST strip/overwrite this header on any externally-reachable listener; the public listener accepts only `Authorization: Bearer` validated against JWKS — never a proxy's say-so for the privilege lift.**
3. **Exact-audience + `azp`** (IFF 3–4) — because location is dropped, `aud`/`azp`/`acr`/`amr`/`exp`/`is_active` are the *entire* fence.

**Why not the docs/48 loopback gate:** it was load-bearing only because docs/48's `local_trusted` was a standing, infinite-TTL, replayable key. The SSO token is short-lived, audience+azp-scoped, step-up-bound, revocable — the gate buys little and its signal is topology-fragile (tunnel-as-loopback). DPoP is the principled replacement.

### 1.6 Transport consistency — the processor path (NEW)

Dropping location for *reads* while `isLocalTrustedProcessor` (`access-policy.mjs:687-700`) trusts loopback **unconditionally** for sending **restricted** content to embedding/LLM processors is incoherent: the same tunnel-as-loopback fact makes processor loopback-trust a live hole. **Resolution:** bind `isLocalTrustedProcessor` to an out-of-band signal (mTLS or unix socket) or an explicit allowlist of *resolved IPs* (not hostnames). Location must be out **consistently** — you can't drop it for reads and keep it load-bearing for restricted-content processors.

### 1.7 Honest same-user residual

With **DPoP in place**, a copied bare bearer is **inert off-box**; the residual narrows to a *co-resident* process that can also use the CLI's DPoP key, bounded to **≤ `exp`** (no cached refresh token). Stated honestly: a co-resident attacker gets **full `local_trusted` READ to `luchoh` + (post-§4) attributable trusted WRITE, for ≤ exp**. This is **not** "exactly AWS SSO's residual" — AWS SSO grants a scoped role; OB1 grants the operator's crown-jewel reach. v1 withholding `isAdmin` keeps it out of admin territory. darwin/launchd has no per-process isolation (docs/48 R1), so the on-box co-resident residual is **not closed** — accepted, bounded, revocable, informed.

**What the session model does NOT close:** (a) the on-box co-resident residual; (b) the **Postgres-superuser `.env.open-brain-local` autoload** (`config.mjs:27`) and the **bare `MCP_ACCESS_KEY` global-admin path** (`auth.mjs:465`) — SQL/credential bypasses *beneath* the app layer that make the `local_trusted` distinction moot until retired (hard co-requisite); (c) device-flow phishing for headless (mitigated); (d) revocation latency without introspection.

---

## 2. Re-evaluation of the Shipped Implementation — KEEP / CHANGE / REMOVE

| Shipped artifact | File:line | Verdict | Reason |
|---|---|---|---|
| **Clamp 1 — legacy-admin confinement** | `auth.mjs:584-603` | **KEEP — harden** | Correct & verified. Footgun: the `caller.kind===LEGACY_ADMIN_KEY` gate means a future no-scope caller (e.g. an admin-SSO shortcut) bypasses the compensator silently. **Generalize `brainIsLocalOnly` to fire for ANY `cloud_bound` caller lacking a scope** (drop the `kind` gate); test that any `isAdmin` human/SSO caller still routes through `deriveScope`. |
| **Clamp 2 — graph read-plane scrub** | `graph-reads.mjs`, `server.mjs:816-822` | **KEEP** | Source-agnostic, keys off `caller.readEgressClass`. Zero change. Load-bearing under SSO (the SSO path sets `LOCAL_TRUSTED` dynamically). |
| **Clamp 3 — Layer-B per-row clamp** | `server.mjs:834-843`, `thought-store.mjs` | **KEEP** | Value-driven, fail-closed on `enforce && cloud_bound`. Clean. |
| **`verifyHumanJwt`** | `auth.mjs:75-85` | **CHANGE** | Passes only `{issuer,audience}`, **no `algorithms` allowlist**; under this model it becomes the gate to `private_local`+write. Pin `algorithms:['RS256']`; add exact-`aud`, `azp`, `acr`+`amr`, `auth_time` checks. |
| **`resolveHumanAccessContext`** | `auth.mjs:407-416` | **CHANGE (sequenced)** | The model's core edit. Must NOT land before (a) §2 verify hardening + full IFF, (b) taint-carry-forward (§4), (c) DPoP + header-provenance. Keep `CLOUD_BOUND` default, affirmative per-clause upgrade. **No `isAdmin` here in v1.** |
| **`resolveLegacyAdminContext`** | `auth.mjs:465-516` | **REMOVE (target) / least-priv now** | Bare `MCP_ACCESS_KEY` global-admin is an app-layer bypass beneath the egress model; a hard co-requisite for the SSO model to *mean* anything. |
| **Migration 017 — `read_egress_class`** | `migrations/017` | **CHANGE — deprecate column, KEEP caller-class** | No *key* is `local_trusted` under SSO → column vestigial. The `LOCAL_TRUSTED` *value* + clamps stay load-bearing (set dynamically). Add a CHECK/audit that no *standing* key carries `local_trusted` in steady state (leave a break-glass bootstrap path). |
| **`deriveCaptureStamp`** | `access-policy.mjs:659-671` | **CHANGE (hard blocker)** | Hardcodes `sourceTrustClass=TRUSTED` (:664), origin from `caller.readEgressClass`. The instant the human path lifts to `LOCAL_TRUSTED`, an operator re-capture of cloud-origin holding content stamps `origin=LOCAL_TRUSTED,source=TRUSTED` on a **fresh INSERT** — laundering taint (the 016 trigger guards UPDATE only). Carry source taint forward (§4) + thread explicit `sourceTrustClass` **before** the lift. |
| **`index.mjs` single listener** | `index.mjs` | **KEEP** | The docs/48 "second 127.0.0.1 trust-gate listener" is **retired** (peer-address can't distinguish tunnel from local). One listener is correct under token-sufficient+DPoP. |

---

## 3. Net-New Components

| Component | What it is | Grounding |
|---|---|---|
| **`ob1 login` CLI (`ob1-cli` public client)** | Attended: auth-code+PKCE+loopback-redirect. Headless: device grant + phishing mitigations. Caches token (no refresh) at `~/.ob1/sso/cache` `0600`. Holds the DPoP key. | `ob1-cli` is a **separate** public client from the `ob1` resource audience so `azp` is checkable. PKCE-for-attended over device-grant because device-grant is phishable. |
| **Session cache** | `access_token`, `expires_at`, `acr`, DPoP key. **No refresh_token.** | Mirrors `~/.aws/sso/cache/` minus the refresh token — what makes ≤exp blast-radius honest. |
| **`resolveHumanAccessContext` step-up upgrade** | Replaces the `:407-416` constant with the §1.2 IFF: RS256-pinned verify, exact-aud, azp, acr+amr, auth_time floor, DPoP/`cnf` check, OB1 `state` nonce. Fail-closed, affirmative-upgrade. READ only; **not `isAdmin`**. | Highest-priority coupling: **acr/auth_time/azp/amr enforcement MUST land in the SAME commit that flips conferral** — else any `aud:ob1` token is an instant bypass. `buildPrincipalContext` stays the single choke point. |
| **Keycloak config** | `ob1-cli`: device-grant + auth-code+PKCE; **no refresh/offline**; WebAuthn step-up **forced** (`max_age=0`); `acr-to-LoA`→`ob1-stepup`; mappers emitting `acr/amr/auth_time/azp` into the access token; audience-mapper scoped so **exactly one** client carries `aud:['ob1']`. | **The current Nix module cannot express any of this** (`default.nix:260-358` exposes only `publicClient/standardFlowEnabled/directAccessGrantsEnabled/serviceAccountsEnabled/redirectUris/accessTokenAudience` — no device-grant attr, no `attributes` passthrough, no flow/required-action binding). **Hard sysadmin prereq in read-only system-config.** OB1 must fail-CLOSED on absent `acr`/`auth_time` until Keycloak provably emits them. |
| **Promotion verb** | An INSERT into `luchoh` that **carries `origin_egress_class=cloud_origin` forward** from the holding row + `promoted_from` lineage + `thought_audit`. Declassification via brain placement + read exposure, **never** an origin re-stamp. Gated on a **fresh-gesture** session. | NO trigger-bypassing `SECURITY DEFINER`. The 016 monotone trigger stays the authority. |

---

## 4. Promotion / No-Laundering Resolution

The original "promotion is just an ordinary trusted write" is **FALSE and unsafe**, and the SSO model makes it *worse* (routine daily low-friction `local_trusted` writes multiply laundering-insert frequency).

Verified mechanics: a holding row is `origin_egress_class=cloud_origin`; `enforce_monotonic_origin_taint` (`016:100-120`) blocks `cloud_origin→local_trusted` on **UPDATE** but **not on a fresh INSERT**. So an operator "re-capturing" holding content into `luchoh` during a session produces a fresh row stamped `origin=local_trusted,source=TRUSTED,review_state=none` — **taint erased in one step**, then read back as trusted by the §2 clamps. A closed loop.

**Resolution:**
1. **Sequencing is the load-bearing security property. Do NOT lift the human path to `local_trusted` WRITE before taint-carry-forward lands.** A HARD blocker, equal to `acr` enforcement. v1 may lift `local_trusted` **READ** ahead of write; trusted WRITE waits.
2. **Promotion = carry-taint-forward INSERT:** the new `luchoh` row keeps `origin_egress_class=cloud_origin` + the source row's `source_trust_class`; declassification is *placement* + *read exposure*, never an origin re-stamp. `assessTrust`'s worst-of still fires.
3. **No `SECURITY DEFINER` bypass** gated on bare `readEgressClass===LOCAL_TRUSTED`. True origin-declassification, if ever required, gates on a **fresh gesture**, never a possibly-stale-`acr` session.
4. **Thread `sourceTrustClass`** from the capture handler into `deriveCaptureStamp` so external ingest (mail/telegram/dictation) asserts `UNTRUSTED` (today's hardcoded `TRUSTED` collapses the two-axis injection guard).
5. **Regression test:** a `cloud_origin` holding row CANNOT become `local_trusted` via patch, upsert-into-`luchoh`, or bare UPDATE.

---

## 5. Red-Team Residuals & Mitigations

| # | Residual | Sev | Mitigation (baked in) | Closed? |
|---|---|---|---|---|
| R1 | **`acr` is not freshness** (Keycloak cookie re-issue) | Critical | Forced WebAuthn (`max_age=0`) + `amr` assertion + OB1 `state` nonce. Until Keycloak provably re-prompts (integration-tested), treat `acr` advisory and don't lift. | Mitigated; depends on Keycloak change |
| R2 | **Cached-token theft within TTL** | High | **DPoP REQUIRED** (copied bearer inert off-box); no cached refresh (≤exp window); `is_active` fast-kill + hot-path introspection; v1 withholds `isAdmin`. | Off-box closed; on-box co-resident **NOT closed** (accepted) |
| R3 | **Silent refresh launders `auth_time`** | High | **`ob1-cli` issues NO refresh token** (enforceable); `ssoSessionMaxLifespan ≤ STEP_UP_MAX_AGE`. | Closed |
| R4 | **Header-injection** (`x-auth-request-access-token` before bearer + tunnel-as-loopback) | Critical | Edge strips/overwrites the header; public listener accepts only JWKS-validated bearer; mTLS-pin the trusted hop. | Closed by edge + listener policy |
| R5 | **Processor loopback-trust** still load-bearing while reads drop location | High | Bind `isLocalTrustedProcessor` to mTLS/unix-socket or resolved-IP allowlist. | Must change before ship |
| R6 | **Audience confusion** (jose contains-match) | Critical | Exact `aud==['ob1']` + `azp=='ob1-cli'` + realm audit (exactly one client carries `aud:ob1`). Same commit as conferral. | Closed by IFF + audit |
| R7 | **Algorithm-confusion** (no `algorithms` pin) | High | Pin `algorithms:['RS256']`. | Closed (mandatory) |
| R8 | **Device-flow phishing** | High | Attended → auth-code+PKCE; headless device-grant with binding/manual-code/rate-limit. | Closed attended; mitigated headless |
| R9 | **Promotion laundering** | High | Carry-taint-forward verb; sequence behind taint-carry-forward; no `SECURITY DEFINER`; thread `sourceTrustClass`. | Closed by sequencing + verb |
| R10 | **`isAdmin` over the session** | Med | v1 confers read/write only, **never `isAdmin`**; admin stays break-glass. | Closed in v1 by exclusion |
| R11 | **Sub-app SQL/credential bypasses** (PG superuser `.env` autoload, bare `MCP_ACCESS_KEY`) | — | Hard co-requisite: retire/least-priv before `local_trusted` means anything. | **NOT closed** — precondition |

---

## 6. Rollout Sequence (staged so no slice ships net-new attack surface)

**Stage 0 — Preconditions (BLOCKERS; nothing conferral-lifting ships until done):**
- (a) **Keycloak (sysadmin, read-only repo):** Nix module extended for `ob1-cli` device-grant + auth-code+PKCE, **forced WebAuthn** (`max_age=0`), **no refresh/offline**, mappers for `acr/amr/auth_time/azp`, audience-mapper scoping. Integration-test that a warm SSO cookie **cannot** mint `ob1-stepup` without a gesture.
- (b) **Edge:** strip/overwrite `x-auth-request-access-token`; mTLS-pin the trusted hop (R4).
- (c) **Retire/least-priv** superuser `.env` autoload + bare `MCP_ACCESS_KEY` (R11).
- (d) **Taint-carry-forward / `write_trust_class`** wiring + carry-forward promote verb (R9, §4).
- (e) **Processor loopback-trust** rebind (R5).

**Stage 1 — Verify hardening (safe today, independently shippable):** pin `algorithms:['RS256']`; thread `sourceTrustClass` into `deriveCaptureStamp`; generalize `brainIsLocalOnly` (drop the `kind` gate). Clamps unchanged. Add falsify-each-IFF-clause + no-laundering regression matrices behind a flag.

**Stage 2 — `local_trusted` READ conferral (single atomic commit):** flip `resolveHumanAccessContext` to the full §1.2 IFF + DPoP — all in the **same commit**. READ only, no write, no admin. `ob1 login` + cache + introspection ship here. `observe` first, then `enforce`.

**Stage 3 — Trusted WRITE conferral:** only after Stage-0(d). Lift to attributable trusted write via the carry-forward path.

**Stage 4 — (deferred):** any admin-via-binding path — separate migration, separate even-shorter elevation, fail-closed `is_admin` column.

### docs/48 sections this supersedes / rewrites
- **§3.4 (operator standing `local_trusted` KEY + second listener)** → **REPLACED** by §1 here.
- **§3.2 / I4 (`write_trust_class` / taint)** → **PROMOTED** from proposal to a hard Stage-0 blocker for write conferral; add the carry-forward verb + INSERT-path taint-carry-forward.
- **§3.1 / §3.3 / I2 / I7 (superuser `.env`, `MCP_ACCESS_KEY`)** → **PROMOTED** to explicit Stage-0 preconditions; marked as what the model does NOT close.
- **§4 transport / loopback** → **REWRITTEN** to token-sufficient-**with-three-locks** (DPoP required, header-provenance pinned, exact-aud); **second-listener retired**.
- **§6 same-user residual** → **REWRITTEN** to the honest §1.7 framing (≤exp, DPoP closes off-box, on-box co-resident NOT closed; larger than AWS SSO).
- **`isLocalTrustedProcessor`** → **ADD** the §1.6 rebind off loopback.

**Trust-topology supersession:** "loopback = local_trusted" is retired everywhere — reads (token+DPoP), writes (carry-forward + fresh-gesture), processors (mTLS/allowlist) all move off machine location, consistently.
