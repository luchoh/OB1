# 51 — Handover: enforce-safe ingest keys (for the M2 system-config agent)

**Audience:** the agent that edits `system-config` on M2 (the read-only repo from OB1's side). This doc is the contract between the OB1-side work (done) and the system-config-side work (yours).
**Goal:** make Telegram / IMAP / dictation ingest **survive `OB1_EGRESS_ENFORCE=enforce`** without breaking, by giving each ingest daemon a `local_trusted`, non-admin key instead of the shared bare `MCP_ACCESS_KEY`.
**Status of OB1 side:** done + tested on `ob1_dev` (commit `f401b22` for the stamping + `scripts/provision-ingest-key.sh` on `develop`). Your side is the agenix secrets + the `accessKeyFile` repoint.

---

## 1. The problem (proven on ob1_dev, not theoretical)

Under `enforce`, a `cloud_bound` caller is **404'd writing to a `private_local` brain** (legacy-admin confinement, commit `7495350`). The ingest daemons today authenticate with the bare `MCP_ACCESS_KEY` (which resolves to the `cloud_bound` legacy-admin path) and write to the default brain (`luchoh`, `private_local`). So **flipping enforce as-is breaks them:**

```
OBSERVE: importer write → ok
ENFORCE: importer write → FAILED "Brain not found"
```

The fix has two halves. The OB1 half is done; the system-config half is yours.

| Half | Owner | State |
|---|---|---|
| Stamp `/ingest/thought` content `cloud_origin + untrusted` so a `local_trusted` ingest key does NOT launder external content into "trusted" | OB1 (`f401b22`) | ✅ committed |
| `provision-ingest-key.sh` — mint a `local_trusted`, non-admin, scoped key | OB1 (`scripts/`) | ✅ committed + tested |
| Mint a key per daemon, store in agenix, **repoint each daemon's `accessKeyFile`** | **system-config (you)** | ⛔ to do |

After the swap, the same write under enforce → `ok`, stamped `cloud_origin | untrusted | standard`. Agent-authored captures via the MCP `capture_thought` tool are unchanged (still `trusted`).

---

## 2. Your steps

### Step A — mint a `local_trusted` ingest key per daemon
Run the OB1 helper **once per source**, first against `ob1_dev`, then (deliberately) `ob1`. It prints the plaintext key **once** (only the sha256 is stored):

```bash
# from the OB1 checkout, with PGUSER/PGPASSWORD + Consul env (or PGHOST/PGPORT) set:
PGDATABASE=ob1_dev scripts/provision-ingest-key.sh \
  --brain luchoh --principal ingest-imap     --label imap-ingest
PGDATABASE=ob1_dev scripts/provision-ingest-key.sh \
  --brain luchoh --principal ingest-telegram --label telegram-ingest
PGDATABASE=ob1_dev scripts/provision-ingest-key.sh \
  --brain luchoh --principal ingest-dictation --label dictation-ingest
# then, deliberately, the same three with PGDATABASE=ob1
```
- `--brain luchoh` keeps today's behavior (ingest lands in `luchoh`, just stamped untrusted). If you later want a holding/quarantine brain + promotion, mint against that brain instead — but that changes visibility (content won't appear in `luchoh` reads until promoted), so it's a separate decision, not this handover.
- The keys are **`is_admin=false`, `read_egress_class=local_trusted`, default brain = `luchoh`, editor membership**. They are deliberate `local_trusted` credentials — **keep them on M2 only, never on a cloud-harness host.**
- `--principal` gets its own service principal per source (independent revocation/audit). Re-running with the same `--label` refuses (idempotent guard); revoke via `update brain_access_keys set is_active=false where label='…';`.

### Step B — store each key in agenix (m2Only)
Create one secret per source, e.g. `secrets/ob1-ingest-imap-key.age`, `ob1-ingest-telegram-key.age`, `ob1-ingest-dictation-key.age`, scoped `m2Only` (mirror the existing `ob1-ingest-access-key.age` pattern). Each file is the single-line key from Step A.

### Step C — repoint each daemon's `accessKeyFile` (the actual swap)
Every ingest daemon wrapper reads its key from `openBrain.accessKeyFile` into the env it presents (verified: `modules/ob1-imap-watch/default.nix:111-112` exports `MCP_ACCESS_KEY` **and** `OPEN_BRAIN_INGEST_KEY`; `modules/ob1-telegram-bridges/default.nix:296` and `modules/ob1-dictation-import/default.nix:66` export `MCP_ACCESS_KEY`). The Python client (`recipes/shared_capture.py`) reads `OPEN_BRAIN_INGEST_KEY` first, else `MCP_ACCESS_KEY` — so **swapping `accessKeyFile` is sufficient; no new env var is needed.**

Point each enabled daemon's `services.<daemon>.openBrain.accessKeyFile` at its new per-source secret instead of `ob1-ingest-access-key`:

| Daemon (enable whichever you actually run) | Module | launchd instance file |
|---|---|---|
| IMAP watch | `modules/ob1-imap-watch` | `hosts/services/m2maxstudio/ob1-imap-watch.nix` |
| Telegram bridge (singular / plural) | `modules/ob1-telegram-bridge` / `ob1-telegram-bridges` | `ob1-telegram-bridge.nix` / `ob1-telegram-bridges.nix` |
| Dictation import (singular / plural) | `modules/ob1-dictation-import` / `ob1-dictation-imports` | `ob1-dictation-import.nix` / `ob1-dictation-imports.nix` |

There are singular **and** plural variants — only repoint the ones that are enabled. (The telegram bridge also has a separate `dictation.accessKeyFile` for its dictation submit path — give it the dictation key too.)

> **Do NOT touch `ob1-stable`'s own `accessKeyFile` here.** That is the *server's* identity / the bare `MCP_ACCESS_KEY` — retiring it is a separate Stage-0 item (docs/50 §7 R-FLOOR), not this handover. This handover only moves the **ingest daemons** off the shared key.

### Step D — rebuild + test each pipeline (the safety gate)
Rebuild on M2, restart each daemon, and **smoke-test each pipeline end-to-end under `enforce` on `ob1_dev` first**:
- IMAP: send a test email to the watched mailbox → confirm a row appears (stamped `cloud_origin | untrusted`).
- Telegram: send + Commit a test message → confirm the row.
- Dictation: run a test dictation → confirm.

Reference check used on the OB1 side (adapt the host/key):
```sql
select origin_egress_class, source_trust_class, sensitivity_tier
from thoughts where dedupe_key like '<your test key>%';
-- expect: cloud_origin | untrusted | standard
```

Only when **every enabled pipeline is verified writing on its new key** do you proceed.

---

## 3. Sequencing & safety (the order that never breaks the services)

1. Mint keys (Step A) — old key still active; nothing changes yet.
2. agenix secrets (Step B).
3. Repoint `accessKeyFile` per daemon (Step C), rebuild, **test each** (Step D) — **still under `observe`** (writes work in both modes; you're just confirming the new key authenticates).
4. Flip `OB1_EGRESS_ENFORCE=enforce` (after classifying every brain's `egress_class`; prod also needs migrations 016/017/018 — release-gated). Re-run the per-pipeline smoke test under enforce.
5. **Only after all daemons run on their new keys**, the shared `ob1-ingest-access-key` / bare `MCP_ACCESS_KEY` can be retired (separate Stage-0 step).

**Reversibility:** every step is reversible. `enforce` → set `observe` + restart (instant, data-free). A bad key swap → point `accessKeyFile` back at `ob1-ingest-access-key` + rebuild. A bad key → `update brain_access_keys set is_active=false where label='…';`.

**Do NOT:**
- flip `enforce` before every enabled ingest daemon is on a `local_trusted` key and smoke-tested (they will 404);
- retire `MCP_ACCESS_KEY` before the daemons are repointed (they fall back to it);
- put any `local_trusted` ingest key on a cloud-harness host (M4) — these are deliberate trusted credentials, M2-only.

---

## 4. Why this is safe to do at all (the trust split)

The ingest pipeline is *trusted to write* into private memory (it's your own on-box mail/telegram path), but its *content is not trusted as content* (someone can email you a prompt injection). Those are now two separate axes:
- `read_egress_class=local_trusted` on the key → the write reaches `luchoh` under enforce.
- `/ingest/thought` stamps `source_trust_class=untrusted` + `origin_egress_class=cloud_origin` → the content is marked external, so the monotone-taint trigger blocks any later UPDATE from washing it to trusted, and a downstream answer path can treat it skeptically.

So a `local_trusted` ingest key is **not** a laundering hole — injected mail still lands `untrusted`. (The remaining fresh-INSERT laundering gap and the full promote verb are tracked in docs/50 §4; not required for this handover.)
