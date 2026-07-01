# 50 — OB1 Signed-Agent Identity — Unified Architecture

**Status:** Architecture synthesis. Merges an on-machine mechanism spec + five area designs + their adversarial red-teams. Supersedes the *agent normal-path* of docs/49 (AWS-SSO browser session); see §6 for the KEEP/DROP/REANCHOR map. Verified on `mbprm4` (M4) against the on-machine SDK + live `codesign`/source. Residuals (§7) are stated plainly.
**Provenance:** Ultracode workflow (1 mechanism-spec → 5 designers → 5 red-teamers → 1 architect), every code citation independently re-verified.

**The pivot, one sentence:** stop authenticating *what a caller knows* (a bearer string / SSO token) and authenticate *what a caller is* (a macOS code signature), feeding that into the **same `caller.readEgressClass` axis** at the single choke point `buildPrincipalContext` (`auth.mjs:249`) the three shipped clamps already key off — **zero clamp change**.

> ### ⚠️ READ THIS FIRST — where the security actually is
> This signed-agent layer is **blast-radius reduction for the credential-THEFT class only.** It does **not** close, and must not be marketed as closing:
> - **R-FLOOR (verified live, the real emergency):** two app-layer bypasses sit *beneath* everything here. `config.mjs:27` autoloads the **Postgres superuser** password into `process.env` at import; the bare **`MCP_ACCESS_KEY`** (`auth.mjs:465`) is a global-admin skeleton key present on **M4 too**. Any same-user process talks to Postgres or presents the skeleton key beneath the entire identity/clamp layer. **And `OB1_EGRESS_ENFORCE` is absent → `observe` → the clamps confine nothing in production today.** Until these are closed and enforce is flipped, the fancy identity work is *decorative, even misleading*.
> - **R-DEPUTY / R-INJECT (unclosable at this layer):** a signature proves *which binary*, never *who is driving it* or *whether it was prompt-injected*. A same-user process can just **ask** the live signed agent to act; a prompt-injected genuine agent satisfies its own ACL. Injecting **Pi** is *worse* than a cloud agent — Pi is the only `local_trusted` principal.
> - **The security lives in Stage 0 (§8) — the boring, verified, live fixes. The Pi daemon is the *least* security-critical part of the package.**

---

## 1. The model in one picture

```
   Pi      = TRUSTED.  Operator-built, operator-Developer-ID-signed.
             Secure-Enclave key in hardware. local_trusted reach.
             NARROW fixed-verb daemon — signature proves identity, not
             good behaviour; a prompt-injected Pi is still "genuinely" Pi.
   Claude  = ASSUMED-COMPROMISED. Anthropic-signed (Q6L2SF6YDW). cloud_bound. Own brain(s).
   Codex   = ASSUMED-COMPROMISED. OpenAI-signed (2DC432GLL2). cloud_bound. Own brain(s).
   agy/gem = DROPPED from the trusted/pinned set (ad-hoc / contested signature).
   Cross-project Claude-A → Claude-B hijack = ACCEPTED (both cloud-tainted).

   WHO HOLDS WHAT                          WHAT OB1 CHECKS (at auth.mjs:249)
   Pi   →  SE key (non-extractable) + DR     • caller.readEgressClass — the ONE axis,
   Claude→ Anthropic DR                        derived from a NON-REPLAYABLE signature
   Codex →  OpenAI DR                           source, fail-closed to CLOUD_BOUND
                                              • 3 source-agnostic clamps fire off it — UNCHANGED

   TWO TRANSPORTS (the tunnel erases peer identity)
   Pi, co-located    → AF_UNIX socket → per-request peer SecCode check → may reach local_trusted
   anything tunneled → TCP 127.0.0.1  → SE-signed request (DPoP/9421) → CONSTRAINED, never local_trusted
```

**What the signature buys, precisely:** it denies a *different same-user program* — and the agent's own `bash`/`node` children (ad-hoc/Apple-signed, do **not** inherit the parent's identity) — silent use of a leaked key/socket. That is the entire affirmative value. It does **not** touch confused-deputy/injection (§7).

---

## 2. Local custody — Keychain ACL per agent + Pi's Enclave key

### Verified team identities (design around THREE, not four)

| Agent | identifier | Team OU / authority | Stable across update? |
|---|---|---|---|
| Claude Code (CLI) | `com.anthropic.claude-code` | `Q6L2SF6YDW` (Anthropic PBC) | **Yes** — team-anchored, cdhash-independent |
| Codex | `codex` | `2DC432GLL2` (OpenAI OpCo) | **Yes** |
| Pi | `net.luchoh.pi` (target) | operator Developer ID (to mint) | Yes **once operator-signed** — unbuilt today |
| ~~agy / gemini~~ | ad-hoc (Nix linker-signed) | none | **No** → **DROPPED** |

Provisioning traps (red-team verified): Codex's bare `identifier codex` is generic — pin OU **and** identifier; **Claude Desktop** (`com.anthropic.claudefordesktop`) ≠ the CLI (`com.anthropic.claude-code`) — pin the one you run; **re-verify agy/gemini DRs on-machine** (spec/design disagreed) — safe default is drop.

### The correct Keychain primitive
Bind secrets to a Keychain item whose ACL is gated on a **compiled code requirement** via the **legacy `SecAccess` + `SecRequirementCreateWithString` + `SecKeychainItemSetAccess`** path — **not** `kSecAttrAccessControl` (which governs only protection-class/biometry). Rules: authorize on the **OU-anchored requirement, never the path** (nix-store paths churn); compose **deny-on-non-match with no interactive "Always Allow" fallback** (that path permanently widens the ACL; a same-user owner can also rewrite its own ACL — unclosable R1); the legacy CSSM API is **deprecated-but-present** — confirm it works on this macOS version and **survives a real nix rebuild** before committing.

### Pi's Secure Enclave key — split into two
`SecKeyCreateRandomKey` + `kSecAttrTokenIDSecureEnclave` (P-256, non-extractable, per-host, no escrow):
- **Silent read-key** (no presence gate) for headless reads — accept it is an **on-box signing oracle** (any co-resident process can ask the SEP to sign within validity; non-extractability stops *off-box* replay only).
- **Presence-gated write/destructive key** (`kSecAccessControlBiometryCurrentSet`) for **all** cross-brain-write and destructive ops. The headless-silent-write key the naive design offered **is the vulnerability** — removed.

---

## 3. Carrying identity to OB1 — the resolved transport

> **Topology (verified):** all real agents reach OB1 at `https://ob1.lincoln.luchoh.net/mcp` with an `x-access-key` **bearer** — even local Claude — via Cloudflare → cloudflared(M2) → Traefik(loopback) → OB1 `127.0.0.1:8788`. OB1 sees a `127.0.0.1` peer with **no client cert, no code identity**. mTLS does not survive a reverse tunnel.

**Path A — AF_UNIX peer SecCode check (co-located callers only).** Over a **new AF_UNIX listener** (separate from the tunnel-fed TCP one), OB1 reads the peer's audit token and checks its code requirement. **Buildable and verified-real here:** `LOCAL_PEERTOKEN` (`0x006`) is in `sys/un.h` → `getsockopt` retrieves the peer audit token (defeats pid-reuse TOCTOU); `req.socket._handle.fd` is reachable per-request; `SecCodeCopyGuestWithAttributes({kSecGuestAttributeAudit})` → `SecCodeCheckValidity` against `SecRequirementCreateWithString(<team DR>)` — all symbols present (Nix apple-sdk-11.3). Non-negotiable: **re-verify on every request on the live fd (keep-alive OFF)**; **forbid any `kSecGuestAttributePid` fallback**; fail CLOSED; `CFRelease` per request (leak = slow OOM); **admit ONLY operator-signed Pi, deny every other matched identity** (don't downgrade a matched Claude to cloud_bound — that turns the socket into a secret-free login for an injected co-resident agent).

**Path B — SE-signed request (tunnel-robust, all remote callers).** Each agent signs a canonical string (`@method,@path,content-digest,date,nonce/jti,aud`) with its SE key as **HTTP Message Signature (RFC 9421)** / **DPoP (RFC 9449)** — the SE key *is* the `cnf` key. OB1 verifies against the registered public key. Transport-independent; a copied token is inert off-box.

**Recommendation: Path B is primary/universal (covers local + tunnel, no new listener); Path A is a Pi-only co-located enhancement.** Path B proves only *key possession* (a co-resident process can drive a silent SE key — R-ORACLE), so **Path B must NEVER confer `local_trusted`**; `local_trusted` is reachable **only** via Path A's real code attestation, Pi-only, over AF_UNIX.

**OB1 auth changes (choke-point-local):** thread the verifier result → `caller.readEgressClass` at `buildPrincipalContext` (`auth.mjs:249`) — **clamps unchanged**; apply the `brainIsLocalOnly` `kind`-gate generalization. **Mandatory server-side replay defense for Path B:** single-use `jti`/nonce cache + ≤60s skew window (the Traefik→OB1 hop is plaintext loopback → a co-resident can sniff+replay → the nonce cache is mandatory). Listener separation *is* the enforcement: no code path maps a tunnel-TCP principal onto Pi's `local_trusted` verbs.

---

## 4. Pi the program

A narrow, fixed-verb, operator-signed local daemon (`net.luchoh.pi`), reachable only over AF_UNIX, holding the split SE keys. The **only** principal that may reach `local_trusted` — and the **least** security-critical part of the package (its safety rests entirely on Stage-0 landing first).

- **Build/sign:** real infra — Apple Developer account, stable identity, reproducible build, notarization. **Operator-sign Pi BEFORE any Pi custody ships** (no stable OU until then). SE keys can't be escrowed → design a pubkey rotation/registration flow.
- **Autonomy:** headless **reads** only (silent read-key). **Cross-brain-write/destructive require the presence-gated key.** Never run headless with a silent write key.
- **Confused-deputy ceiling (honest):** Pi's peer-check authenticates agent-*type*, not the *provenance of the work*. The real containment is the **narrow verb set**, not the peer-check. Ingest-to-holding carries **zero** trust authority (quarantine-stamped).
- **Touch-ID bound to payload, not just presence:** promote/declassify signs a digest of `{source_row_id, target_brain, content_hash}` and **displays that summary before the gesture** — one gesture = one named promotion (defeats batch fatigue + `LAContext`-window reuse). Fresh `LAContext` per sign; prefer `BiometryCurrentSet`.
- **No-laundering promotion (load-bearing data-plane fix):** verified gaps — `deriveCaptureStamp` hardcodes `sourceTrustClass=TRUSTED` (`access-policy.mjs:664`); the `016` monotone trigger is **BEFORE UPDATE only**, so a fresh INSERT launders. Fix (all four): **(1)** thread explicit `sourceTrustClass`, stamp all external content `UNTRUSTED` unconditionally (never trust a caller flag) — **precedes Pi shipping**; **(2)** promote = carry-taint-forward INSERT (copy `cloud_origin` + source trust, add `promoted_from` lineage + audit, never re-derive from Pi's egress); **(3)** make it **DB-enforced** (INSERT trigger/CHECK + column-grant denying the app role from setting `origin_egress_class=local_trusted`), no `SECURITY DEFINER` bypass; **(4)** regression test: `cloud_origin` can't become `local_trusted` via patch/upsert/UPDATE/**INSERT**.

---

## 5. Cloud agents — riding the shipped clamps unchanged

Claude/Codex stay `cloud_bound`, each scoped to its own per-repo brain — **zero clamp/auth change** (verified: `provision.sh` mints keys with no `read_egress_class` → NULL → `CLOUD_BOUND` fail-closed; clamps key only off `caller.readEgressClass` + brain `egress_class`).

**But confinement is INERT today** (verified live): `OB1_EGRESS_ENFORCE` absent → `observe` → `deriveScope` *reports* `egressExcluded` but doesn't strip it, and the 404 guards are `enforce`-gated → **a cloud_bound key reads a local-only brain right now.** Hardening (rides the clamps): move per-repo keys out of plaintext `.agent-estate-keys/*.key` into Keychain (vendor-DR ACL → agent's own children auto-denied; a prompt-injected agent currently reads *every* repo's key in one pass); SE-sign (Path B) binds keys to the box; a DB constraint that `local_trusted` is **only** ever on a person/Pi principal, never a `service_key`; a brain-classification gate (refuse to advertise a NULL-`egress_class` brain to a cloud agent).

---

## 6. KEEP / DROP / REANCHOR (docs/48 + docs/49)

**Saves:** drops the **entire Keycloak/AWS-SSO authority layer** (docs/49 §1–3) for agents — gone: the `ob1-cli` client, device-grant phishing mitigations, the `acr/amr/auth_time/azp`/exact-`aud` IFF, forced-WebAuthn, hot-path introspection, and **the Nix Keycloak-module extension the read-only system-config can't even express** (docs/49's hardest blocker). Six SSO holes evaporate. Trust reanchors from a self-hosted IdP to Apple notarization + vendor certs.
**Costs:** a native Security.framework **TCB** (the Path-A helper); per-host SE-key provisioning with **no escrow/recovery**; a hand-wired AF_UNIX listener; and **standing trust in vendor future builds** (a team DR auto-trusts every future Anthropic/OpenAI build — the survives-updates property *is* the auto-trust property; a compromised vendor key forges a genuine match). Pi's operator Developer ID is a single point of failure.

| Item | Verdict | Reason |
|---|---|---|
| 3 read-confinement clamps | **KEEP unchanged** | Source-agnostic; survive any trust-source change. Apply the `brainIsLocalOnly` generalization. |
| `buildPrincipalContext` choke point | **KEEP** | The one parameterized, fail-closed entry the signature threads into. |
| Keycloak/AWS-SSO session (docs/49 §1–3) | **DROP for agents** | Replaced by signature + SE key. May retain a thin SSO break-glass for a *human admin*, not agents. |
| Promotion/no-laundering, `sourceTrustClass` threading | **KEEP — REANCHOR onto Pi + DB-enforce** | Independent of identity carrier; hard Stage-0 blocker. |
| docs/48 §3.4 second listener | **STAY DROPPED** as a trust-gate; **REANCHOR** concept as a Pi-only **AF_UNIX** listener (peer code-check, not peer-address) | Peer-address can't distinguish tunnel from local; peer audit-token can. |
| DPoP / sender-constrained token | **KEEP — REANCHOR** | `cnf` key becomes the SE key (Path B). |
| `isLocalTrustedProcessor` loopback rebind | **KEEP** | Same tunnel-as-loopback incoherence. |
| Migration 017 per-key `local_trusted` | **DROP the value, KEEP the caller-class** | No standing key is `local_trusted`; Pi's Path-A sets it dynamically. |
| `resolveLegacyAdminContext` / `loadRepoEnv()` PG-superuser | **REMOVE (precondition)** | §7 R-FLOOR. |
| `OB1_EGRESS_ENFORCE` flip | **DO — prerequisite** | No-op `observe` today; confinement is false until flipped (prod also unmigrated). |
| agy/gemini in pinned set | **DROP** | Un-pinnable; share `cloud_bound` bucket. |

---

## 7. Residuals the model does NOT close (plainly)

- **R-FLOOR (CRITICAL — decoration until closed):** `loadRepoEnv()` (`config.mjs:27`) leaks the PG **superuser** into `process.env` beneath the whole app layer (closing it is a config *refactor*, not a one-liner); the bare `MCP_ACCESS_KEY` (`auth.mjs:465`, `bothHosts` incl. M4) is a global-admin skeleton. **Stage-0 hard preconditions — build neither listener nor helper until both are closed.**
- **R1 (un-closable):** darwin has no per-service-user isolation; every `luchoh` process shares one trust domain. Every mechanism narrows blast radius; none closes the active same-user adversary.
- **R-DEPUTY (CRITICAL, by premise):** every mechanism authenticates the *connecting binary*, never the *prompt/intent/data*. A second shell, a cron, ingested content, or another agent simply **asks** the live matching agent. **Identity ≠ authority.** Real reductions live elsewhere — per-prompt provenance + **content-egress/veil** (docs/44) on Pi's *reads*, and narrow clamps.
- **R-INJECT (CRITICAL for Pi):** a prompt-injected Pi is byte-for-byte the signed binary. **Injecting Pi > injecting a cloud agent** (Pi is the only `local_trusted`, and most likely to ingest untrusted content — the 915 imap rows). Mitigate: presence-gate all Pi writes; treat ingested content as untrusted; **veil-clamp Pi's `local_trusted` reads** so a read can't be reflected outbound same-session. None closes a self-injected Pi's reads.
- **R-ORACLE (HIGH):** Path B's SE key proves *possession*, not *which prompt*. Headless ⇒ silent ⇒ on-box forgery open ⇒ **Path B never carries `local_trusted`**.
- **R-VENDOR (MED):** trust is transitive to Anthropic/OpenAI/Apple + operator Developer ID. Never relax a DR to bare `anchor apple generic`; treat mismatch as fail-CLOSED; keep a kill-switch (`is_active`/pubkey deregistration).
- **R-HELPER (HIGH):** the native Path-A verifier is unaudited C calling Security.framework and is sole arbiter (socket has no bearer) — a marshalling bug = false-accept granting `local_trusted`. Per-request re-verify, keep-alive off, `Pid`-path forbidden, fuzzed, pinned, fail-closed; keep a bearer path as defense-in-depth.
- **R-PROVENANCE (LOW):** the spec mis-stated SDK provenance + Gemini DRs — re-verify on-machine before consuming as truth.

---

## 8. Build sequence

**Stage 0 — Preconditions (BLOCKERS; nothing identity ships until done) — THIS IS WHERE THE SECURITY IS:**
- (a) Retire/least-priv the PG-superuser `.env` autoload (`config.mjs:27`) → `ob1_app` role, no import-time side effect; remove the secret dotenv + skeleton key from **M4** entirely.
- (b) Retire `resolveLegacyAdminContext` bare-key admin (`auth.mjs:465`).
- (c) Thread explicit `sourceTrustClass` into `deriveCaptureStamp` (remove hardcoded `TRUSTED`); stamp external content `UNTRUSTED`.
- (d) DB-enforced carry-taint-forward on the INSERT path (trigger + column-grant) + carry-forward promote verb.
- (e) Flip `OB1_EGRESS_ENFORCE=enforce` after classifying every brain (release-gated to prod; 016/017/018 not yet on prod). Boot assertion refusing to claim confinement while not `enforce`.

**Stage 1 — Cheap, safe-today identity (Path B + ACLs):** server-side `jti`/nonce replay cache + skew window; per-agent Keychain ACL pins (Claude `Q6L2SF6YDW`, Codex `2DC432GLL2`) on the OU-anchored requirement, deny-on-non-match (verify survives a nix rebuild); move cloud keys into Keychain; `local_trusted`-only-on-person DB constraint + brain-classification gate. Drop agy/gemini.

**Stage 2 — Pi custody (after operator-sign):** sign+notarize Pi; mint split SE keys; register pubkey; Path B for Pi → **CONSTRAINED, never `local_trusted`**; payload-bound Touch-ID on promote/declassify; veil-clamp Pi's `local_trusted` reads (docs/44).

**Stage 3 — Path A (Pi `local_trusted` via real code attestation; optional, highest cost):** spike the `LOCAL_PEERTOKEN → SecCodeCopyGuestWithAttributes → SecCodeCheckValidity` path with CF-lifetime correctness; hand-wire the AF_UNIX listener (`http.Server.listen({path})`, keep-alive off); build the native verifier as TCB (per-request re-verify, `Pid`-path forbidden, fail-closed, fuzzed, pinned); thread SecCode → `readEgressClass`; **Pi-only admit**; verify no TCP path routes onto Pi's verbs.

**Net:** a defensible blast-radius reducer for the credential-theft class — **not** a same-user or confused-deputy boundary — and worthless, even harmful to posture, until Stage 0 lands. **The Pi daemon is the least security-critical part; the security lives in Stage 0.**
