# 45 Proposal Review V3 -- Red-Team Findings

**Date:** 2026-06-24
**Reviewer:** Codex
**Reviewed target:** `docs/45-ob1-common-brain-access-proposal.md` Rev 3

## Verdict

Rev 3 fixed the important architectural lie: Layer A is a principal boundary,
not a key boundary. Making pi a distinct local-trusted principal is the right
move. The design is now pointed at reality instead of cosplay cryptography.

The remaining holes are not philosophical. They are implementation traps:

1. Capture is an upsert, so "cloud may create" can become "cloud mutated an
   existing private row" unless the conflict path is tier-aware.
2. Origin taint must be monotonic. If later local patches can wash cloud origin,
   the taint label is a sticker, not a control.
3. Processor egress must be checked before embedding/extraction, not after the
   row is already inserted.
4. "Operator-only" and "local-trusted" still need concrete custody and launch
   boundaries. Otherwise they are just fancier `.env` folklore.

No throw-it-away verdict. More annoying than fatal. The glamorous part is over;
now the boring seams can still cut you.

## Findings

### 1. HIGH -- Capture upsert is an existing-row mutation path

Rev 3 blocks cloud mutation of existing `restricted` rows in §6.10 and says
capture tiering must include the `on conflict` update in §6.8
(`docs/45-ob1-common-brain-access-proposal.md:147`,
`docs/45-ob1-common-brain-access-proposal.md:152`). Good. But the plane table
and acceptance tests still treat capture mostly as create. It is not create.
It is create-or-update.

Runtime evidence:

- `handleCaptureThought` authorizes only brain-level WRITE before embedding and
  store upsert (`local/open-brain-mcp/src/server.mjs:310`).
- `captureThought` performs `on conflict (brain_id, dedupe_key) where
  deleted_at is null do update` (`local/open-brain-mcp/src/thought-store.mjs:85`).
- The conflict update overwrites `content`, `embedding`, `embedding_model`,
  `embedding_dimension`, merges `metadata`, and updates `type`
  (`local/open-brain-mcp/src/thought-store.mjs:87`).
- The live dedupe uniqueness is per `(brain_id, dedupe_key)`, partial on live
  rows (`local/open-brain-mcp/migrations/010_thought_soft_delete.sql:28`).

Abuse path:

A cloud-bound writer cannot patch a restricted row by `thought_id`, so it calls
`capture_thought` with the same `dedupe_key` in the same brain. If the row
already exists and is `restricted`, the `ON CONFLICT DO UPDATE` path is an
existing-row mutation: content and metadata change without going through the
metadata patch route. Congratulations, the front door has a side door.

Required fix:

Treat capture conflict as a row-tier-aware mutation:

- On conflict, load or lock the existing row's current tier before updating.
- If the current row is `restricted`/`personal`, a cloud-bound caller must get a
  denial, not an upsert.
- The denial must happen before replacing content, embeddings, metadata, or
  origin fields.
- Add acceptance tests for cloud-bound capture with a dedupe collision against
  an existing `restricted` row.

### 2. HIGH -- Origin taint can be laundered unless it is monotonic

Rev 3 adds `origin_egress_class` and correctly says `cloud_origin + restricted`
means "hidden from cloud, not trusted local"
(`docs/45-ob1-common-brain-access-proposal.md:155`). That is the right shape,
but the document does not specify whether origin is "last writer" or "ever
tainted." If it is last writer, it is useless.

Runtime evidence:

- Current stored-key auth does not select key id, key label, or any egress class;
  it selects only default brain, `is_admin`, and `principal_id`
  (`local/open-brain-mcp/src/auth.mjs:379`).
- The audit actor currently records only `auth_source`, `principal_id`, and
  `is_admin` (`local/open-brain-mcp/src/access-policy.mjs:103`).
- `thought_audit` only permits `delete`, `restore`, and `purge` actions today
  (`local/open-brain-mcp/migrations/012_thought_delete_authz_audit.sql:47`).
- Capture and metadata patch do not write audit rows; audit inserts exist only
  for lifecycle verbs in `thought-store.mjs`
  (`local/open-brain-mcp/src/thought-store.mjs:238`).

Abuse path:

A cloud harness creates or patches a `standard` row. Later, pi or an operator
backfill promotes it to `restricted`. If promotion overwrites
`origin_egress_class` to `local_trusted`, the cloud origin is washed. The row is
now local-only, trusted-looking, and still cloud-authored. Nice little money
laundry for prompt injections.

Required fix:

Make origin taint monotonic and attributable:

- Store `origin_egress_class` as worst-ever contributor, not last writer.
- Keep a separate `last_writer_egress_class` if useful, but do not use it for
  trust.
- Preserve cloud-origin taint across local promotion, local metadata patch,
  tier backfill, and dedupe upsert.
- Add key/session attribution fields to the access context and audit actor:
  access key id or label, principal id, auth source, egress class, and operation.
- Extend audit beyond delete/restore/purge for tier transitions and any taint
  transition.

### 3. HIGH -- Private capture egress must be blocked before embedding/extraction

Rev 3 says restricted content may be embedded, metadata-extracted, or answered
only by pinned local processors (`docs/45-ob1-common-brain-access-proposal.md:133`).
That is necessary, but the current capture flow sends content to processors
before the database insert. If the future implementation checks tier only inside
`captureThought`, it is too late. The model already saw the text. Very efficient
leak, terrible boundary.

Runtime evidence:

- `handleCaptureThought` starts metadata extraction and embedding before calling
  `captureThought` (`local/open-brain-mcp/src/server.mjs:319`).
- `createEmbedding(content)` and `extractMetadata(content, args.source)` both
  receive the raw capture content before the row exists
  (`local/open-brain-mcp/src/server.mjs:323`).
- The current capture schema has no tier input
  (`local/open-brain-mcp/src/server.mjs:40`).

Required fix:

Processor policy must run before any outbound processor call:

- Parse and validate requested `sensitivity_tier` before embedding/extraction.
- For `restricted`/`personal`, assert pinned local processor identity before
  calling `createEmbedding` or `extractMetadata`.
- If processor trust cannot be proven, fail before content leaves the handler.
- Add a regression test that a restricted capture with an untrusted embedding or
  LLM endpoint performs zero upstream requests.

### 4. MEDIUM/HIGH -- The pi principal needs concrete credential custody

Rev 3 correctly makes pi a distinct local-trusted principal
(`docs/45-ob1-common-brain-access-proposal.md:45`). That fixes the principal/key
bug. It does not yet say where pi's credential lives or how the cloud harness is
kept from using the same local transport.

This is not asking for impossible same-user anti-theft magic. The doc already
accepts active same-user key theft as residual
(`docs/45-ob1-common-brain-access-proposal.md:49`). Fine. But the ordinary,
non-malware path still needs to be closed: repo env, MCP config, command args,
logs, and tool-visible files must not contain the pi credential.

Required fix:

Specify the local-trusted transport boundary:

- pi's credential is held by a local sidecar/session broker, OS keychain-backed
  helper, or equivalent operator-owned process.
- The LLM-visible repo shell receives only `OB1_REPO_KEY`, never pi's key.
- Cloud harnesses cannot select the pi transport by changing a URL/header in the
  repo config.
- Logs and telemetry must never record the pi bearer.
- Acceptance test: from a clean repo agent shell, ordinary repo scripts and MCP
  client config cannot obtain or invoke the pi principal.

Without this, "distinct principal" is only a database row with better manners.

### 5. MEDIUM -- Operator-only planes are still mixed into agent-facing docs and scripts

Rev 3 reframes startup guards as tripwires and says service/source secrets must
move outside repo-visible launch paths (`docs/45-ob1-common-brain-access-proposal.md:102`).
Correct. But the existing repo still teaches agents and humans to source service
env and use source/storage credentials from repo workflows.

Runtime evidence:

- Email import docs explicitly source `../../.env.open-brain-local`
  (`recipes/email-history-import/README.md:78`).
- Graph eval loads `.env.open-brain-local` directly
  (`local/open-brain-mcp/evals/eval-graph-retrieval.py:95`).
- Telegram capture docs require `MCP_ACCESS_KEY`, Consul, and MinIO credentials
  together (`integrations/telegram-capture/README.md:39`).
- Dictation import docs require `MCP_ACCESS_KEY`, Consul, and MinIO credentials
  together (`recipes/dictation-import/README.md:35`).
- Shared Docling code reads `OPEN_BRAIN_INGEST_KEY` or `MCP_ACCESS_KEY`, plus
  Consul discovery variables (`recipes/shared_docling.py:33`).

Risk:

If "operator-only" means "same repo, same docs, same scripts, but please don't
run these from the cloud harness," the boundary is voluntary. Voluntary
boundaries are just comments with a badge.

Required fix:

The v0 tripwire needs to cover docs and launch examples, not just runtime JS:

- Split operator recipes from cloud/client recipes.
- Move operator launch docs out of the default agent path or mark them with a
  hard guard that refuses cloud-class env.
- Replace `MCP_ACCESS_KEY` examples with `OB1_REPO_KEY` or
  `OB1_OPERATOR_ACCESS_KEY` as appropriate.
- Add a repo check for `.env.open-brain-local`, `MCP_ACCESS_KEY`, PG, Neo4j,
  Consul, MinIO, IMAP, Telegram, Slack, and Docling credential references in
  cloud/client paths.

### 6. MEDIUM -- Telemetry redaction cannot depend only on row tier

Rev 3 covers telemetry and error bodies as private-derived planes
(`docs/45-ob1-common-brain-access-proposal.md:89`,
`docs/45-ob1-common-brain-access-proposal.md:140`). The proposed wording still
leans on "restricted paths." That is too late and too narrow.

Why:

A local-trusted query string can itself be private even if it returns no rows, or
only `standard` rows. A restricted capture can fail before the row exists. A
processor error can happen before tier is persisted. A brain slug can reveal the
existence of a private brain even before any content is materialized.

Required fix:

Redaction policy should key off caller and request context, not only row tier:

- For `local_trusted` requests, default telemetry to no raw query previews,
  evidence snippets, brain slugs, processor URLs, or upstream error text.
- For private brains, redact even zero-result and failed requests.
- For capture, redact before insert and before tier exists.
- Treat "tier unknown" as private for telemetry and errors.

## Acceptance Tests To Add

Add these on top of the Rev 3 adopted gates:

1. Cloud-bound capture with a `dedupe_key` colliding with an existing
   `restricted` row is denied and leaves content, metadata, embedding, and tier
   unchanged.
2. Cloud-origin taint survives local metadata patch, local tier promotion,
   operator backfill, and dedupe upsert.
3. Restricted capture with an untrusted embedding or metadata endpoint performs
   no upstream request.
4. A clean repo agent shell cannot obtain or invoke the pi local-trusted
   principal through env, MCP config, repo scripts, or query-string key paths.
5. Repo checks fail cloud/client docs or scripts that source
   `.env.open-brain-local` or mix `MCP_ACCESS_KEY` with source/storage creds.
6. Local-trusted zero-result searches, failed captures, and private-brain errors
   write no raw query text, brain slug, upstream URL, or upstream body to
   agent-readable telemetry/logs.

## Bottom Line

Rev 3 deserves less violence than the earlier drafts. Annoying development.

The next critical implementation rule is simple: every "create" path must be
treated as a possible "update" path, every origin label must be non-washable,
and every private processor check must happen before bytes leave the handler.
Miss those and the design will keep secrets beautifully while letting cloud
agents rewrite or launder the memories pi later trusts. Which would be very
modern. Also very dumb.
