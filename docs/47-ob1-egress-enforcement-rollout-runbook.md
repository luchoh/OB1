# 47 — Egress Enforcement Rollout Runbook

**Status:** operational runbook for the docs/45 cloud-egress boundary.
**Audience:** the OB1 operator (luchoh). Run every step on `ob1_dev` first, then `ob1`.
**Design:** [docs/45 Rev 8 (FROZEN)](45-ob1-common-brain-access-proposal.md). Implementation: migrations 016/017/018 + the access-policy / auth / capture changes (commits `7e02066`…`074f79d` on `develop`).

> **The one rule that prevents a lockout:** `OB1_EGRESS_ENFORCE=enforce` strips
> every `private_local` / `quarantine_review` brain from a `cloud_bound` caller's
> scope. Migration 016 pessimistically set **every** brain to `private_local`, and
> every key defaults to `cloud_bound`. So flipping `enforce` **before** Phases A–C
> below makes every caller lose access to every brain. Do the phases in order.

---

## 0. The staged model

`OB1_EGRESS_ENFORCE` ∈ `off | observe | enforce`, **default `observe`**.

| mode | reads | writes | use |
|---|---|---|---|
| `off` | byte-identical to pre-egress | write-guards still active¹ | not recommended (disables read confinement entirely) |
| `observe` *(default)* | **no behaviour change** — but logs `egress.read_excluded` (slugs only) for every read a `cloud_bound` caller makes into a local-only brain | write-guards active | the staging phase; safe everywhere |
| `enforce` | a `cloud_bound` caller cannot read/name/fan-out a `private_local`/`quarantine_review` brain (search / list / stats / ask_brain / expand_context / explicit selector / default brain) | write-guards active | the target state, **after** Phases A–C |

¹ The Layer-C write-guards (no cloud declassify / mutate / upsert-over a `restricted` row; restricted-into-non-private-brain refused; §6.5 processor-locality; the brain-downgrade and monotonic-taint triggers) are **always-on**, independent of `OB1_EGRESS_ENFORCE`. Only the *read* confinement is staged.

**Rollback is instant and data-free:** set `OB1_EGRESS_ENFORCE=observe` (or `off`) and restart the service. No migration is reverted; nothing is rewritten.

---

## 1. Preconditions

1. Code on the target host is at `develop` ≥ `074f79d` (the egress boundary).
2. Migrations applied to the target DB (idempotent; tracked in `open_brain_schema_migrations`):
   ```bash
   PGDATABASE=ob1_dev ./scripts/apply-open-brain-local-migrations.sh   # dev first
   # then, deliberately, on prod:
   PGDATABASE=ob1     ./scripts/apply-open-brain-local-migrations.sh
   ```
   Confirm `016`, `017`, `018` are present:
   ```sql
   select name from open_brain_schema_migrations where name like '01[678]%' order by name;
   ```
3. `OB1_EGRESS_ENFORCE` is unset or `observe` (the default) while you provision.

All SQL below assumes you are connected to the **intended** database — always
`select current_database();` first. Never run Phase A/B on `ob1` until it has
passed on `ob1_dev`.

---

## 2. egress_class — the brain classification you are about to set

| `brains.egress_class` | meaning | cloud_bound caller may read? | may hold `restricted` rows? |
|---|---|---|---|
| `public` | world/cloud-safe | yes | **no** (018 guard) |
| `repo` | cloud-readable repo/common brain | yes | **no** (018 guard) |
| `private_local` *(016 default)* | local-on-box only | **no** (under enforce) | yes |
| `quarantine_review` | local, holds cloud-origin content pending review | **no** | yes |

The migration set **everything** to `private_local`. Phase A is where you open the
brains that cloud agents are *supposed* to read.

---

## 3. Phase A — classify brains

For each brain a cloud coding agent legitimately reads (its own repo brain, the
common/shared brain), set `egress_class` to `repo` (or `public`). Leave a brain
`private_local` only if no cloud agent should ever read it.

```sql
-- inspect current state
select slug, kind, egress_class,
       (select count(*) from thoughts t where t.brain_id = b.id and t.sensitivity_tier='restricted' and t.deleted_at is null) as restricted_rows
from brains b order by slug;

-- open the brains cloud agents should read (example):
update brains set egress_class = 'repo'   where slug in ('ob1', 'common', 'system-config', 'dotfiles');
-- a brain that must stay local-only: leave it 'private_local' (no action).
```

**Ordering matters (018 guard):** a brain that already holds `restricted` rows
**cannot** be opened to `repo`/`public` — the brain-downgrade trigger rejects it.
That is intentional. If `restricted_rows > 0` for a brain you intend to open,
move/declassify that content first (a deliberate local-trusted decision), then
reclassify. (Today, prod/dev hold zero `restricted` rows, so this is unblocked.)

Re-run the inspection query and eyeball every row before moving on. Getting this
wrong is the difference between "cloud agents work" and "cloud agents are locked
out" once you flip `enforce`.

---

## 4. Phase B — caller trust class on keys

Only `pi` (the trusted on-box agent) should be `local_trusted`; **everything else
stays `cloud_bound`** (the `NULL` default). Per docs/45 §3, `pi` is a **distinct
principal**, not a second key on a shared repo principal — provision it that way
(via `scripts/agent_estate/provision.sh`) if it does not yet exist.

```sql
-- audit: which keys exist and their class
select p.slug as principal, k.label, k.is_admin, coalesce(k.read_egress_class,'(null=cloud_bound)') as egress
from brain_access_keys k join brain_principals p on p.id = k.principal_id
order by p.slug, k.label;

-- mark ONLY pi's transport key local_trusted (replace the label/principal):
update brain_access_keys set read_egress_class = 'local_trusted'
where label = '<pi-transport-key-label>' and principal_id = (select id from brain_principals where slug = '<pi-principal-slug>');
```

Rules (already enforced in code, stated here so you don't fight them):
- A stored key is trusted **only** by an explicit `read_egress_class='local_trusted'`. `NULL` / anything else ⇒ `cloud_bound` (fail-closed).
- Human JWT sessions and the bare legacy `MCP_ACCESS_KEY` are hardcoded `cloud_bound`.
- `read_egress_class` is a **read** attribute, never authority — it does not grant approve/downgrade/purge/export.

---

## 5. Phase C — processor allowlist (for restricted content)

A `restricted` capture sends its content to the embedding + LLM processors. OB1
**refuses** to do so unless those endpoints are local-trusted (docs/45 §6.5,
fail-closed). Loopback is always trusted; anything else must be allowlisted.

In this deployment the processors are at **public hostnames**
(`ob1-embedding.lincoln.luchoh.net`, `mlx.lincoln.luchoh.net`), so until you set
the allowlist, **every restricted capture is refused with HTTP 403** ("processor
is not a local-trusted endpoint"). Only set this once you have confirmed those
endpoints are genuinely on-box / trusted:

```bash
# in the SERVER/ingest env only (never a cloud-harness env):
export OB1_RESTRICTED_PROCESSOR_HOSTS="ob1-embedding.lincoln.luchoh.net,mlx.lincoln.luchoh.net"
```

Note: if global TLS verification is disabled (`NODE_TLS_REJECT_UNAUTHORIZED=0`,
which `CONSUL_SKIP_TLS_VERIFY=true` sets), an **https** non-loopback processor is
still refused for restricted content — its identity can't be verified. Either keep
TLS verification on, or terminate the processor on loopback / an on-box socket.

---

## 6. Phase D — credential custody (the foundation, docs/45 §6.1)

This is operational, not enforced by the runtime. Verify, on every host a
**cloud** harness (Claude Code / Codex / Gemini) runs on:

- The harness env contains **only** the MCP client vars (remote endpoint + its
  `OB1_REPO_KEY`). **No** `PGPASSWORD` / `DATABASE_URL` / `NEO4J_*` / `MINIO_*` /
  `CONSUL_*` / `IMAP_*` / `MCP_ACCESS_KEY`, and no path that triggers
  `config.mjs`'s repo-dotenv autoload.
- The bare legacy `MCP_ACCESS_KEY` lives only on the operator/server side. **Known
  gap (review #3/#7):** the legacy key is *not* egress-confined under `enforce`; a
  cloud harness holding it would bypass Layer A. Keep it off all cloud harnesses.

(Service-secrets-out-of-repo + the allowlist startup guard from §6.1 are a
separate v0 hardening, tracked outside this runbook.)

---

## 7. Phase E — run in OBSERVE and tune

Restart the service with the default (`observe`). Drive normal cloud-agent
traffic, then read the structured log for what *would* be denied:

```bash
# each line: {"event":"egress.read_excluded","mode":"observe","authSource":...,
#             "principalId":...,"readEgressClass":"cloud_bound","excludedBrainSlugs":[...]}
grep egress.read_excluded <service-log>
```

Interpretation:
- A slug here that a cloud agent **should** read ⇒ that brain is mis-classified;
  go back to Phase A and set it `repo`/`public`.
- A slug here that a cloud agent should **not** read ⇒ correct; it will be denied
  under enforce.

Iterate Phase A ↔ Phase E until the `egress.read_excluded` lines contain **only**
brains you intend to confine. This is the whole point of the staged model: you
see the exact blast radius before it bites.

---

## 8. Phase F — flip ENFORCE + acceptance

When the observe logs are clean:

```bash
export OB1_EGRESS_ENFORCE=enforce   # server/ingest env; restart the service
```

Acceptance checks (run with a **cloud_bound** test key and a **local_trusted**
test key; clean up fixtures after):

1. cloud_bound `search_thoughts` / `list_thoughts` / `stats` with no brain →
   returns only `repo`/`public` brains; **never 500** (empty is fine).
2. cloud_bound `ask_brain` / `expand_context` with a `private_local` default brain
   → `404 "Brain not found"` (not its content).
3. cloud_bound explicit `brain=<private_local-slug>` on any read → `404`.
4. local_trusted caller → full read surface unchanged.
5. cloud_bound `capture_thought {sensitivity_tier:"restricted"}` into a `repo`
   brain → `404 "Cannot capture restricted content into this brain"`.
6. cloud_bound patch/delete/restore of a `restricted` row → `404` (no oracle).
7. restricted capture with `OB1_RESTRICTED_PROCESSOR_HOSTS` unset → `403`; set →
   succeeds.

If any check fails, **roll back** (Phase 0: set `observe`) and diagnose; do not
leave a half-enforced state in prod.

---

## 9. Rollback

```bash
export OB1_EGRESS_ENFORCE=observe   # or off; restart
```
Instant, data-free. The write-guards and triggers remain (they are always-on and
non-blocking on the current corpus, which has zero `restricted` rows).

---

## 10. Residual gaps — what `enforce` does NOT yet cover

Be explicit about the boundary's edges before relying on `enforce`:

- **Legacy admin (`MCP_ACCESS_KEY`)** is not egress-confined under enforce
  (review #3/#7). Mitigation: keep it off cloud harnesses (Phase D); retire it
  (docs/45 §6.3 / ADR-0003).
- **`ask_brain` over a *mixed-tier* brain** is not row-clamped — that is the
  Layer-B/v2 per-row clamp (`effectiveEgress` is built but unwired). v1 keeps
  `restricted` content out of any cloud-readable brain entirely (the 016/018
  invariants), so under correct provisioning a cloud caller never reaches a brain
  that holds restricted rows.
- **Graph plane** (`graph_neighbors` / `source_lineage` / `why_connected`,
  projection) is kept admin-only; it is not independently egress-checked. Keep
  graph admin keys off cloud harnesses and Neo4j creds out of harness envs
  (docs/45 §8.3 four conditions).
- **Telemetry / audit / backups** retention-redaction for private-derived data is
  a separate hardening (docs/45 §6.14).
- The **full §6.13 protected tier/brain-class transition** (capability + human
  confirmation + audit UI) is future; today the DB triggers (016/018) are the
  un-bypassable floor.

These are the items to close before treating `enforce` as a complete confidentiality
guarantee rather than a strong, fail-closed default.
