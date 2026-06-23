# OB1 Common-Brain Access — Concrete Proposal

Date: 2026-06-23
Status: **PROPOSAL — the owner has approved nothing.** For Codex to tear into.
Rev 6 (2026-06-23): **Codex review v5 folded in, verified** — allowlist startup guard (§4.6.0),
private-safe errors (§4.6.f), logs/audit/backups plane (§4.6.g), scope_isolated read-vs-
maintenance split (§4.6.a), per-tier egress (§4.6.e). Codex: "the design is close; remaining
work is mostly implementation + tests." Prior author corrections in §12.
Author: Claude Code (Opus 4.8).
Lineage: docs/46 (problem + post-mortem), docs/44 (parallel Scribe+Veil PRD — overlaps; reconcile), docs/43, docs/42 (superseded).
Brain: `f4e3ca90`, `3f501e3b`, `cf8417cf`, `532b07dd`, `0eef2167`, `31d35d1d`. Supersedes the
bespoke `ob1-unlock` signing design (§7).

> One agent's proposal, corrected by Codex three times. Treat every line as a claim to
> challenge; the owner has approved nothing. **The load-bearing content is §4.6 — the things
> that ARE the design — and §4.6.0 (service-credential custody) sits under everything else.**

---

## 1. Goal (keep the tool)
Every agent, every harness, reflexively uses OB1: **read/write its own repo brain** and
**contribute to / (with permission) read a shared COMMON brain**, over MCP. Removing the
capability is amputation.

## 2. The fixed constraint
`pi` (trusted; LOCAL model) and the cloud harnesses (Claude Code, Codex — exfiltrate
everything they read to their provider) run **as the SAME OS user, SAME machine.** **Separate
OS user and sandboxing `pi` are NO-GO.** Hold without them.

## 3. Threat model (right-sized) — and the credential surface
Adversary: **a cloud coding agent holding a credential**, not a rootkit. The realistic leak is
an **over-broad credential used through ordinary tool use** — and **the credential surface is
every non-MCP path to the data: storage (Postgres, Neo4j, MinIO, Consul) AND source/ingest
(IMAP, and any Telegram/Google/dictation creds) AND OB1's own model/processor egress.** A
coding agent with `PGPASSWORD` (or `IMAP_PASSWORD`) in its `env`, asked to "look at the OB1
data," runs `psql` (or reads the mailbox) and ships the result to its provider. No malware
needed. So **every MCP-layer control below is moot unless all non-MCP creds are kept out of
harness reach (§4.6.0) and private content is never processed by a non-local model (§4.6.e).**

Deployment: prod OB1 is **remote on the M3 server, 8788, over TCP** (docs/41); harnesses are
remote clients that should hold *only* an MCP key. (`localhost:8787` + local service creds =
dev only.)

## 4. Core cuts
1. **Common split into public + private tier; default private (fail-closed).** Public harness
   sees only public; unlocked session sees both.
2. **Private-tier read = a short-lived session** minted by a passphrase the human types into
   `pi`'s **hidden TTY** (never chat/transcript/tool-output/env/file/persistent memory).
3. **No bespoke signing subsystem** — bearer over TLS, short TTL (§7).
4. **Promote + publish gated, taint-barred, fail-closed.** Authoring private-tier is free;
   **`publish` (private→public, irreversible) needs item-specific human confirm in v1**;
   tainted content never publishable.

## 4.5 Representation: two-brain (leading) vs row-flag
Private tier = a `visibility` column (row-flag) or a separate `common-private` brain
(two-brain). **Author + Codex recommend two-brain**; owner to confirm. But two-brain is **not
self-securing** — §4.6.

## 4.6 The things that ARE the design (not plumbing)

### 4.6.0 Non-MCP credential custody — THE FOUNDATION (Codex v3/v4, verified)
Any non-MCP credential gives a path **around** MCP. The dotenv `.env.open-brain-local` carries
storage (`PGPASSWORD`, `NEO4J_PASSWORD`, `MINIO_SECRET_KEY`, `CONSUL_HTTP_TOKEN`) **and source**
(`IMAP_PASSWORD`/`IMAP_ACCOUNT`) creds. `devenv.nix:4-5` + `:14 source` load all of them into
the dev shell, so a cloud harness there can `psql`/cypher to storage (`db.mjs`,
`graph-driver.mjs:69`) **or read the mailbox directly** — bypassing every MCP control.
**Requirement: NO non-MCP credential (storage, source, or infra — PG, Neo4j, MinIO, Consul,
IMAP, Telegram, Google, …) is ever present in any cloud-harness environment.** Only the OB1
*server* and its ingest processes hold them.

**This must be a mechanism, not advice (Codex v4):**
- **Env split:** the agent shell loads *only* the client MCP env (remote endpoint + scoped
  client key); the server / ingest process manager loads the server-only env separately.
  `devenv.nix:4-5,14` (which loads the service dotenv into the interactive shell) must change.
- **Startup guard = ALLOWLIST / default-deny (Codex v5):** the harness env may contain ONLY
  the client MCP vars (remote endpoint + `OB1_REPO_KEY`); the client **fails fast on any other
  cred-shaped var.** A blacklist misses renamed secrets — runtime already accepts
  `OPEN_BRAIN_DATABASE_URL` / `DATABASE_URL` / `POSTGRES_PASSWORD` (`config.mjs:203-219`), and
  integrations add `TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`, MinIO aliases, etc.

In remote prod, harnesses naturally hold none of these (they speak MCP over TCP); the **dev
workflow is the leak.** **v0, foundational — without it, everything below is theater.**

### 4.6.a Membership scoping + an isolated-brain kind (Codex v2/v3)
Unscoped reads fan out over everything `accessible` (`access-policy.mjs:402`); a brain enters
`accessible` via grant, **estate membership** (`:283`), or **admin home-estate reach** (`:286`).
So `common-private` leaks unless no public principal reaches it. The current model can **test**
this invariant but **cannot make it idiot-proof** (Codex v3): either a **truly isolated estate
with no public estate/admin path + permanent tests**, or — better — a **first-class
`scope_isolated` / capability-only brain kind that estate/admin fanout cannot reach by
default.** Recommend the brain-kind. **But a label alone does nothing (Codex v4):**
`brains.kind` already exists (`migrations/005:21`), yet `fetchBrainCatalog` (`auth.mjs:128`)
does not select it and `deriveScope` (`access-policy.mjs:291`) still grants via estate/admin
reach. To matter, `fetchBrainCatalog` must fetch `kind` and **`deriveScope` must exclude
`scope_isolated` brains from estate/admin fanout — reachable only by an explicit brain grant.**
**Two paths (Codex v5):** exclude isolated brains from *unscoped read/list/stats/search fanout*
(including admin reach), but allow **named operator maintenance** (purge/reconcile/backfill) to
target them via an **explicit capability + audit** — else maintenance breaks.

### 4.6.b Legacy admin — universal bypass, retire from harness reach (v0)
`resolveAccessContext` checks `key === config.accessKey` **before** stored-key lookup → global
admin (`auth.mjs:480`). Any harness holding `MCP_ACCESS_KEY` defeats everything. No harness
ever holds the bare legacy key; gate/remove the legacy global path from the normal MCP surface.

### 4.6.c Graph plane (Codex v2/v3)
Projection reads `forceAll` across brains into **one Neo4j namespace** (`graph-projection.mjs:62`);
reads scrub by **liveness, not brain** (`graph-reads.mjs:117`). Two-brain does not cover graph.
**"Keep public graph dead" (admin-only via `ensureGraphAdmin`, server.mjs:730) is sufficient for
v1 ONLY IF all hold:** (1) legacy admin gone from harness reach (§4.6.b); (2) no cloud key is
admin/private-capable; (3) **Neo4j creds not in agent env (§4.6.0)**; (4) graph stats/telemetry
don't leak. If any fail, **namespace the graph now**, not v2.

### 4.6.d Token custody
Bearer needs a **trusted local transport/sidecar** holding it in memory and injecting
`Authorization` — else it spills into env/logs/args. A design element, not a footnote.

### 4.6.e Model/processor egress is a plane (Codex v4, verified)
OB1 itself sends content out for processing: `createEmbedding` POSTs thought content to the
embedding endpoint (`models.mjs:298`), `extractMetadata` (`models.mjs:315`) and
`answerFromEvidence` (`models.mjs:361`) POST content/evidence to the LLM; Docling/VLM ingest
similarly. **If any of these endpoints is a cloud service, private content egresses through OB1
regardless of every access control.** Requirement: **for private-tier content, the embedding /
LLM / Docling / VLM endpoints MUST be local-trusted (on-box), or private mode refuses** the
capture/ask. Add a config assertion: private-tier processing fails closed unless
`EMBEDDING_BASE_URL` / `LLM_BASE_URL` / processors resolve to the local trusted boundary.
**Per-tier, not a single global URL check (Codex v5):** the egress policy must key on
brain/tier/taint — public content may tolerate other processors, but **`common-private` +
tainted content require local-only processors**. A global assertion is either too blunt
(blocks public) or too weak (lets a per-thought private leak slip).

### 4.6.f Private-safe error handling (Codex v5, verified)
`requestJson` embeds the upstream response body in thrown errors (`models.mjs:285`) and MCP
returns error text to callers (`errorToolResult`, `server.mjs:194`). So an LLM/embedding/
processor that echoes private prompt/evidence in an error delivers it to the cloud harness via
normal tool output. **Errors crossing to a caller must be sanitized** — no upstream bodies, no
private content, in any message returned over MCP.

### 4.6.g Logs / audit / backups / telemetry are private-derived planes (Codex v5)
Telemetry stores query previews + result/graph ids (`observability.mjs:161`); purge audit
`old_state` snapshots **content + metadata** (`thought-store.mjs:386`); backups and log shipping
carry both. Private-tier content/derived data in these stores needs an explicit
**retention/redaction policy** (cf. docs/32 on erasure vs backup/telemetry retention), not a
silent copy. Each is a plane the §4.6 invariant must cover.

## 5. Mechanism
### 5.1 Credentials & capabilities
New **`capabilities`** dimension (`access-policy.mjs:162-187` ladder is `READ ⊆ WRITE`).
- **Repo key** — per-harness remote-MCP **client** credential, **distinct name (e.g.
  `OB1_REPO_KEY`), NOT `MCP_ACCESS_KEY`** (Codex v4): `MCP_ACCESS_KEY` is the server-side legacy
  admin bypass (`config.mjs:349`, §4.6.b) and must never be a client cred. The repo key is
  **attribution + low-privilege scope, NOT isolation under same-user.** Capability-per-key is a
  real auth change (stored-key auth collapses to `principal_id+is_admin`, `auth.mjs:379`).
- **Common session** — `pi` only; private-tier read + promote/publish; **bearer in
  `Authorization` only** (never `?key=` — `auth.mjs:35`), held by a local transport (§4.6.d),
  absolute short TTL, revocation each request.

### 5.2 Flows
- **Everyday:** repo key → own repo brain; **public** tier; **submit** thought-requests. No
  private-tier materialization on any plane.
- **`pi` unlock:** hidden-TTY passphrase → `POST /auth/unlock` (TLS, header-only) →
  argon2id + rate-limit → bearer session → full common this session; passphrase discarded.
- **Promote/publish:** unlocked session; per-item-confirm publish (v1); tainted never published.

### 5.3 Custodian
Agents **submit**; a local custodian adjudicates persistence + tier.
### 5.4 Provenance taint
Origin + sensitivity flag; publishing a `sensitive`-origin thought is deny-by-rule.

## 6. §6 deadlock — RESOLVED by tiering
Cloud reads the public tier and benefits; private tier needs an unlocked session.

## 7. Why this supersedes `ob1-unlock`
Keeps its hidden-TTY unlock; drops the per-request signing/nonce crypto (hardens the
already-moot credential-theft path, does nothing for the leaking paths or §4.6, ships three
blockers). Big bespoke crypto, low marginal value.

## 8. OUT / DEFERRED / ACCEPTED
- **Out:** separate OS user; sandboxing `pi`.
- **Deferred:** Ed25519 signing/nonces/PoP; Secure-Enclave session key (v2 lever vs memory scrape).
- **Accepted residual:** active malware as the user scraping `pi`'s session memory; a human
  pasting private content into a cloud agent. Beyond these is the Beria tautology.

## 9. OB1 / repo changes (feasibility = MEDIUM→LARGE)
| Area | Change |
|---|---|
| **Non-MCP creds (§4.6.0, v0)** | ALL non-MCP creds (PG/Neo4j/MinIO/Consul/**IMAP**/Telegram/Google) out of every harness env. **Env split** (agent shell = client MCP env only; server/ingest = server env) — change `devenv.nix:4-5,14`. **Startup guard** fails the client if any forbidden var is present. |
| **Model/processor egress (§4.6.e, v0/v1)** | private-tier embedding/LLM/Docling/VLM must be local-trusted; config assertion makes private capture/ask fail closed if `EMBEDDING_BASE_URL`/`LLM_BASE_URL` aren't local (`models.mjs:298,315,361`). |
| **Repo key name** | client key is `OB1_REPO_KEY` (distinct), never `MCP_ACCESS_KEY` (`config.mjs:349`). |
| **`scope_isolated` (§4.6.a)** | `fetchBrainCatalog` fetch `brains.kind` (`auth.mjs:128`); `deriveScope` exclude isolated brains from estate/admin fanout (`access-policy.mjs:291`). |
| **Legacy admin (§4.6.b, v0)** | no harness holds `MCP_ACCESS_KEY`; gate/remove legacy global path (`auth.mjs:480`). |
| **Isolated brain (§4.6.a)** | `scope_isolated`/capability-only brain kind unreachable by estate/admin fanout, OR isolated estate + invariant test (repo-key `resolveReadBrains` never includes `common-private`). |
| Capabilities | `access-policy.mjs` caller kinds + `capabilities`; `auth.mjs` thread through; `resolveSessionContext`; capability-per-key reshapes stored-key resolution. |
| Bearer custody | reject `?key=` for sessions (`auth.mjs:35`); local transport injects `Authorization`. |
| Read planes | tier/brain-scope `match_thoughts*`, `search_thoughts_text`, `list_recent_thoughts`, `get_thought_connections`, **`brainStats`** (thought-store.mjs:495), **`readThoughtRowsByIds`**+callers (thought-store.mjs:487). |
| **Graph (§4.6.c)** | keep non-public (server.mjs:730) under the 4 conditions, else namespace projection (graph-projection.mjs:62) + reads (graph-reads.mjs:117). |
| Telemetry | `observability.mjs:88-163` (default-on, `config.mjs:329`): disable/hard-redact for private reads. |
| `include_private` | from `accessContext.capabilities` only, never a tool arg (server.mjs:369). |
| Metadata patch | visibility/taint not mutable via `/admin/thought/metadata` (server.mjs:1060); only promote/publish endpoints. |
| Endpoints/migrations/infra | `POST /auth/unlock`; promote + per-item-confirm publish; `ob1_sessions(...)` (no nonce table); **TLS in front of OB1**. |

## 10. Phasing
- **v0 (regardless):** **ALL non-MCP creds (storage + source + infra) out of harness env via
  allowlist guard (§4.6.0)**; **retire `MCP_ACCESS_KEY`
  from harness reach (§4.6.b)**; TLS; per-harness keys (attribution). NB: `.env*` are now `600`
  (corrected) — that is hygiene against *other*-user/group readers, **not** a same-user control,
  and irrelevant if the creds are loaded into a same-user agent shell.
- **v1:** §4.5 decision; capabilities; `/auth/unlock` (argon2id+rate-limit, header-only bearer +
  local transport); tier enforcement across every plane in §9 incl. graph + telemetry; per-item
  publish; metadata-patch lockout; isolated-brain invariant + test.
- **v2:** out-of-band publish confirm; Secure-Enclave session key; custodian curation; graph
  namespacing if needed.

## 11. Open decisions
1. **§4.5** row-flag vs two-brain — both reviewers say two-brain; owner confirm.
2. **§4.6.a** isolated estate + tests vs a new `scope_isolated` brain kind.
3. **§4.6.c** keep public-graph dead (under the 4 conditions) vs namespace now.
4. Promote vs publish (two, proposed); default tier (private, proposed).

## 12. Codex reviews — verified
- **v1:** ranked SQL not the choke-point; bearer `?key=` leak; per-harness key ≠ boundary;
  publish v1 confirm; `include_private` from caps; metadata-patch backdoor. **Folded.**
- **v2:** membership/estate/admin-home reach (`access-policy.mjs:266,286,402`); legacy-admin
  bypass (`auth.mjs:480`); graph one-namespace + liveness-scrub (`graph-projection.mjs:62`,
  `graph-reads.mjs:117`); token custody; telemetry; `chmod 600` is hygiene. **Folded.**
- **v3 (this rev), verified:** **CRITICAL service-credential custody** — `devenv.nix:4-5,77`
  loads PG/Neo4j/MinIO/Consul creds into the shell; a harness there bypasses MCP via direct
  storage access. **→ §4.6.0.** HIGH — §4.6.a not idiot-proof in current model → isolated brain
  kind. MEDIUM — public-graph-dead needs 4 conditions. LOW — **`.env*` are `600` now, not
  world-readable; author's prior "world-readable" claim was stale (changed during the session)
  — corrected here and in brain notes.**
- **v4 (this rev), verified:** HIGH — credential surface includes **source creds** (`IMAP_PASSWORD`,
  `.env.open-brain-local`) → §4.6.0 generalized. HIGH — **model/processor egress** plane
  (`models.mjs:298,315,361`) → §4.6.e. MEDIUM — v0 must be a **mechanism** (env split + startup
  guard), `devenv.nix:4-5,14` loads the service dotenv. MEDIUM — `scope_isolated` is inert unless
  enforced in `deriveScope` (`brains.kind` exists `migrations/005:21`, unused) → §4.6.a. MEDIUM —
  **distinct client key name**, not `MCP_ACCESS_KEY` → §5.1. **All confirmed; folded.**
  Codex v4 verdict: per-harness repo key worth keeping as a **remote MCP client** credential; v0 =
  remote MCP endpoint + scoped client key + **zero storage/source creds in harness env**.
- **v5 (this rev), verified:** HIGH — startup guard must be **allowlist/default-deny** (runtime
  accepts `DATABASE_URL`/`POSTGRES_PASSWORD`/`OPEN_BRAIN_DATABASE_URL`, `config.mjs:203-219`) →
  §4.6.0. HIGH — **private-safe errors**: upstream body in errors (`models.mjs:285`) → caller
  (`server.mjs:194`) → §4.6.f. MEDIUM — **logs/audit/backups** plane (`observability.mjs:161`,
  `thought-store.mjs:386` content snapshot) → §4.6.g. MEDIUM — `scope_isolated` **read-fanout vs
  explicit maintenance** split → §4.6.a. MEDIUM — **per-tier egress** policy, not global → §4.6.e.
  LOW — v0 wording said "storage creds"; now "all non-MCP creds". **All confirmed; folded.**
  Codex v5 verdict: **design is close; after these, remaining work is mostly implementation + tests.**

## 13. For Codex (round 6 — convergence check)
Codex v5 judged the design close and the remaining work mostly implementation + tests. Final
sweep:
1. Any data/egress plane STILL unexamined after §4.6.a–g (MinIO object reads, Consul KV, ingest
   services' own creds/egress, log shipping, backup restore paths)?
2. Does the read-fanout-vs-maintenance split (§4.6.a) cleanly cover every admin/operator path
   that legitimately touches isolated brains (purge, reconcile-orphans, backfill, projection)?
3. Is §4.6.f/g specification-complete enough to hand to implementation, or do the
   redaction/retention rules need to be pinned per-store?
4. If nothing material remains: confirm the design is ready to convert into a phased
   implementation plan + test matrix.
