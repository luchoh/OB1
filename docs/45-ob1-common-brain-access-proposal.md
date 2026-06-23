# 45 — The Cloud-Egress Boundary

**Status: FROZEN design baseline (Rev 8) — coherent enough to implement; NOT "approved secure." Owner has approved nothing.** Security now depends on code, migrations, tests, and operational proof — not more prose. The prose red-team loop is closed at v8: no further architecture rewrites here. Resolved-vs-owner-discretion choices and the implementation gates are in §17; the executable plan (migrations, policy helper, capability matrix, test matrix) lives in a separate implementation doc.
**Date:** 2026-06-24
**Rev:** 8 — FROZEN (Codex reviews v1–v8 folded — disposition §10–§16; freeze §17)
**Author:** Claude Code (Opus 4.8)
**Lineage:** supersedes the veil framing in [docs/44](44-ob1-reflexive-capture-and-veil-prd.md); folds [docs/46](46-ob1-common-brain-access-design-and-postmortem.md); red-team findings in [review-v1](45-ob1-common-brain-access-proposal-review-v1.md) + [review-v2](45-ob1-common-brain-access-proposal-review-v2.md) + [review-v3](45-ob1-common-brain-access-proposal-review-v3.md) + [review-v4](45-ob1-common-brain-access-proposal-review-v4.md) + [review-v5](45-ob1-common-brain-access-proposal-review-v5.md) + [review-v6](45-ob1-common-brain-access-proposal-review-v6.md) + [review-v7](45-ob1-common-brain-access-proposal-review-v7.md) + [review-v8](45-ob1-common-brain-access-proposal-review-v8.md). Defers all access policy to ADR-0001 / ADR-0002 / ADR-0003 and `CONTEXT.md`.

**The through-line (Codex v3):** every "create" path is really *create-or-update* (capture is an upsert), every origin label must be **non-washable** (monotonic taint), and every private-processor check must happen **before bytes leave the handler** (egress precedes insert). These three discipline the seams below.

---

## 1. Problem

The membership/role/DENY model governs **who may read** a brain. It is settled and this doc does not re-litigate it. But it assumes the reader is trustworthy with what it reads, and that every writer's contribution is trustworthy. A **cloud harness** (Claude Code / Codex / Gemini) with *legitimate* access (a) exfiltrates anything it reads to its model provider, and (b) can write content the local-trusted side will later read and trust. This doc is the egress **and write-integrity** boundary: keep content that must not reach a cloud provider from being **served to / processed for / relabelled by** a cloud-bound caller, **and** keep a cloud-bound caller from **mutating or poisoning** the local-only side — across every plane.

---

## 2. What this does NOT touch

This doc reuses settled mechanisms and invents no access primitive (with one explicitly-flagged exception, §3 boundary taxonomy / §8.7). It defers to:

- **ADR-0001** — default-deny allowlist; estate / brain membership grants; **brain-level DENY is the only subtractive mechanism**; capture is agent-decided, skill-driven, per call. **Principal granularity is per-repo (pt 5)** — this doc *refines* that for the trusted local agent (§3, Layer A).
- **ADR-0002** — monotone role ladder (viewer ⊂ editor ⊂ owner; member ⊂ admin); brain-level DENY clamps **every** caller shape including stored admin keys.
- **ADR-0003** — cross-estate reach is membership-granted, never ambient; bare `MCP_ACCESS_KEY` is the only global actor, pending retirement; **capability-per-key is a flagged future feature**.
- **`CONTEXT.md`** vocabulary is binding. The **common brain** is *forthcoming* — a brain in the agent estate with memberships to every repo principal; grants not yet provisioned.

Does **not** invent: a separate isolation *brain kind* (`scope_isolated`), estate-level DENY, ambient admin reach, per-agent/per-tool cryptographic identity, a new ladder role, or a capture-adjudicating custodian. Where a stored-key attribute (§6.2) or a tier-transition capability (§6.7) is needed, it is named as the flagged capability-per-key feature being spent. **Honest reconciliation (Codex v5 F2):** the brain-level `egress_class` (§6.13) is proposed as an **authorization input** to scope derivation, not merely a redaction hint — i.e. it does the job the rejected `scope_isolated` kind gestured at, but as a *constrained value on the existing `brains` row participating in `deriveScope`*, not a new primitive or table. The distinction is real (no new entity, no new ladder), but the function is now owned, not hand-waved.

---

## 3. The hard ceiling, and which boundary is which (honest)

pi and the cloud harnesses run as the **same OS user on the same machine**. OB1 authenticates **credential → principal** (`auth.mjs:480` legacy bypass, then `auth.mjs:484` stored-key resolve); it **cannot cryptographically distinguish pi from Codex**. Fingerprinting "with certainty" is impossible here. The boundary is **credential + egress + derived-data + write-path custody**, plus **OB1 never being the leak/relay path** — not identity proof.

**Codex's central v2 point — name the boundary you are using.** The layers are different animals:

| Layer | Boundary | Separates | Mechanism |
|---|---|---|---|
| **A** | **Principal** | distinct *principals* only | membership presence/absence (ADR-0001) |
| **B** | **Key / row** | callers *within one principal* on a *shared* brain | server-derived `read_egress_class` read-clamp (capability-per-key, §6.2) |
| **C** | **Write integrity** | what a cloud-bound writer may create/mutate | label protection, atomic tiering, no-mutate-restricted, origin taint (§6.7–6.11) |
| **D** | **Processor** | which model/embedding endpoints may see `restricted` | pinned local processor identity (§6.5) |

**The consequence (Codex F1, verified):** `brain_memberships` is keyed `(principal_id, brain_id)` (`migrations/005:59`); `brain_access_keys` carries `principal_id` + a default-`brain_id` hint only (`005:83-95`). **Memberships attach to principals, not keys.** So Layer A separates **only across distinct principals**. Two keys for the *same* principal share the *same* membership scope, and a brain-level DENY also targets the principal — it would clamp pi's local key together with Codex's cloud key. **Therefore:**

- The local agent (**pi**) is a **distinct local-trusted principal**, not a second key on a shared repo principal. Cloud tools in repo X share the repo-X principal (ADR-0001 pt 5); **pi does not** — it is the trusted on-box identity with its own memberships. This is the *refinement* of pt 5 flagged in §8.7. Only then does Layer A (membership absence) actually separate pi from Codex.
- Layer B (`read_egress_class`) is **not** the pi/Codex separator for private *brains*; it is the belt-and-suspenders clamp for the **single genuinely-shared brain** that both pi's principal and cloud principals have membership to *and* that holds a `restricted` slice.
- If anyone insists pi and the cloud tools share **one** principal, Layer A cannot separate them at all, DENY cannot either, and you would need a genuinely **new key-scoped-reach authorization primitive** — explicitly out of scope here.

**Accepted residuals (rejected "Beria"):** a same-user process actively stealing pi's local-trusted key from its files/memory; a human copy-pasting local content into a cloud agent; cloud harnesses reading+exfiltrating `standard` content (by design, §7).

**In-scope threats** (each gets a mechanism below): write-side declassification (§6.7); born-standard capture window (§6.8); **cloud mutation of unreadable `restricted` rows** — incl. the **capture-upsert side-door** (a colliding `dedupe_key` reaches `ON CONFLICT DO UPDATE`, §6.8/§6.10); **cloud-origin `restricted` writes as hidden injection** plus **taint-laundering** (a later local patch washing cloud origin, §6.11); **content reaching a processor before the tier is checked** (§6.5/§6.8); **a same-user cloud process invoking pi's sidecar as a confused deputy** (§6.12); **a quarantined row leaking through a non-`ask` plane** — search/list/stats/graph/projection/by-id (§6.11); the existence/count oracle via `stats` (`thoughts_stats` `migrations/011:194`, no tier filter — §6.2). **Not Stalin** (we keep the tool) and **not Beria** (we don't summon an omnipotent adversary).

---

## 4. `sensitivity_tier` — definition

Column exists: `migrations/006:22` (`sensitivity_tier text default 'standard'`). Existing read semantics treat `restricted` as *held back* (`p_exclude_restricted boolean DEFAULT TRUE`). Proposed binding `CONTEXT.md` definition:

| tier | meaning | egress rule |
|---|---|---|
| `standard` | cloud-safe | served / processed / mutated for any caller incl. cloud-bound |
| `restricted` | local-on-box-only | served / processed / **mutated** / relabelled **only** for a local-class caller via local processors |
| `personal` | (proposed, **flagged**) same as `restricted` | **no schema representation today**; introduced by this doc — map to `restricted`-equivalent at every clamp, or drop (§8.1) |

**Label integrity (Codex F9, refined).** The API patch schema already enforces the enum (`z.enum([...])`, `server.mjs:87`) — typos can't enter via that route — but the **DB column is plain `text`**, so direct SQL / import tooling / capture can write garbage. Add a **DB CHECK/enum** before the tier is load-bearing, and make every read **and write** clamp **fail closed on an unknown value** (treat unknown as `restricted`).

The held-back flag is a caller-supplied SQL boolean today, honored only on dormant functions. This doc makes it **server-derived** (§6.2) and extends it to the planes that ignore it (§5).

---

## 5. The invariant and the plane table

> **For a cloud-class caller:** no plane emits `restricted`/`personal` content, derived data, or a content-derived answer; no write path lowers a `restricted`/`personal` label or mutates an existing `restricted`/`personal` row; cloud-origin `restricted` writes are tainted and excluded from local-trusted retrieval until reviewed; and OB1 never relays such content to a non-local processor or persists it in an agent-readable artifact.

Layer A covers **only Postgres brain-scoped read planes** (those resolving through `resolveReadBrains`/`brainId` against the accessible set). It does **not** cover the **graph** (brain-blind: `graph-reads.mjs` takes no `brain_id`; projection merges all brains into one flat namespace `graph-projection.mjs:154`). The Rev-1 "every read plane covered transitively" was an overclaim (Codex v1 F4); the table is authoritative.

**Layer A is a *principal+scope* boundary, and "no brain membership" alone is not isolation (Codex v5 F2).** A `private_local` brain with no explicit repo-principal *brain* membership still enters `accessible` if that principal holds **estate membership** in the brain's estate or a stored admin key has **home-estate reach** (`access-policy.mjs:283`/`:286`), then unscoped reads fan out over it (`:410`). Per-principal brain-level DENY *can* close this but is fragile (a future cloud principal with estate membership reaches the brain until someone remembers the DENY). So Layer A is made idiot-proof **one of two ways — §8.13, pick one:** (i) provision `private_local` brains in a **separate estate** with no cloud-principal estate-membership and no cloud-held admin-home path, plus a continuous invariant test; or (ii) make `brains.egress_class` (§6.13) an **authorization input** so `deriveScope`/`fetchBrainCatalog` **exclude `private_local` brains from estate/admin fanout and from naming by cloud-bound callers**, leaving only an explicit, named, **audited, non-fanout maintenance capability** for operator upkeep (purge/reconcile/backfill). "Admin can maintain it" must not silently become "admin reads it from normal MCP tools."

| Plane | What egresses / mutates | Tier today | Rule |
|---|---|---|---|
| `search_thoughts`/`list_thoughts`/`similar` (active `match_thoughts` `015:41`, `match_thoughts_recency` `015:88`, **`list_recent_thoughts` `015:278`**) | full content, metadata, similarity, brain id | **No** — active fns take no tier param | Layer A, or Layer B: add a WHERE predicate from the **server-set** ceiling; filter **before** rank/threshold/count. **Base the migration on `015` (all three fns, incl. `list_recent_thoughts`), or `pg_get_functiondef` — preserve the conversation-record exclusion (`015:304`), tombstone/metadata/dimension predicates, `STABLE`/`security definer`/`search_path`, limit placement (Codex v1 F6 + v2 F4)**, else the tier migration silently reverts the 015 corpus fix |
| `ask_brain` — **ranked SQL *and* graph-assisted by-id rehydration** (`handleAskBrain`; `retrieveEvidenceRows` does ranked `retrieveThoughts` then `expandThoughtsWithGraph` `retrieval.mjs:898`/`:906`; graph neighbor ids → `readThoughtRowsByIds` which filters only id/brain/tombstone/metadata `thought-store.mjs:457-461`; `answerFromEvidence` `models.mjs:359`) | LLM answer + citation excerpts to caller | **No** | **Clamping `match_thoughts` alone is a trap (Codex v5 F4):** graph expansion + by-id rehydration is a *second materialization plane* that re-adds restricted/quarantined neighbors of an allowed seed. Treat graph-assisted `ask` as its own plane: thread the §6.15 effective-egress policy into **both** seed retrieval **and** graph expansion/`readThoughtRowsByIds`, applied **before** evidence selection, telemetry, and answer generation. Prefer SQL-layer clamp (a post-retrieval gate leaves content in the JS heap). Local-trusted `ask` excludes/marks cloud-origin evidence (§6.11) |
| **WRITE — label mutation** (`sensitivity_tier` in patch schema `server.mjs:87`; `/admin/thought/metadata` gated by `authorizeWrite` only `server.mjs:1069`; written `thought-store.mjs:166`) | `restricted`→`standard` declassification by any WRITE-capable cloud key | **No** | §6.7 (Layer C1) |
| **WRITE — any mutation of a `restricted` row** (`patchThoughtMetadata` mutates metadata/type/source/importance/quality/enriched/status `thought-store.mjs:146`; delete/restore/purge `server.mjs:1104`/`:1121`/`:1141` gated by brain/action capability, **not row tier**) | blind metadata/lifecycle mutation of a row the caller cannot read; existence oracle via mutation responses | **No** | §6.10 (Layer C3): cloud-bound callers may **not** patch/delete/restore/purge an existing `restricted`/`personal` row |
| **WRITE — capture (create-or-update)** (`handleCaptureThought` authorizes brain WRITE then embeds+extracts **before** insert `server.mjs:310-326`; `captureThought` is an **upsert** `on conflict … do update` `thought-store.mjs:85`; default `standard` `006:22`) | sensitive content **born `standard`**; a colliding `dedupe_key` mutates an existing `restricted` row's content/embedding/metadata; raw content reaches processors before any tier check | **No** | §6.8 (Layer C2): tier set atomically at capture; **conflict path is tier-aware** (deny cloud-bound upsert onto an existing `restricted`/`personal` row, §6.10); **processor-trust asserted before the embed/extract calls** (§6.5) |
| **WRITE — cloud-origin restricted** (raising label allowed by any writer) | hidden write-only channel from cloud into local-trusted evidence (prompt injection / poisoned memory) | **No** | §6.11 (Layer C4): origin taint; disallow-or-quarantine cloud-origin `restricted` in shared brains |
| `graph_neighbors`/`source_lineage`/`why_connected` (`graph-reads.mjs`; `ensureGraphAdmin` `server.mjs:730`; scrub liveness only `:117`) | node summary/`content_preview`/evidence | **No** | (1) tier: projection includes `restricted`; (2) cross-brain: brain-blind, hops A→B via shared entity nodes. Pick one v1 rule: exclude `restricted`/local-only from projection; partition by brain/tier + filter every read; or keep graph unreachable by cloud-held creds and **prove with tests** (§8.3) |
| `expand_context` (`readThoughtRowsByIds` `thought-store.mjs:435`) | seed + expanded full rows | **No** | server-set ceiling on `readThoughtRowsByIds` + the graph gap |
| `stats` (`brainStats` `:495` → `thoughts_stats` `011:194`) | counts + top_people/sources/types | **No** — no tier param (and `015:19-24` keeps stats counting records) | ceiling **before** aggregation (existence/count oracle, §3) |
| Graph projection loop (`fetchProjectionCandidates` scans all brains/tiers `graph-projection.mjs:71`; node write `:154`) | content-derived props into Neo4j, no tier filter | **No** | exclude `restricted` from projection, or graph admin-only-and-dead (§8.3) |
| Telemetry (`observability.mjs` `basePayload` `:128-133`; error text `:136`/`:200`) | `query_preview` + ids + `brain_slug` + `auth_source` + error text, local disk | **No** | redaction keys off **request/caller context**, not only persisted row tier: a `local_trusted` query is private even with zero/`standard` results; a private-brain slug leaks existence; a capture fails before any tier exists. Default `local_trusted` + private-brain + tier-unknown requests to **no** raw preview/slug/URL/error text (§6.6/§8.4) |
| Purge audit (`thought-store.mjs:386` `old_state`) | content + metadata at-rest | **No** | retention/redaction for `restricted` (§8.4) |
| Error bodies (`models.mjs:284-286` body+status+URL; `errorToolResult` `server.mjs:194-210`; telemetry `observability.mjs:136`/`200`) | upstream body + internal URL to caller **and** logs | **No** | §6.6: opaque ids; nothing private in caller path *or* logs/telemetry |
| **HTTP REST** (`/ask` `:1031`; `/admin/thought/similar` `:1177`; `/graph/*` `:1188`–`:1221`) | same egress as MCP tools; shared handlers | **No** | clamp at **handler dispatch**, not only MCP dispatch |
| **Operator tier backfill / enrichment** (`scripts/thought_enrichment/lib/db.py` direct PG `:68` + patches tier via `/admin/thought/metadata` `:228`; `backfill_sensitivity.py` scans + upgrades `:44`, needs PG env + `MCP_ACCESS_KEY` `:16`) [Codex v2 F5] | tier mutation via the generic route + direct PG + legacy-key auth | **No** | route through the §6.7 local-trusted tier endpoint; classify operator-only, **outside cloud-harness reach**; test it cannot run from a clean agent env. (Backfill only *upgrades* — safe direction — but the auth/route shape is the problem) |
| Credential channel (`?key=` accepted before headers `auth.mjs:35`) | `local_trusted` key in URL → logs/screenshots | n/a | §6.9: reject `?key=` for `local_trusted`; redact cred-shaped params |
| `GET /health` | model names + health JSON, unauth | n/a | topology only — out of scope (noted) |
| Calibration sampler (`calibration-sampler.mjs`) | full content to local JSONL via direct PG | **No** | operator-only path; §6.1 + discipline |

---

## 6. Mechanism

### 6.1 Non-MCP credential custody — v0, *structural*, not a polite guard (Codex v1 F3, v2 F6)

A startup allowlist guard is **not** a server-side control: OB1 cannot inspect a cloud client's env, and cannot force arbitrary repo scripts to run it first. The boundary must be **structural**:

- **Remove every repo-local service-secret autoload, not just `config.mjs`.** `config.mjs:27` calls `loadRepoEnv()` at import (reads `.env.open-brain-local` → `process.env`), so importing config from a clean env repopulates all creds. Other launchers load it independently: `devenv.nix:4`/`:75`, `scripts/eval-open-brain-ask-ab.mjs:31`, `scripts/smoke-open-brain-running-service.sh:9`.
- **Move service secrets outside the repo** and outside default agent-readable launch paths (operator-owned: `$XDG_CONFIG_HOME/open-brain/service.env`, launchd env, Keychain/agenix/1Password). The cloud-harness path must be *incapable* of obtaining them, not merely discouraged.
- **The allowlist guard is a regression tripwire** for approved launchers (runs before any dotenv load; default-deny on cred-shaped vars — not a blacklist, since the runtime accepts `OPEN_BRAIN_DATABASE_URL`/`DATABASE_URL` `config.mjs:204`, `PGPASSWORD`/`POSTGRES_PASSWORD` `:219`/`:234`, IMAP/Telegram/Slack aliases). **Not** the main barrier.
- **Repo-wide test — covering docs and launch examples, not just runtime JS (Codex v3 F5):** fail CI if any cloud/client script **or doc/README** sources `.env.open-brain-local` or mixes `MCP_ACCESS_KEY` with PG/Neo4j/Consul/MinIO/IMAP/source creds. Existing offenders teach agents the wrong pattern: `recipes/email-history-import/README.md:78` (sources `../../.env.open-brain-local`), `local/open-brain-mcp/evals/eval-graph-retrieval.py:95`, `integrations/telegram-capture/README.md:39`, `recipes/dictation-import/README.md:35`, `recipes/shared_docling.py:33` (`OPEN_BRAIN_INGEST_KEY`/`MCP_ACCESS_KEY` + Consul). **Split operator recipes from cloud/client recipes**; move operator launch docs out of the default agent path or hard-guard them to refuse cloud-class env; replace `MCP_ACCESS_KEY` examples with `OB1_REPO_KEY`/`OB1_OPERATOR_ACCESS_KEY` as appropriate.

### 6.2 `read_egress_class` — server-side, every caller shape (Codex v1 F5)

`read_egress_class` (`local_trusted` | `cloud_bound`, **default `cloud_bound`**) is carried in caller context alongside `isAdmin`/`kind`, **never a tool argument**. Every read/derived plane forces `exclude_restricted := (read_egress_class != local_trusted)`. Defined for **all** shapes:

- **Stored key** — new column on `brain_access_keys` (`005:83-95` has none), surfaced via `resolveStoredAccessKeyContext` (`auth.mjs:379-388`, today selects `key_brain_id, is_admin, principal_id`).
- **Human JWT** — `makeContext` (`auth.mjs:314`) / human path (`auth.mjs:330`) carry no egress field; default `cloud_bound`; `local_trusted` requires explicit local transport/session binding.
- **Legacy admin** (`auth.mjs:480`) — denied or forced `cloud_bound` (§6.3).
- **Internal operator/maintenance** — explicit audited `local_trusted`, never inferred.

This is the **flagged capability-per-key feature (ADR-0003)**: new migration + SELECT/context change + the ADR amendments (§8.7). It is Layer B (key/row), **not** the pi/Codex *principal* separator — that is Layer A via a distinct local principal (§3).

**Split the caller class (v1) from the shared-brain row clamp (v2) (Codex v6 F2).** The *row-level* clamp on a genuinely-shared brain is a v2 feature — but v1 *already depends* on knowing whether a caller is `cloud_bound`: `private_local` exclusion (§5/§6.13), the local-trusted-only review endpoint (§6.11), the sidecar's `local_trusted` injection (§6.12), and the §6.15 helper all consume `caller.read_egress_class`. If implementation defers the whole feature to v2, v1 falls back to `isAdmin` / principal slug / route shape / vibes. So **v1 introduces the minimal caller trust class** (`local_trusted` vs `cloud_bound`, default `cloud_bound`, carried for all caller shapes — the v1 rule is "only pi's principal/transport is `local_trusted`, everything else `cloud_bound`"); **v2 adds the shared-brain row-level clamp** that consumes it. Every v1 route that names/lists/searches/mutates/reviews/projects/maintains a `private_local` brain must decide from this explicit class, not admin status or route conventions.

**`local_trusted` (read-receipt) ≠ reviewer/approver authority (Codex v7 F7).** `read_egress_class` answers "may these bytes reach this caller." It must **not** be the gate for *approval* decisions — quarantine approval, tier downgrade, brain-egress-class downgrade, export, purge, publish, high-risk side effects — or the sidecar degrades "from a read transport into a root ceremony": any local-trusted process could declassify everything. Split the concepts: `read_egress_class` (confidentiality) **and** `actor_role` / `capabilities` / `approval_presence` / `human_confirmation_id` (authority). Local-trusted read is **necessary but not sufficient** for any approval/declassification/destruction op; those additionally require the **operation-specific capability + an explicit human confirmation bound to the exact operation and target** (§6.12's per-call approval binds to op+target, not a session-wide unlock).

### 6.3 Legacy admin out of harness reach
`auth.mjs:480` short-circuits to global admin before stored-key lookup (`config.mjs:349` `accessKey = MCP_ACCESS_KEY`). **No cloud harness holds `MCP_ACCESS_KEY`;** the legacy path is denied or forced `cloud_bound` and retired (ADR-0003 pending-retirement). v0.

### 6.4 Deliberate key naming — inventory, not prose (Codex v2 F7)
The client credential is a **stored access key**, not the bare legacy env key. Many client/ingest paths still default to `MCP_ACCESS_KEY`/`OPEN_BRAIN_ACCESS_KEY` (`integrations/telegram-capture/telegram_bridge.py:77`, `recipes/dictation-import/import-dictation.py:67`, `recipes/chatgpt-conversation-import/import-chatgpt.py:73`, `recipes/claude-conversation-import/import-claude.py:50`, smoke/eval). Inventory every credential var:
- **Repo/cloud client** → `OB1_REPO_KEY` first; never the legacy admin key.
- **Operator/admin scripts** → `OB1_OPERATOR_ACCESS_KEY` (or explicit operator env), not `MCP_ACCESS_KEY`.
- **Server runtime** → may keep `MCP_ACCESS_KEY` only as the legacy admin var while it exists.
- Compatibility fallbacks warn loudly and are **forbidden in cloud-class env**.
Renaming touches `config.mjs` *and* every script; ADR-0001 pt 6 amended (§8.7).

### 6.5 Processor trust = pinned identity, not URL vibes (Codex v2 F8)
`restricted`/`personal` content may be embedded (`models.mjs:298`) / extracted (`:315`) / answered (`:361`) only by a **pinned, identity-verified** local processor — not "the URL looks local." Real risks: Consul returns a discovered URL (`config.mjs:113`), base URLs are env-overridable (`config.mjs:250`), and `CONSUL_SKIP_TLS_VERIFY` sets `NODE_TLS_REJECT_UNAUTHORIZED=0` **process-globally** (`config.mjs:103-110`). Policy:
- **Egress precedes insert (Codex v3 F3).** The check must run **before any outbound processor call**. Today `handleCaptureThought` embeds+extracts the raw content (`server.mjs:319-326`) *before* `captureThought` — a tier check inside the store is too late, the model already saw the text. Parse+validate the requested tier first; for `restricted`/`personal`, assert pinned processor identity **before** `createEmbedding`/`extractMetadata`; if trust can't be proven, fail before content leaves the handler. Same ordering for `ask_brain` evidence.
- Pin allowed processor **identities** (mTLS / signed service identity preferred), not hostnames.
- Validate resolved **IP/CIDR** at request time; reject tunnels/untrusted ranges.
- For private-tier calls, **fail closed** if global TLS verification is disabled unless the endpoint is loopback or an approved on-box socket. No cloud fallback.
- Tests: a restricted capture with an untrusted embedding/LLM endpoint performs **zero upstream requests**; explicit URL override; Consul-discovered remote address; `CONSUL_SKIP_TLS_VERIFY=true`.

### 6.6 Opaque errors + request-context redaction (Codex v1 F8, v3 F6)
`requestJson` (`models.mjs:284-286`) embeds upstream body/status/URL; `errorToolResult` (`server.mjs:194-210`) relays it; telemetry stores it (`observability.mjs:136`/`:200`). Throw an **opaque error id + structured category**; never put upstream body, URL, status, brain-slug, tier, query text, or evidence into the caller path *or* any agent-readable log/telemetry.

**Redaction keys off request/caller context, not only persisted row tier (Codex v3 F6).** Row-tier is too late and too narrow: a `local_trusted` query string is itself private even with zero or only-`standard` results; a restricted capture fails *before* the row (and its tier) exists; a processor error precedes tier persistence; a private-brain slug leaks existence before any content materializes. So: for **`local_trusted` requests**, default telemetry to **no** raw query preview, evidence snippet, brain slug, processor URL, or upstream error text; for **private brains** (known via the brain-level egress class, §6.13), redact even zero-result and failed requests; for **capture**, redact before insert; treat **tier-unknown as private**. Full diagnostics → operator-only sink outside repo + harness reach, with retention.

### 6.7 Layer C1 — `sensitivity_tier` is a security label (Codex v1 F1)
Remove `sensitivity_tier` from the generic metadata-patch surface (`server.mjs:87`; stop threading `sensitivityTier` through `patchThoughtMetadata` `thought-store.mjs:166`). Tier transitions go through a **separate local-trusted owner/publish capability with an audit row**. A **downgrade** (`restricted`/`personal`→`standard`) additionally requires local-trusted human confirmation. A cloud-bound writer may submit content; it may never lower a label. Raising a label is the fail-safe direction (but see §6.11 for who raised it).

### 6.8 Layer C2 — atomic tiering at capture, **conflict-aware** (Codex v1 F2, v3 F1)
Add `sensitivity_tier` to the capture API (`server.mjs:40`) and insert it atomically in `captureThought` (`thought-store.mjs:58-117`). Default `standard`; **unknown fails closed**; a local-only capture path may set `restricted` at creation. Closes the born-standard window.

**Capture is an upsert, so it is a mutation path (Codex v3 F1).** `captureThought` runs `on conflict (brain_id, dedupe_key) where deleted_at is null do update` (`thought-store.mjs:85`; live dedupe is partial-unique per `(brain_id, dedupe_key)`, `migrations/010:28`), overwriting content/embedding/metadata/type. A cloud-bound writer that cannot patch a `restricted` row by id can collide its `dedupe_key` and reach the update branch. **The conflict path must be tier-aware:** load/lock the existing row's **current** tier inside the same statement/transaction *before* updating; if it is `restricted`/`personal` and the caller is `cloud_bound`, **deny before any content/embedding/metadata/origin replacement** (this is §6.10's seam applied to the upsert, not a second mechanism).

**Preflight before processors, not just before the update (Codex v4 F3).** Because embed/extract run *before* the store call (`server.mjs:319-326`), the conflict-tier check must also run as a **preflight lookup by `(brain_id, dedupe_key)` before any outbound processor call** — the operation's effective tier is `effective_tier = max(requested_tier, existing_current_tier)` under fail-closed ordering. A `requested=standard` capture colliding an existing `restricted` row is a `restricted` operation *from the start*: a `cloud_bound` caller is denied **before** `createEmbedding`/`extractMetadata` (zero upstream requests, no timing/error oracle). Re-check the same condition atomically in the final upsert to close the TOCTOU window between preflight and write.

### 6.9 Layer B hygiene — reject `?key=` for `local_trusted` (Codex v1 F7)
`authKey` accepts `?key=` before headers (`auth.mjs:35`). Reject it for `local_trusted`; prefer deprecating `?key=` entirely (`Authorization: Bearer`); redact cred-shaped headers/params in logs while any compat path exists.

### 6.10 Layer C3 — no cloud mutation of an unreadable row (Codex v2 F2)
A read-clamp without a write-clamp leaves a cloud-bound editor able to patch metadata/type/status/enrichment of, or delete/restore/purge, a `restricted` row it cannot read — integrity compromise + an existence oracle via mutation responses. The mutation surfaces are: `/admin/thought/metadata` (`server.mjs:1060`, gates only brain WRITE); delete/restore/purge (`server.mjs:1104`/`:1121`/`:1141`, gate by action capability, not row tier); **and the capture upsert** (`thought-store.mjs:85`, §6.8). **Rule:** a cloud-bound caller may create new rows and mutate rows whose **current** tier is cloud-visible, but may **not** patch / delete / restore / purge / **upsert-over** / otherwise mutate an existing `restricted`/`personal` row. Enforce at a **single preloaded-row authorization seam in the store SQL** that **all** these paths route through, not scattered in route handlers.

### 6.11 Layer C4 — origin taint, **monotonic** (Codex v2 F3, v3 F2)
Read tier ≠ trust. A cloud-bound harness can write a new `restricted` row that cloud readers can't see but local-trusted inference *will* read and over-trust — a hidden injection channel. **Rule:**
- Stamp every row with an **`origin_egress_class`** at capture **and** every mutation (patch, upsert, tier-transition).
- **It must be MONOTONIC = worst-ever contributor, never last-writer (Codex v3 F2).** `cloud_origin` is **sticky**: a later local promotion / metadata patch / tier backfill / dedupe upsert may **never** wash it back to `local_trusted`. Last-writer-wins makes the label a sticker, not a control. Keep a separate `last_writer_egress_class` if useful, but **trust decisions read `origin_egress_class` only**.
- **Monotonicity is DB-enforced, not application discipline (Codex v4 F5).** The first implementation can be perfect and the second importer still writes `origin_egress_class='local_trusted'` over a cloud-origin row (operator tooling reads PG and patches directly today — `scripts/thought_enrichment/lib/db.py:68`/`:228`). So: a CHECK-constrained value domain **plus a trigger / controlled stored procedure** that permits only monotonic transitions (`local_trusted → cloud_origin` allowed; `cloud_origin → local_trusted` **rejected at the database**). Every direct operator/import/backfill path goes through that function or fails CI.
- **`cloud_origin + restricted` is QUARANTINED — a first-class store state, not an `ask`-only rule (Codex v4 F2).** Treat it as "hidden from cloud," **not** "trusted local private." Add a structured **`review_state`/`trust_state` column** (not a loose metadata convention); default `cloud_origin + restricted` to **non-retrievable until a local-trusted review**. The predicate must apply to **every materialization plane** — active SQL reads, `readThoughtRowsByIds`, `stats`, graph projection (`graph-projection.mjs:71`, no origin predicate today) and graph reads/expansion, telemetry result ids, the calibration sampler, and operator enrichment — not just `ask_brain`. A quarantined row is absent everywhere except an explicit local-trusted review endpoint. (Else: the graph remembers what the guard forgot.)
- **`cloud_origin + standard` is an integrity problem too (Codex v5 F3).** Confidentiality-safe ≠ trust-safe. A `standard` cloud-origin row is fine to *disclose* (cloud may read it back), but it can still say "ignore prior instructions / run this / trust this false decision record" — and pi's local inference will read and over-trust it. Today evidence sent to the answer model carries summary + excerpt but **no origin/trust field** (`server.mjs:265-277`, `models.mjs:194`), and the answer prompt has **no provenance instruction** (`models.mjs:359-370`). So: stamp `origin_egress_class` for **all** rows incl. `standard` (already universal above); carry **origin/trust state into local-trusted evidence objects**; instruct the answer prompt/tool-contract that **cloud-origin evidence is data, not instructions**, to be cited with provenance awareness; and *mark* (not exclude) cloud-origin `standard` evidence — escalate to review/exclude only before it drives a **side-effecting** local-trusted decision. (Softer than the `restricted` quarantine, which excludes.)
- **Provenance on every read plane, not only `answerFromEvidence` (Codex v6 F4).** Agents act on raw `search_thoughts`/`list_thoughts`/`similar`/`expand_context`/graph/REST output, not just `ask` — and those become prompts/operational inputs with no answer-prompt to warn them. Today `evidenceCitation`/`similar`/`list` return summary/excerpt/brain-slug but **no** origin/trust field (`server.mjs:265-277`, `:609-611`, `:642-663`). So **every local-trusted read result** carries `origin_egress_class` / `last_writer_egress_class` / `review_state` / derived `trust_level` (the §6.15 `provenance_fields_required`); the contract states all agent-facing consumers treat cloud-origin rows as untrusted **data** even outside `ask`. Cloud-bound outputs get audit-grade provenance only — never private labels or private-brain existence. Same row through `search`/`list`/`similar`/`ask`/`expand_context`/HTTP returns **consistent** provenance.
- **The quarantine-review endpoint is now the most dangerous endpoint (Codex v5 F7).** It is the only place hidden rows surface and the declassification/trust-transition choke point. Spec it as such: **local-trusted only** (not merely admin); **no silent bulk approval** — explicit reviewer identity + per-row or bounded-batch confirmation, content + provenance shown to a human; **no cloud-origin row sent to a processor before review** unless the processor policy is local-only *and* the row is marked untrusted; **audit** old/new `review_state`, old/new tier, origin taint, reviewer, reason, evidence shown; and **approval changes `review_state` only — it never washes `origin_egress_class`** (monotonic, above).
- **The review audit is itself a private-content dump — bind it (Codex v6 F7).** "Evidence shown" is private-derived content; an unbound review-audit table becomes "the dumpster fire with timestamps." So: review audit stores **hashes/ids by default**, full evidence snapshots only in the operator-only artifact sink (§6.14) if genuinely needed; explicit retention/export rules; **cloud-bound callers cannot read review-audit rows, counts, `old_state` blobs, or exported bundles**; redaction is tested for purge audit and review audit **together**.
- **Attribution + audit are prerequisites.** Today stored-key auth carries no key id/label/egress class (`auth.mjs:379-388`), the audit actor records only `auth_source`/`principal_id`/`is_admin` (`access-policy.mjs:104-109`), and `thought_audit.action` permits only `delete`/`restore`/`purge` (`migrations/012:52`) — capture and patch write no audit at all. So this requires: (a) key id/label + `egress_class` added to the caller context and `makeActor`; (b) the `thought_audit.action` CHECK extended to cover **tier transitions, taint transitions, and review-state transitions**, with capture/patch/review emitting audit rows for them.
- **Raising a label is fail-safe for the FUTURE only — track EXPOSURE HISTORY (Codex v7 F2).** "Raising is the fail-safe direction" (§6.7) protects future reads; it does **not** erase past egress. A row captured `standard`, read by Codex / logged in telemetry / projected into a cloud-reachable artifact, then raised to `restricted`, has already left — and local inference must not now treat it as *clean, never-exposed* private evidence. So add a **monotonic** `max_egress_reached` / `ever_cloud_materialized` (the confidentiality dual of monotonic origin taint), and treat `standard → restricted` as a **reclassification event**, not a quiet raise: it triggers derived-artifact scrub/reprojection, telemetry-retention handling, backup/export review, and possibly incident marking. Changing the source row does **not** auto-reclassify or purge its graph/log/audit/backup copies — those are separate edges (cf. §6.14/F3). Local-trusted retrieval distinguishes "restricted and never cloud-exposed" from "restricted now, previously cloud-exposed."
- **Writer-trust ≠ content-trust — add `source_trust_class` (Codex v7 F8).** `origin_egress_class` answers "which write path contributed?" — it catches a *cloud harness* poisoning. It does **not** catch adversarial content imported by a **local-trusted** writer: an IMAP/Telegram/document/web importer runs `local_trusted` but ingests attacker-controlled external text, which would otherwise look trusted-local ("the injection entered through the front office, not the clown hatch"). So carry a **separate `source_trust_class`** (`content_origin` / `adversarial_input_class`): external imports default **untrusted-for-instructions until reviewed**, regardless of writer egress. Provenance on results (below) carries **both** writer egress and content-source trust; `trust_level` in the §6.15 vector is the *min* of the two.
- **`side_effect_allowed` is a label, not a control unless the consumer obeys it — and OB1 can only do its half (Codex v7 F6).** OB1 cannot force a downstream agent/tool to honor a warning field (LLMs ignore warning labels). OB1's enforceable half: (1) return untrusted content in a **structurally separated field** (`untrusted_content`), never blended into instruction-like prose; (2) gate **OB1's own** side-effecting operations on the policy vector + a policy token / local human approval; (3) document the consumer contract (any side-effecting tool path must check policy metadata before acting) and add tool-call-chain regression tests. **Honest residual:** a third-party tool that ignores the marker and acts on cloud-origin/untrusted content is the *same accepted-residual class* as a human pasting private content into a cloud agent — OB1 marks and separates; it cannot compel an external consumer.

### 6.12 pi's local-trusted transport — concrete custody **+ caller-binding** (Codex v3 F4, v4 F1)
"Distinct principal" (§3) is only a DB row with better manners unless pi's credential has a real custody boundary. This is **not** same-user anti-theft magic (active key theft stays an accepted residual, §3) — it closes the *ordinary, non-malware* path:
- pi's `local_trusted` credential is held by a **local sidecar / session broker / OS-keychain-backed helper** (an operator-owned process), which injects `Authorization` into pi's MCP calls. It never lands in repo env, MCP client config, command args, tool-visible files, or `?key=` (§6.9).
- The **LLM-visible repo shell receives only `OB1_REPO_KEY`**, never pi's key.
- pi's bearer is **never** recorded in logs or telemetry.

**The sidecar must authenticate its caller, or it is a confused deputy (Codex v4 F1).** A broker that injects pi's bearer for *any* same-user process that reaches its socket/port/command is worse than a stolen key — Codex doesn't steal the bearer, it just *asks the broker*. File permissions are **insufficient** under same-user. So the sidecar's caller-binding contract:
- It requires an **unforgeable per-session capability** that is **not** present in the repo, shell env, command args, MCP config, or logs — i.e. one a cloud harness cannot obtain by ordinary means. In practice this is **human-gated**: a passphrase typed into pi's **hidden TTY** (the resurrected, correctly-scoped `ob1-unlock` mechanism — it guards the *transport's caller-binding*, not data crypto) or an explicit **local human approval** step for a new caller.
- The capability is **bound to pi's session/process/TTY**; a process launched from the repo cloud-agent shell, even with full localhost + filesystem reach, cannot present it.
- Active scraping of pi's session memory to lift the capability remains the **accepted Beria residual** (§3) — the contract defeats the *ordinary* confused-deputy path, not an omnipotent same-user adversary.

**Lease lifecycle, not a perpetual open door (Codex v5 F6).** A one-time unlock that leaves a long-lived bearer/session lease is a valet holding the door open: a misrouted client, stale process, copied socket path, or lingering approval rides it. So: **short TTL + idle timeout**; an explicit **lock/revoke** command; **per-caller and per-session binding**; **per-call human approval for high-risk operations** (private read, tier downgrade, quarantine approval, purge, export); and an **audit row for every sidecar-injected request** (caller-binding id, operation, target brain, target thought id, approval/lease id).
- Negative test: a process launched from the repo cloud-agent shell **cannot** call OB1 as pi even when it can reach the sidecar's localhost port and files; and a previously-approved pi session **expires, can be revoked, and cannot be reused** by a different repo shell, process session, TTY, or copied transport address.

### 6.13 Brain-level egress class — a machine-readable anchor (Codex v4 F4)
Request-context redaction (§6.6), processor policy (§6.5), projection eligibility, stats, and unscoped fanout all need to know a brain is private **before** any row is fetched — but "private" is a slug convention today: `brains.kind` is free-form `text not null` with no CHECK (`migrations/005:21`), and `fetchBrainCatalog` selects only `id/slug/household_id`, never `kind` (`auth.mjs:128`), while telemetry logs `brain_slug` unconditionally (`observability.mjs:127-133`). Add an **explicit, constrained brain-level class** — `brains.egress_class` (or constrained `brains.kind` values: `public` | `repo` | `private_local` | `quarantine_review`) — with a DB CHECK, **selected by `fetchBrainCatalog` and carried in the access context/catalog**. Drive from it: telemetry redaction (redact slug/id/preview for `private_local`/`quarantine_review` brains even on zero-result/failed requests), processor policy, graph-projection eligibility, stats aggregation, and unscoped-fanout decisions. This makes "which brain is private" a property of the data model, not operator memory; it also concretises the dormant `brains.kind` lever (§8.10) and the Layer-A catalog gap.

**It is an authorization input, not only a downstream hint (Codex v5 F2).** For Layer A to be idiot-proof under option (ii) (§5/§8.13), `egress_class` must participate in **scope derivation itself**: `deriveScope`/`fetchBrainCatalog` exclude `private_local`/`quarantine_review` brains from estate-membership and admin-home fanout. Without this, a redaction-only class still lets estate/admin reach materialize the brain before redaction runs. (This is a **v1** ADR change — `egress_class` is a new subtractive authorization input alongside brain-level DENY, §8.7.)

**Resolve the explicit-grant contradiction (Codex v7 F1).** Earlier wording said "reachable by an explicit brain grant," while §9 says private_local is unreachable to cloud-bound callers "regardless of any grant." The binding rule is the latter: **a cloud-bound caller CANNOT reach a `private_local`/`quarantine_review` brain by ANY path — explicit brain grant, estate grant, admin home-reach, selector, or fanout.** An explicit `brain_memberships` grant to such a brain is honored **only for a `local_trusted` caller**; for a cloud-bound caller the grant is inert. (Else an operator/migration/seed grant to a cloud principal silently re-opens the brain — the front-door bypass.)

**The maintenance capability is not a read API (Codex v7 F4).** Operator upkeep of `private_local` brains routes through **operation-specific** capabilities (`purge_by_id`, `reconcile_projection_state`, `run_backfill`, `repair_audit`, …), **not one "maintenance" bit**. Each requires an **explicit target selector** (no unscoped fanout/wildcard/graph traversal) and returns **ids/hashes/status only** — never content, excerpt, summary, `top_people`, graph neighborhood, counts, or `old_state` unless the operation is *also* a local-trusted review/read op. Every invocation is audited (operation, target, result class, sink). Otherwise "admin can maintain it" becomes "admin reads it with a fake mustache."

**Downgrading `egress_class` is a brain-level declassification — protect it like §6.7 (Codex v6 F6).** Flipping a brain `private_local → repo`/`public` exposes *every* row at once (scope derivation, telemetry redaction, graph eligibility, stats, fanout all change), even though no row's `sensitivity_tier` moved — "one column update becomes *publish brain*." So `egress_class` is itself a security label: **upgrades** (more restrictive) may be simple; **downgrades require the local-trusted owner capability + explicit human confirmation + full audit + an invariant scan of all rows/artifacts** (no `restricted` row or `cloud_agent_reachable` artifact may survive the downgrade); unknown/invalid class fails closed; direct SQL/import paths go through the controlled DB function or fail CI.

### 6.14 Private-derived artifact stores — a v1 requirement, not a later nicety (Codex v4 F6)
The whole design now *depends* on derived artifacts being outside cloud-harness reach, so retention/backup/log-shipping cannot stay deferred. Telemetry appends JSONL locally with query/result/error fields (`observability.mjs:161`); purge audit snapshots content + metadata (`thought-store.mjs:386`); `requestJson` throws upstream body/URL (`models.mjs:284`). Clean runtime responses don't help if a backup, log collector, diagnostic bundle, or purge-audit export carries the private-derived data and a cloud agent can read those files — or log shipping sends them to a cloud service. The boundary would move, not vanish. So, in v1: **define which artifact stores may hold private-derived data; place them outside repo + cloud-harness-readable paths; set per-store retention/redaction; and add a repo check/test** that telemetry, diagnostics, and audit exports for private requests never land under repo paths or agent-readable runtime artifact dirs.

**Sink reachability is DYNAMIC — same drift bug as access-graph state (Codex v7 F3).** `sink.cloud_agent_reachable` is not a write-time constant: at T1 graph projection is private and receives `restricted` previews; at T2 Neo4j creds land in an agent env, a graph REST route opens, a backup is exported into the repo, or a diagnostics bundle captures the graph. Write-time policy was correct; the sink became reachable afterward. So treat **sink class + reachability as security labels with a protected downgrade/relocation path** (symmetric with brain-egress-class downgrade, §6.13): any transition that makes a sink *more* cloud-reachable must **scan existing artifacts and refuse/purge/redact/reclassify before** it proceeds. Maintain a **registry of private-derived sinks** (owner, path/DSN, reader class, retention, backup/export policy, cloud-agent reachability), and run the **continuous invariant scan over artifact stores**, not only brains/rows.

### 6.15 The policy function — one decision point, every plane (Codex v5 F5, v6 F3/F5) — the spine
This is **not** an open decision; it is *the policy function*, and leaving it implicit guarantees five planes compute visibility five ways ("five locks and six keys"). Centralise it in **one SQL helper/view + one JS wrapper**; **every plane calls it or proves it materialises nothing** (content, ids, counts, paths, slugs, excerpts, embeddings, graph-derived data). But two corrections to the naive scalar version:

**(a) The output is a VECTOR, not a scalar — confidentiality and trust are different axes (Codex v6 F3).** A single `most_restrictive(...)` re-conflates the very thing §6.11 separates ("read tier ≠ trust"): `cloud_origin + standard` should *materialise* (it's cloud-safe) yet be *untrusted for side effects*; `cloud_origin + restricted + reviewed` may materialise for local-trusted callers yet stay cloud-origin for trust. So the helper returns:

```text
policy_decision = {
  can_materialize,              # confidentiality: may these bytes leave to this sink/caller?
  redaction_level,              # confidentiality: full / preview / ids-only / none
  processor_sink_allowed,       # confidentiality: may a processor (per §6.5) see it?
  trust_level,                  # integrity: trusted_local / cloud_origin / unreviewed
  side_effect_allowed,          # integrity: may it drive a side-effecting decision?
  provenance_fields_required,   # integrity: which origin/trust fields must accompany it
  audit_required,
}
```

**(b) The inputs include a SINK, not only a caller (Codex v6 F5).** Request handlers have a caller; **background materialisers do not** — graph projection scans Postgres and writes Neo4j with no request caller (`graph-projection.mjs:62`/`:71`; nodes carry `summary`+`content_preview`, `projection-planner.mjs:1232`/`:1241`). A caller-keyed policy would "allow" because the projector runs internal/local-trusted, then writes private previews into a store later reachable via a graph route, backup, or leaked Neo4j cred. The problem is the **sink's audience**, not the caller. So the inputs are:

```text
inputs = {
  brain.egress_class,        # §6.13 (also an authorization input, §5)
  row.sensitivity_tier,      # §4
  row.max_egress_reached,    # §6.11 exposure history (monotonic, v7 F2)
  row.review_state,          # §6.11 quarantine
  row.origin_egress_class,   # §6.11 monotonic WRITER taint
  row.source_trust_class,    # §6.11 CONTENT/source trust (v7 F8) — trust_level = min(writer, source)
  requested_operation,       # read / mutate / process
  caller.read_egress_class,  # §6.2 confidentiality (null for background jobs)
  caller.capabilities,       # §6.2 AUTHORITY — distinct from read_egress_class (v7 F7)
  sink = { type: graph_projection|telemetry|audit|backup|response|processor,
           egress_class, readers, retention, cloud_agent_reachable },  # §6.5/§6.14/§6.16 (reachability is dynamic, v7 F3)
}
```
`side_effect_allowed` in the output is OB1's *intent* signal; OB1 enforces it only for its own side-effecting ops and via the separated `untrusted_content` field (§6.11/v7 F6) — it cannot compel a downstream consumer.

Background jobs authorise against the **destination store and its reachable audience**, not an internal caller identity: a `restricted`/quarantined row may not be projected into a graph/log/audit store that is `cloud_agent_reachable`, even when the projector runs locally. **Unknown enum values fail closed** (most-restrictive). The graph-assisted `ask` path (§5, Codex v5 F4) calls the helper at *both* seed retrieval and by-id rehydration.

**Acceptance gate:** a test matrix proves the four cases are *distinct* on both axes — `cloud_origin+standard` (materialises, provenance required, not side-effect-trusted); `cloud_origin+restricted+unreviewed` (no materialise except review); `cloud_origin+restricted+reviewed` (local materialise, origin stays cloud-origin, side-effect trust bounded); `local_trusted+restricted` (local materialise + local processing, cloud denied) — and yields identical decisions across search, list, ask (incl. graph-assisted), stats, by-id, graph projection, graph expansion, telemetry, capture preflight, metadata patch, lifecycle mutation, and processor dispatch.

### 6.16 Datastore-side authorization — secret relocation is not enough (Codex v5 F8)
§6.1 moves service secrets out of cloud-harness reach, but that only closes the `.env` path. If Postgres / Neo4j / MinIO / Consul / source systems accept **ambient local access** — peer auth, `trust` auth, a shared superuser, or a broad operator credential — then a same-user cloud process bypasses every MCP-layer control with **no secret at all** (the local socket just says "come in"). API-layer egress policy is then below-the-line bypassable by ordinary tools. So:
- Runtime DB/graph/source credentials are **least-privilege**, never superuser/operator keys; sensitive-data access requires a **non-agent credential** the cloud harness does not hold.
- Local service auth (e.g. `pg_hba.conf`) must **not** grant ambient peer/`trust` access to private content from a clean same-user shell.
- Operator direct-PG paths use a **separate role**, outside cloud-harness env.
- If row-level security is not used, **document why API-only enforcement is acceptable** and exactly which local service-auth settings make direct access impossible from a clean agent shell.
- **Acceptance gate:** from a clean repo cloud-agent shell with no service env, direct `psql` / Neo4j / MinIO / Consul / source-system access to **private** content fails. If it succeeds because local auth is permissive, the model has already lost *below* MCP — and nothing in §5 matters.

---

## 7. What stays useful (anti-amputation)

- Cloud harnesses keep **full `standard`-tier read** across their accessible brains (repo brain + common-public).
- Cloud harnesses **write/capture freely** at `standard`, and may **raise** a label — only *serving*, *declassifying*, *mutating-restricted*, or *silently injecting cloud-origin content* is blocked. Cloud-origin `standard` content stays fully readable; it is just **marked untrusted to pi's answer path** (data, not instructions — §6.11) rather than excluded.
- **pi (the local-trusted principal)** retains the complete read surface with zero new friction.
- Capture stays agent-decided (ADR-0001 pt 7); tier is a column, settable atomically.

Cost is operator-borne, not capability-amputated. Usefulness is real but **operator-dependent, not self-enforcing**.

---

## 8. Open decisions

1. **`personal` tier** — map to `restricted`-equivalent at every clamp, or drop? No schema representation today.
2. **Row-flag vs two-brain** — *RESOLVED (owner, 2026-06-24): TWO-BRAIN* (`common-public` + `common-private`). Isolation lives in Layer A (membership-absence). Owner acknowledges the write-time cost (per-capture public/private filing, mixed-sensitivity thoughts split across stores, re-tiering = move-not-flag) and accepts it for the cleaner enforcement boundary.
3. **Graph plane** — "keep dead" sufficient for v1 **iff**: (1) legacy admin out of harness reach; (2) no cloud key is admin/`local_trusted`; (3) Neo4j creds unreachable from agent context; (4) graph stats/telemetry don't leak. Cross-brain entity traversal (§5) is tier-independent and remains even for admins.
4. **Count oracle** — *resolved, not an accepted residual* (Codex v7 F5): the invariant already forbids "derived data," and "no content ≠ no signal" (counts, `top_people`, source/type rollups leak existence + shape). So clamp **before aggregation** via the §6.15 helper: a cloud-bound caller gets **no per-brain row, no zero/nonzero distinction, no top-metadata rollup** for a private brain (in v1, Layer-A isolation already removes private brains from a cloud caller's `handleStats` (`server.mjs:690`/`brainStats` `thought-store.mjs:495`); the clamp is the belt to that suspenders, and is required for the shared-brain v2 case). Maintenance stats return only bounded status to an approved sink (§6.13). Adding one `restricted` row must not move any cloud-visible count.
5. **Error sanitization depth** — opaque ids + operator sink (§6.6).
6. **MinIO / Consul / ingest creds / log shipping / backup restore** — covered by §6.1 + table, or own treatment?
7. **ADR amendments to land this (§8.7):** (a) **ADR-0002** — a second, server-derived subtractive mechanism (Layer B) distinct from brain-level DENY; (b) **ADR-0003** — capability-per-key opened (migration + SELECT/context); (c) **ADR-0001 pt 5** — the trusted local agent (pi) is a **distinct principal**, not a shared repo principal; (d) **ADR-0001 pt 6** — two-keys-per-principal allowance + `OB1_REPO_KEY`/`OB1_OPERATOR_ACCESS_KEY` rename. Without (a)+(c), the design reduces to Layer A across distinct principals + Layer C only — which cannot veil a *shared* brain.
8. **Tier-transition capability shape (§6.7)** — dedicated endpoint vs future promote/publish; audit + downgrade-confirmation UX. The operator backfill (`backfill_sensitivity.py`) must move onto it.
9. **Origin-taint policy (§6.11)** — disallow cloud-origin `restricted` outright, or quarantine + local review? Default retrieval treatment (exclude vs mark)? Plus the enabling migration: `origin_egress_class` column (monotonic), key id/label + egress class in the caller context + `makeActor`, and the extended `thought_audit.action` CHECK for tier/taint transitions.
10. **`brains.kind` as a Layer-A pre-filter** — exists (`005:21`) but `fetchBrainCatalog` (`auth.mjs:120-143`) never selects it.
11. **pi's local-trusted transport (§6.12)** — sidecar vs session broker vs keychain helper? How is the transport addressed out of band so a cloud harness can't copy it from repo config? What is the human-gated caller-binding (hidden-TTY passphrase vs per-call approval)?
12. **Policy composition** — *shape resolved* (Codex v5 F5, v6 F3): one centralised helper returning a **confidentiality+integrity vector** keyed on inputs incl. a **sink** dimension (§6.15), fail-closed on unknowns. Remaining open: the exact enum domains, and whether a `public`/`repo` brain may even *hold* a `restricted` row or the model forbids it (the v1 trigger says it cannot, §9).
13. **Layer A isolation mechanism (§5)** — *RESOLVED at freeze (§17.1)*: option (ii), `brains.egress_class` as an authorization input (idiot-proof-by-construction), a v1 ADR change. (Option (i), separate-estate, rejected as operationally fragile.)
14. **v1 shared-restricted invariant (§9, Codex v5 F1)** — confirm the chosen guarantee: v1 *structurally forbids* `restricted`/`personal` rows in any cloud-accessible/shared brain (so the row clamp can be v2), vs pulling Layer B forward into v1.

---

## 9. Phasing

- **v0 (blocking, structural):** §6.1 secrets **out of the repo** + autoload **removed everywhere** + repo-wide tripwire test **covering docs/READMEs**; §6.3 legacy admin denied/forced `cloud_bound`; §6.7 remove `sensitivity_tier` from the generic patch route (declassification is a *live* bug, Layer-B-independent).
- **v1 — and the phasing invariant that makes it safe (Codex v5 F1, v6 F1/F2):**
  - **A minimal caller trust class is a v1 prerequisite (v6 F2), even though the row clamp is v2.** v1 carries `caller.read_egress_class` (`local_trusted` | `cloud_bound`, default `cloud_bound`) for *all* caller shapes — the v1 rule is "only pi's principal/transport is `local_trusted`." Every v1 decision about a `private_local` brain (name/list/search/mutate/review/project/maintain) reads this explicit class, never `isAdmin`/slug/route shape (§6.2).
  - **The no-shared-restricted invariant is access-*graph* state, not a `thoughts` column (v6 F1).** "Cloud-accessible" derives from memberships + estate + admin reach + `egress_class`, so a row-level CHECK alone is insufficient — a brain can become cloud-accessible *after* the rows exist. Decompose into enforced edges: (1) a `thoughts→brains` **trigger**: a `restricted`/`personal` row may exist **only** in a `private_local`/`quarantine_review` brain; (2) `egress_class` as a **hard authorization input** (§6.13) so `private_local` is unreachable to cloud-bound callers *regardless of* any brain/estate/admin grant — adding a grant doesn't expose it; (3) **protected brain-class downgrade** (§6.13/v6 F6) closes the only remaining edge that could flip reachability; (4) a **continuous invariant scan** (CI + deploy + startup, not a one-time test) that fails if the access graph ever places a `restricted` row in a cloud-reachable brain. Restricted content in v1 thus lives **only in `private_local` brains isolated by Layer A**; a shared common brain holds only `standard` rows until Layer B lands. *Shipping a shared brain with a restricted slice while the row clamp is v2 is a time-delayed leak.*
  - Plus: pi = local-trusted principal + §6.12 transport custody/caller-binding/lease; §6.15 **the policy helper returning a confidentiality+integrity *vector* with a sink dimension** (every plane and background materialiser routes through it); §6.8 atomic capture tier + conflict-aware upsert + processor preflight; §4 DB CHECK/enum + fail-closed; §6.10 single no-mutate-restricted seam (patch/lifecycle/**upsert**); §6.11 DB-enforced monotonic taint + attribution/audit migration + quarantine across **every** plane + **provenance on every read plane** (not just `ask`) + cloud-origin-standard untrusted-marking + review endpoint **with bound audit**; §6.5 pinned processor identity before embed/extract; §6.6 opaque errors + request-context redaction; §6.14 private-derived artifact stores outside repo/harness reach; §6.16 datastore-side least-privilege/no-ambient-auth; §6.9 reject `?key=`; §6.4 key-naming inventory. Graph admin-only-and-dead under §8.3.
  - **v7 additions (contract enforceability):** `egress_class`-as-authorization is a **v1** ADR change (§8.7) — cloud-bound callers cannot reach `private_local` by *any* grant, explicit grants honored only for `local_trusted` (§6.13/F1); maintenance is **operation-specific, ids/status-only** (§6.13/F4); **exposure history** `max_egress_reached` + `standard→restricted` as a reclassification event (§6.11/F2); **`source_trust_class`** distinct from writer taint (§6.11/F8); **authority split** — `local_trusted` read ≠ approve/downgrade/purge/export (§6.2/F7); **sink registry + dynamic-reachability protection** (§6.14/F3); **count-oracle clamp** before aggregation (§8.4/F5); `untrusted_content` field + OB1-only side-effect gating (§6.11/F6).
- **v2 (needs ADR amendments §8.7):** §6.2 `read_egress_class` for all caller shapes + the **shared-common-brain row clamp** (this is what *lifts* the v1 no-shared-restricted invariant). Active-path tier predicates on `match_thoughts`/`list_recent_thoughts`/`stats`/`readThoughtRowsByIds` **and the graph-assisted `ask` rehydration**, **based on migration 015**, on MCP **and** HTTP dispatch, all routed through the §6.15 helper. §6.7 tier-transition capability + audit + downgrade confirmation; backfill migrated onto it. Graph per-node `brain_id` + tier namespacing if §8.3 fails.

---

## 10. Codex review v1 — disposition (all accepted; F9 refined)

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | CRIT | Cloud writers declassify via metadata patch | §6.7 (Layer C1); v0 |
| 2 | CRIT | Capture can't tier atomically | §6.8 (Layer C2); v1 |
| 3 | CRIT | Env split bypassed by `config.mjs` autoload | §6.1; v0 |
| 4 | HIGH | Layer A overclaims; graph not covered | §5 scope corrected to PG brain-scoped planes |
| 5 | HIGH | `read_egress_class` only on stored keys | §6.2 all caller shapes |
| 6 | MED/HI | Cites mig 011; 015 is live | plane table → 015 (match_thoughts, recency) |
| 7 | MED | `?key=` accepted | §6.9 |
| 8 | MED | "Log full error server-side" leaks | §6.6 |
| 9 | MED | Tier values unconstrained text | §4: API enums; add DB CHECK + fail-closed |

## 11. Codex review v2 — disposition (all accepted)

| # | Sev | Finding | Verified | Disposition |
|---|---|---|---|---|
| 1 | HIGH | Two keys/one principal ≠ separation; Layer A is a principal boundary | `005:59` (PK principal,brain), `005:83-95` ✓ | **Architectural fix** → §3 boundary taxonomy; pi = distinct local-trusted principal (§8.7c); Layer B is for the shared brain only |
| 2 | HIGH | Tier protection must cover **all** existing-row mutations, not just downgrade | `server.mjs:1060`/`1104`/`1121`/`1141`; `thought-store.mjs:146` ✓ | §6.10 (Layer C3): no cloud mutate/delete/restore/purge of a `restricted` row; single store seam |
| 3 | HIGH | Cloud-origin `restricted` writes = hidden injection into local context | design ✓ | §6.11 (Layer C4): `origin_egress_class` taint; disallow/quarantine; retrieval exclude/mark |
| 4 | MED/HI | 015 also redefines `list_recent_thoughts` | `015:278`/`:304` ✓ | plane table cite → 015 for all three active fns |
| 5 | MED/HI | Tier-mutation scripts missing from inventory | `thought_enrichment/lib/db.py:68`/`:228`, `backfill_sensitivity.py:16`/`:44` (per Codex) | plane table operator-backfill row; route onto §6.7 endpoint; operator-only; §8.8 |
| 6 | MED | Startup guard is hygiene, not a boundary | `eval-...:31`, `smoke-...:9`, `devenv.nix:4`/`75` (per Codex) | §6.1 reframed structural; tripwire test |
| 7 | MED | `OB1_REPO_KEY` rename not just ADR text | `telegram_bridge.py:77`, `import-*.py`, smoke/eval (per Codex) | §6.4 credential-var inventory; client/operator/server split |
| 8 | MED | Processor trust needs identity/pinning | `config.mjs:103-110` (global TLS off), `:113`, `:250` ✓ | §6.5 pinned identity / IP-CIDR / mTLS / fail-closed-on-global-TLS-off |

**v2 acceptance tests adopted** (on top of v1's): (1) a cloud-bound key sharing a principal with a local-trusted key cannot read private-brain rows via principal membership — Layer B clamps or a distinct local principal is used; (2) cloud-bound writer cannot patch metadata/status/type/source/enriched on an existing `restricted` row even with editor role; (3) cloud-bound owner/admin cannot delete/restore/purge an existing `restricted` row; (4) cloud-origin `restricted` captures are rejected/quarantined/stamped-and-excluded in local retrieval; (5) `list_thoughts` preserves 015 record-exclusion after the tier migration; (6) the backfill tool uses the local-trusted tier endpoint, not the generic patch route; (7) repo-wide test fails on new cloud/client scripts sourcing `.env.open-brain-local` or depending on PG/Neo4j/Consul/source creds; (8) repo client tooling accepts `OB1_REPO_KEY`, operator tooling an operator key, neither falling back to legacy admin in cloud-class mode; (9) private-tier model/embedding calls fail closed for untrusted Consul results, explicit remote URL overrides, and TLS-disabled paths.

## 12. Codex review v3 — disposition (all accepted)

All six are implementation-trap refinements of Rev 3; no rebuttals. Verified the load-bearing code.

| # | Sev | Finding | Verified | Disposition |
|---|---|---|---|---|
| 1 | HIGH | Capture upsert is an existing-row mutation path | `server.mjs:310-326` (authz→embed→upsert); `thought-store.mjs:85` `do update`; `010:28` partial-unique ✓ | §6.8 conflict-aware + §6.10 seam covers the upsert + §3/plane-table |
| 2 | HIGH | Origin taint must be monotonic, not last-writer | `auth.mjs:379-388` (no key/egress in ctx); `access-policy.mjs:104-109` actor; `012:52` audit verbs = delete/restore/purge only ✓ | §6.11 monotonic worst-ever + attribution + audit-CHECK extension |
| 3 | HIGH | Private capture must verify processor trust **before** embed/extract | `server.mjs:319-326` embeds/extracts before insert; `:40` no tier input ✓ | §6.5 egress-precedes-insert + zero-upstream-request test |
| 4 | MED/HI | pi principal needs concrete credential custody | design ✓ | §6.12 local sidecar/broker; repo shell holds only `OB1_REPO_KEY`; no repo-config transport selection |
| 5 | MED | Operator-only docs/scripts still expose `.env`/secret patterns | `email-history-import/README.md:78`, `eval-graph-retrieval.py:95`, `telegram README:39`, `dictation README:35`, `shared_docling.py:33` (per Codex) | §6.1 tripwire extended to docs/READMEs; split operator vs client recipes |
| 6 | MED | Telemetry redaction must key off request/caller context | `observability.mjs:128-133`/`:136`/`:200` ✓ | §6.6 redaction by `local_trusted`/private-brain/tier-unknown, incl. zero-result + failed + pre-insert |

**v3 acceptance tests adopted:** (1) cloud-bound capture with a `dedupe_key` colliding an existing `restricted` row is denied, leaving content/metadata/embedding/tier unchanged; (2) cloud-origin taint survives local metadata patch, local tier promotion, operator backfill, and dedupe upsert; (3) a restricted capture with an untrusted embedding/metadata endpoint performs no upstream request; (4) a clean repo agent shell cannot obtain or invoke the pi local-trusted principal via env, MCP config, repo scripts, or `?key=`; (5) repo checks fail cloud/client docs or scripts that source `.env.open-brain-local` or mix `MCP_ACCESS_KEY` with source/storage creds; (6) `local_trusted` zero-result searches, failed captures, and private-brain errors write no raw query text, brain slug, upstream URL, or upstream body to agent-readable telemetry/logs.

## 13. Codex review v4 — disposition (all accepted)

All six are enforcement-seam refinements of Rev 4; no rebuttals. F1 circles back to the same-user core and re-justifies a human-gated unlock (correctly scoped to the sidecar's caller-binding, not data crypto).

| # | Sev | Finding | Verified | Disposition |
|---|---|---|---|---|
| 1 | HIGH | pi sidecar = confused deputy unless it authenticates the caller | design ✓ | §6.12 caller-binding contract: unforgeable per-session capability, human-gated (hidden-TTY/approval), bound to pi's session; file perms insufficient |
| 2 | HIGH | Quarantine must cover **every** materialization plane, not `ask` only | `graph-projection.mjs:71`, `projection-planner.mjs:1232`, `thought-store.mjs:495`/`:435` ✓ | §6.11 first-class `review_state`/`trust_state` store predicate across SQL reads/by-id/stats/graph/projection/telemetry/calibration/enrichment |
| 3 | MED/HI | Capture must **preflight** by `(brain_id,dedupe_key)` before processors | `server.mjs:310`/`319-326`; `thought-store.mjs:85` ✓ | §6.8 preflight; `effective_tier = max(requested, existing)`; deny before embed/extract; atomic re-check for TOCTOU |
| 4 | MED/HI | Request-context redaction needs a **brain-level egress class** | `005:21` (free-form `kind`), `auth.mjs:128` (catalog omits kind), `observability.mjs:127-133` ✓ | §6.13 constrained `brains.egress_class`, selected by `fetchBrainCatalog`, carried in context; drives redaction/processor/projection/stats/fanout |
| 5 | MED | Monotonic taint needs **DB enforcement**, not app discipline | `db.py:68`/`:228` direct PG/patch (per Codex) | §6.11 DB CHECK + trigger/stored-proc rejecting `cloud_origin → local_trusted`; all operator paths via it or fail CI |
| 6 | MED | Retention/backup/log-shipping is a hole, not a later nicety | `observability.mjs:161`, `thought-store.mjs:386`, `models.mjs:284` ✓ | §6.14 promoted to **v1**: private-derived artifact stores outside repo/harness reach + repo check |

**v4 acceptance tests adopted:** (1) a repo-launched same-user process cannot invoke the pi sidecar as pi without the pi-bound out-of-band capability; (2) a `cloud_origin + restricted` quarantined row is absent from search/list/ask/stats/graph-projection/graph-expansion/calibration-export/operator-enrichment unless an explicit local-trusted review endpoint is used; (3) capture preflight denies a requested-`standard` dedupe collision against an existing `restricted` row before any embedding/extraction; (4) private-brain zero-result and failed requests redact slug/id/preview/URL/body using the real brain egress class; (5) the database rejects `origin_egress_class` laundering from cloud-origin to local-trusted, incl. direct SQL/import/backfill; (6) private-derived telemetry/diagnostics/purge-audit/backup artifacts are not written to repo paths or cloud-agent-readable dirs.

## 14. Codex review v5 — disposition (all accepted)

No architectural reversal; the findings tightened phasing, scope-derivation, and the policy spine. The two non-negotiables — the v1 shared-restricted leak (F1) and the single policy function (F5) — reshaped §9 and added §6.15.

| # | Sev | Finding | Verified | Disposition |
|---|---|---|---|---|
| 1 | HIGH | v1 ships the invariant before the v2 read clamp | doc phasing ✓ | §9 v1 **structurally forbids `restricted` rows in any cloud-accessible/shared brain** (DB constraint/provisioning test); Layer B clamp lifts it in v2; §8.14 |
| 2 | HIGH | "No `scope_isolated`" vs estate/admin reach | `access-policy.mjs:283`/`:286`/`:410`; `auth.mjs:121` ✓ | §5 + §6.13: `brains.egress_class` is an **authorization input** excluding `private_local` from estate/admin fanout + named non-fanout maintenance; §2 honest reconciliation; §8.13 |
| 3 | HIGH | `cloud_origin + standard` can still poison local inference | `server.mjs:265-277`, `models.mjs:194`/`:359-370` (no origin/trust field) ✓ | §6.11: stamp origin for all rows; evidence + answer prompt carry trust; cloud-origin marked data-not-instructions (mark, not exclude) |
| 4 | MED/HI | Graph-assisted `ask` bypasses SQL-only clamp | `retrieval.mjs:898`/`:906`; `thought-store.mjs:457-461` (no tier/origin predicate) ✓ | §5 `ask` row + §6.15: graph-assisted ask is its own plane; policy threaded into seed **and** by-id rehydration |
| 5 | MED/HI | Effective egress composition can't stay open | design ✓ | **§6.15 the spine**: one most-restrictive/fail-closed policy fn, centralised SQL helper + JS wrapper, every plane routes through it; §8.12 rule resolved |
| 6 | MED | Sidecar unlock lacks lease/revocation/audit | design ✓ | §6.12 lease model: TTL/idle/revoke/per-session binding/per-call approval for high-risk/audit |
| 7 | MED | Quarantine review endpoint is the dangerous endpoint | design ✓ | §6.11: local-trusted only, no silent bulk, full audit, approval never washes origin taint |
| 8 | MED | Direct datastore access needs RBAC, not just secret relocation | design ✓ | §6.16: least-privilege runtime role, no ambient/peer/trust auth for private content, RLS-or-document |

**v5 acceptance tests adopted:** (1) shared-brain `restricted` row is unreadable by a cloud-bound member via search/list/similar/ask/stats/by-id/**graph-assisted ask**/graph-expansion/telemetry-ids/HTTP REST; (2) a cloud-bound principal with estate membership or stored-admin home reach cannot reach `private_local` brains via unscoped fanout or explicit selector without the dedicated audited maintenance capability; (3) cloud-origin `standard` evidence is marked untrusted in local-trusted answers and cannot inject operational instructions; (4) graph-added restricted/quarantined neighbors are excluded before evidence selection, answer generation, and telemetry; (5) an effective-policy matrix with disagreeing brain class / row tier / origin taint / review state yields identical allow/deny across every materialization and mutation plane; (6) sidecar leases expire, can be revoked, are caller/session-bound, and are audited per injected request; (7) quarantine-review approval is local-trusted-only, audited, non-washing for origin, and cannot silently bulk-approve; (8) a clean cloud-agent shell cannot read private content from Postgres/Neo4j/MinIO/Consul/source systems without the MCP API.

## 15. Codex review v6 — disposition (all accepted)

No architectural reversal — conceptual-shape refinements. F3 corrected a conflation *this doc introduced* (a scalar policy after saying "tier ≠ trust"); F1 decomposed the invariant into enforceable edges; F5 added the sink dimension for caller-less background jobs.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | HIGH | No-shared-restricted is access-*graph* state, not a row constraint | §9 v1: decomposed into enforced edges (thoughts→brains trigger + egress_class authorization + protected brain-class downgrade + continuous CI/deploy/startup scan) |
| 2 | HIGH | v1 needs a caller trust class even though the row clamp is v2 | §6.2 + §9: minimal `caller.read_egress_class` is a **v1** prerequisite; the shared-brain row clamp stays v2 |
| 3 | HIGH | One scalar `effective_egress` conflates confidentiality with trust | §6.15: output is a **vector** `{can_materialize, redaction_level, processor_sink_allowed, trust_level, side_effect_allowed, provenance_fields_required, audit_required}` |
| 4 | MED/HI | Provenance only specified for `answerFromEvidence` | §6.11: origin/trust/`review_state`/`trust_level` on **every** local-trusted read result (search/list/similar/expand/graph/REST), consistent across planes |
| 5 | MED/HI | Background materializers need a sink/audience, not a caller | §6.15: policy inputs include a **`sink`** dimension; projection/telemetry/audit/backup/processor authorize against destination audience, not internal caller |
| 6 | MED | `brains.egress_class` downgrade is unprotected declassification | §6.13: downgrade needs local-trusted owner capability + human confirm + full audit + all-rows/artifacts invariant scan; fail-closed; controlled DB function |
| 7 | MED | Review audit becomes the new private-content dump | §6.11: review audit stores hashes/ids by default, full evidence only to operator sink; cloud-bound cannot read it; redaction tested with purge audit |

**v6 acceptance tests adopted:** (1) after `restricted` rows exist, adding a cloud-bound brain/estate grant, admin-home-reach path, or brain-class downgrade fails or leaves rows unreadable cloud-side; (2) v1 decisions for `private_local`/review/sidecar/maintenance use an explicit caller trust field, default `cloud_bound`; (3) confidentiality and trust are *distinct* outputs for cloud-origin-standard / cloud-origin-restricted-unreviewed / cloud-origin-restricted-reviewed / local-trusted-restricted; (4) cloud-origin `standard` rows carry trust/provenance markers through search/list/similar/ask/expand_context/graph-assisted-ask/HTTP; (5) graph projection/telemetry/audit/diagnostics/backups/processor dispatch each pass an explicit sink/audience class into the policy; (6) `private_local → repo`/`public` fails without the protected transition + audit + invariant scan; (7) quarantine approval writes no raw private evidence into cloud-agent-readable audit rows/files/exports/telemetry.

## 16. Codex review v7 — disposition (accepted; F6 scoped to OB1's enforceable half)

Contract gaps, not architecture. F1/F7 corrected conflations this doc introduced; F2/F8 add genuinely-missing dimensions; F6 is bounded by an honest residual (OB1 cannot compel a downstream consumer).

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | HIGH | `private_local` explicit-grant semantics contradict themselves | §6.13: binding rule = cloud-bound cannot reach private_local by ANY grant; explicit grant honored only for `local_trusted`; egress_class-authz is a v1 ADR change |
| 2 | HIGH | `standard→restricted` needs exposure history, not just a label | §6.11: monotonic `max_egress_reached`; the transition is a reclassification event (artifact scrub/reproject/mark); distinguish never-exposed from previously-exposed |
| 3 | MED/HI | Sink reachability is dynamic too | §6.14: sink class/reachability are protected labels; pre-transition artifact scan; sink registry; continuous artifact-store scan |
| 4 | MED/HI | Maintenance capability can become a read bypass | §6.13: operation-specific capabilities, explicit selectors, ids/status-only returns, full audit |
| 5 | MED/HI | Count oracle still open | §8.4: *resolved* — not a residual; clamp before aggregation via §6.15; no per-brain row / presence / rollups for cloud-bound on private brains |
| 6 | MED | `side_effect_allowed` is a label, not a control | §6.11: OB1's half — `untrusted_content` separated field + gate OB1's own side-effects + consumer contract/tests; **honest residual**: cannot compel an external tool |
| 7 | MED | `local_trusted` ≠ reviewer authority | §6.2: split `read_egress_class` (confidentiality) from `capabilities`/`approval_presence`/`human_confirmation_id` (authority); read is necessary-not-sufficient for approve/downgrade/purge/export |
| 8 | MED | `origin_egress_class` tracks writer, not content adversariality | §6.11: separate `source_trust_class`; external imports default untrusted-for-instructions; `trust_level = min(writer, source)` |

**v7 acceptance tests adopted:** (1) a cloud-bound principal with an explicit `brain_memberships` grant to a `private_local` brain still cannot name/read/stat/graph/mutate it outside the scoped maintenance path; (2) a row read/projected/logged while `standard` then raised to `restricted` records prior exposure and scrubs/marks derived artifacts; (3) making a graph/log/audit/backup sink cloud-agent-readable fails while restricted artifacts exist in it; (4) maintenance can repair a specific target but cannot return content/rollups/graph context/`old_state`/private counts; (5) adding one restricted row does not move any cloud-visible count/`top_people`/rollup/graph-stat/telemetry-count/maintenance summary; (6) a downstream side-effecting tool refuses an action derived from `side_effect_allowed=false` evidence; (7) a local-trusted read session cannot review/downgrade/publish/export/purge without operation-specific capability + human confirmation; (8) a locally-imported external email/web/chat row is readable per its tier but marked untrusted-for-instructions even though the importer was local-trusted.

## 17. Freeze (Codex v8) — baseline closed, implementation gates open

Codex v8 verdict: the boundary is named correctly; **freeze Rev 8 as the design baseline, not as "secure."** No ninth prose loop unless implementation discovers a contradiction that changes the boundary. What "freeze" requires:

### 17.1 Resolved for v1 (no longer "open" — §8 entries reconciled here)
- **Layer A mechanism = `brains.egress_class` as an authorization input** (not the separate-estate option). It is a **v1** ADR change — a new subtractive authorization input alongside brain-level DENY (§5/§6.13/§8.13).
- **No `restricted`/`personal` rows outside `private_local`/`quarantine_review` brains** — enforced by the `thoughts→brains` trigger + continuous scan (§9). A shared/cloud-accessible brain holds only `standard` until Layer B (v2).
- **Graph stays dead-to-cloud for v1** behind an explicit, testable kill-switch (§17.3 / Codex v8 F6), not a vibe. Partitioning is pulled into v1 only if graph is enabled for cloud-bound callers.
- **`caller.read_egress_class` (confidentiality) is a v1 prerequisite**, split from `capabilities` (authority) (§6.2).

### 17.2 Still owner-discretion (record the pick before coding — Codex v8 F1)
- **Representation: ~~row-flag vs~~ two-brain** (§8.2) — **RESOLVED (owner, 2026-06-24): two-brain** (`common-public` / `common-private`). Isolation via Layer A membership-absence; the row-level clamp (Layer B) is needed only if a single brain ever holds mixed tiers.
- **`personal` tier: map to `restricted`-equivalent, or drop** (§8.1). Recommended: **drop for v1** (no schema representation today; `restricted` covers the need) — re-add later if a distinct "human-only" semantic is wanted.
- **pi transport mechanism: sidecar vs session-broker vs keychain-helper** (§8.11). Implementation detail of §6.12; the *contract* (caller-binding + lease + per-op approval) is frozen; the mechanism can be chosen at build time.

### 17.3 Implementation gates (the executable plan — Codex v8 F2–F7)
These are *not* prose to refine; they are the contracts the implementation doc + test matrix must pin:
1. **Capability grammar (F3)** — an exact vocabulary (`read_private`, `review_quarantine`, `downgrade_tier`, `downgrade_brain_egress`, `export_private`, `purge_private`, `repair_audit`, `reconcile_projection_state`, `run_backfill`, …), a caller-class × capability matrix, which capabilities require human-confirmation/TTL/target-binding/audit/approved-sink, and a route/action matrix for **MCP and HTTP**. No route improvises.
2. **Exposure-event taxonomy (F2)** — define exactly what increments `max_egress_reached`: response materialization, processor dispatch, telemetry/log write, graph projection, audit snapshot, backup/export, diagnostics, calibration export, maintenance output, HTTP/MCP parity. Which events update the row vs an artifact registry vs only incident/audit state. **Existing artifacts backfill as `unknown`/`possibly_exposed`, never `never_exposed`.**
3. **Migration staging (F4)** — pessimistic: add nullable columns → backfill **`unknown`/`untrusted`/`possibly_exposed`** (never silently trusted) → dual-write → invariant scans → enable CHECKs/triggers → enforce policy. Fail-closed on unknown enums, with operator visibility so "fail-closed" never becomes "comment out the guard."
4. **Policy helper is pre-materialization (F5)** — define per-plane insertion points: SQL/by-id predicates apply **before** rank/threshold/limit/aggregation/graph-expansion/telemetry/answer; processor dispatch + capture-preflight call policy **before any outbound request**; background materializers call policy **before** writing a sink. Denied rows are **absent**, not redacted-after.
5. **Graph v1 kill-switch (F6)** — a single documented+tested deployment posture: no cloud-held graph-admin key; legacy admin unreachable from harnesses; Neo4j creds not in repo/env/tool output; graph REST materializes no private data; projection writes no private/restricted previews to a cloud-reachable sink.
6. **ADR patches (F7)** — patch ADR-0001 (pt 5 distinct local principal; pt 6 key-name split), ADR-0002 (second subtractive mechanism: `egress_class` authorization), ADR-0003 (capability-per-key) **before/with the first implementation PR**, so a reader derives this model from ADRs + `CONTEXT.md` alone. PRs contradicting the patched ADRs are rejected.
7. **Test matrix** — the ~30 acceptance gates accumulated in §10–§16 become an executable matrix, starting with the four §6.15 policy quadrants.

### 17.4 First implementation slice (Codex v8, in order)
1. ADR patches (principal boundary, subtractive egress auth, capability-per-key).
2. Schema migration skeleton — fail-closed enum domains + pessimistic backfill.
3. Central policy helper + JS wrapper — unit tests for the four §6.15 quadrants.
4. v1 graph posture — explicitly disabled to cloud-bound callers, with negative tests.
5. Route/action capability matrix (MCP + HTTP) — *before* any route patches.

Then route enforcement, in that order.
