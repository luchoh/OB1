# 45 Proposal Review V2 -- Red-Team Findings

**Date:** 2026-06-23
**Reviewer:** Codex
**Reviewed target:** `docs/45-ob1-common-brain-access-proposal.md` Rev 2

## Verdict

Rev 2 folded the v1 findings instead of tap-dancing around them. Credit where
due: the two previous criticals are now first-class requirements, and the doc is
mostly on the right axis.

The remaining failures are narrower:

1. Layer A is principal-scoped, while the two-key model is key-scoped.
2. The write clamp protects the label, but not the restricted row.
3. Cloud-origin `restricted` writes create a hidden local-only injection channel.
4. The operational plan still leaves too much to "guard runs, probably" instead
   of structural custody.

No new "throw it away" verdict. More like: stop confusing confidentiality-safe
with system-safe. Different animal. Same teeth.

## Findings

### 1. HIGH -- Two brains do not separate pi from Codex if they share one principal

Rev 2 says Layer A is "membership absence" and works when no cloud principal has
membership to the private brain (`docs/45-ob1-common-brain-access-proposal.md:71`).
It also says the local and cloud credentials may be two keys for the same
`principal_id`, with the same membership scope
(`docs/45-ob1-common-brain-access-proposal.md:130`).

Those two statements do not compose. Keys are not principals. This is where the
fake mustache falls off.

Runtime evidence:

- `brain_access_keys` stores many keys against one `principal_id` in
  `local/open-brain-mcp/migrations/005_household_multitenancy.sql:83`.
- `brain_memberships` are keyed by `(principal_id, brain_id)`, not by access key,
  in `local/open-brain-mcp/migrations/005_household_multitenancy.sql:54`.
- Stored-key auth resolves a key to `principal_id`, `key_brain_id`, and
  `is_admin`; the key's `brain_id` is only a default-brain hint in
  `local/open-brain-mcp/src/auth.mjs:379`.
- Scope derivation grants access from principal brain membership, estate
  membership, or admin home-estate reach in
  `local/open-brain-mcp/src/access-policy.mjs:266`.

Abuse path:

Create `common-private` as a second brain. Grant the repo principal membership so
pi's `local_trusted` key can read it. Because Codex's `cloud_bound` key maps to
the same principal, Codex inherits the same brain membership. Layer A did
nothing. The only thing left protecting rows inside that brain is Layer B's
per-key egress clamp.

Impact:

The proposal's open decision says a two-brain split can push "most shared-brain
work back into Layer A" (`docs/45-ob1-common-brain-access-proposal.md:186`).
That is true only if private brains are granted to principals that no cloud key
uses. Under the proposed two-keys-per-principal model, it is false. DENY cannot
save it either, because a brain-level DENY also targets the principal and would
clamp pi's local key with Codex's cloud key.

Required fix:

State the invariant explicitly:

- Layer A separates cloud/local only at the **principal** boundary.
- If pi and Codex share a principal, a private brain grant to pi is also a grant
  to Codex; use Layer B row clamps, or create a distinct local-only principal.
- If the design wants key-specific brain reach, that is a new authorization
  primitive, not `read_egress_class` and not current ADR-0001/0002 membership.
- Add an acceptance test: a cloud-bound key sharing the same principal as a
  local-trusted key must not gain private-brain rows merely because the local key
  needs that brain.

### 2. HIGH -- Tier protection must cover all existing-row mutations, not just label downgrade

Rev 2 correctly blocks the obvious `restricted -> standard` declassification
path (`docs/45-ob1-common-brain-access-proposal.md:148`). But the proposed fix
is still too narrow: it removes `sensitivity_tier` from generic metadata patch,
while leaving other mutations of an existing `restricted` row governed only by
brain-level WRITE/DELETE/RESTORE/PURGE permissions.

Runtime evidence:

- `/admin/thought/metadata` authorizes only at brain WRITE level before patching
  a specific row in `local/open-brain-mcp/src/server.mjs:1060`.
- `patchThoughtMetadata` can still change `metadata`, `type`, `source_type`,
  `importance`, `quality_score`, `enriched`, and `status` in
  `local/open-brain-mcp/src/thought-store.mjs:146`.
- `delete`, `restore`, and `purge` are authorized by brain/action capability,
  not row tier, in `local/open-brain-mcp/src/server.mjs:1104`,
  `local/open-brain-mcp/src/server.mjs:1121`, and
  `local/open-brain-mcp/src/server.mjs:1141`.

Abuse path:

In the row-flag / Layer B design, a cloud-bound editor that knows a restricted
`thought_id` cannot read the row, but can still mutate its metadata/status, or
delete/restore it if the role allows. That is blind write access to a row the
caller is not allowed to materialize. Hilarious, in the way a trapdoor is
hilarious.

Impact:

This is not direct cloud exfiltration. It is integrity compromise of local-only
memory, plus existence oracles through mutation responses. It can poison
metadata summaries, sources, people/tags, status, enrichment flags, and
destructive lifecycle state on private rows.

Required fix:

Layer C must be row-tier-aware for **all existing-row mutations**:

- Cloud-bound callers may create new rows and may mutate rows whose current tier
  is cloud-visible.
- Cloud-bound callers may not patch, delete, restore, purge, or otherwise mutate
  an existing `restricted`/`personal` row.
- Raising a row from `standard` to `restricted` is a special case, not proof that
  every other metadata mutation is safe.
- Enforcement belongs in the store SQL or a single preloaded-row authorization
  seam, not scattered in route handlers.

### 3. HIGH -- Cloud-origin `restricted` writes become hidden prompt-injection into local-only context

Rev 2 says raising a label is safe and should be allowed by any writer
(`docs/45-ob1-common-brain-access-proposal.md:154`) and that cloud-bound capture
may set `restricted` at creation (`docs/45-ob1-common-brain-access-proposal.md:159`).
Confidentiality-wise, fine. Integrity-wise, no.

Abuse path:

A cloud-bound harness writes a new `restricted` row into a shared brain. Cloud
readers cannot see it. Pi/local-trusted readers can. That creates a hidden
write-only channel from the cloud provider into the local-only evidence set.
Make the content a prompt injection, false operational memory, or poisoned
"decision". Now the thing cloud cannot read is exactly the thing local inference
will trust more. Beautiful little landmine.

Existing controls:

The row has an actor/audit trail only if every write path stamps one correctly.
The proposal does not require `origin_egress_class`, `created_by_egress_class`,
or trust filtering at retrieval time.

Required fix:

Add origin taint as a separate concept from read tier:

- Stamp every row with `origin_egress_class` / writer class / author session at
  capture and patch time.
- Treat `cloud_origin + restricted` as "hidden from cloud", not "trusted local
  private".
- Either disallow cloud-bound writers from creating `restricted` rows in shared
  brains, or quarantine them for local review before they enter local-trusted
  retrieval.
- Local-trusted `ask_brain` should be able to exclude or visibly mark
  cloud-origin restricted evidence.

Without this, the system closes an egress leak and opens an integrity drain.
Different pipe. Same basement flood.

### 4. MEDIUM/HIGH -- The migration 015 fix is still only partially folded

Rev 2 fixes the v1 stale citation for `match_thoughts` and
`match_thoughts_recency`, but still says `list_recent_thoughts` is from
migration 013 (`docs/45-ob1-common-brain-access-proposal.md:89`).

Runtime evidence:

- Migration 015 also redefines `list_recent_thoughts` in
  `local/open-brain-mcp/migrations/015_exclude_conversation_records_from_reads.sql:278`.
- That 015 version preserves the conversation-record exclusion predicate in
  `local/open-brain-mcp/migrations/015_exclude_conversation_records_from_reads.sql:304`.

Risk:

If the tier-clamp migration copies `list_recent_thoughts` from migration 013,
`list_thoughts` silently resurrects the chat-export record leak/pollution that
015 fixed. The doc says "base on 015" in prose, but the load-bearing plane row
still points one function at the wrong source. That is how migration archaeology
turns into a production bug with a museum label.

Required fix:

Update the plane table to cite migration 015 for all active read functions it
redefined, including `list_recent_thoughts`. Add an acceptance test for
`list_thoughts` specifically, not only vector search.

### 5. MEDIUM/HIGH -- Existing tier-mutation scripts are missing from the plane inventory

Rev 2 says tier mutation must leave the generic metadata patch route
(`docs/45-ob1-common-brain-access-proposal.md:152`). That is necessary. But the
repo already has tier backfill/enrichment tooling that depends on the current
generic patch route and direct PG reads.

Runtime evidence:

- `scripts/thought_enrichment/lib/db.py` reads Postgres directly using PG env in
  `scripts/thought_enrichment/lib/db.py:68`.
- It patches `sensitivity_tier` through `/admin/thought/metadata` in
  `scripts/thought_enrichment/lib/db.py:228`.
- `scripts/thought_enrichment/backfill_sensitivity.py` scans standard/null rows
  and applies `personal`/`restricted` upgrades in
  `scripts/thought_enrichment/backfill_sensitivity.py:44`.
- That script requires PG env plus `MCP_ACCESS_KEY` in
  `scripts/thought_enrichment/backfill_sensitivity.py:16`.

Risk:

One of two things happens:

- You remove `sensitivity_tier` from generic patch and the current backfill
  tooling breaks.
- You leave a compatibility path and it remains a tier-mutation bypass with
  direct DB visibility and legacy-key-shaped auth.

Required fix:

Add operator tier backfill/enrichment to the plane table. Route it through the
same local-trusted tier-transition endpoint as every other tier mutation, with
explicit operator credentials, audit, and no repo service-secret env. If the
tool keeps direct PG reads, classify it as an operator-only path outside cloud
harness reach and test that it cannot run from a clean agent env.

### 6. MEDIUM -- The startup guard is hygiene, not an enforceable boundary

Rev 2 says the allowlist startup guard runs before any dotenv load and fails
closed when cloud-class env contains cred-shaped vars
(`docs/45-ob1-common-brain-access-proposal.md:119`). Useful. But it is not a
server-side security control against remote/cloud clients, because OB1 cannot
inspect a cloud provider's environment. Nor can it force an arbitrary repo
script to run the guard first unless every launch path is structurally changed.

Runtime evidence:

- `scripts/eval-open-brain-ask-ab.mjs` has its own repo dotenv loader in
  `scripts/eval-open-brain-ask-ab.mjs:31`.
- `scripts/smoke-open-brain-running-service.sh` sources `.env.open-brain-local`
  directly in `scripts/smoke-open-brain-running-service.sh:9`.
- `devenv.nix` still loads/sources `.env.open-brain-local` in `devenv.nix:4`
  and `devenv.nix:75`.

Risk:

If "the guard" is just something polite launchers do, the boundary is voluntary.
Voluntary security controls are just comments with shoes.

Required fix:

Make v0 structural:

- Remove all repo-local service-secret autoloads, not only `config.mjs`.
- Move service secrets outside the repo and outside default agent-readable
  launch paths.
- Treat the guard as a regression tripwire for approved launchers, not the main
  barrier.
- Add a repo-wide test that fails if any cloud/client script sources
  `.env.open-brain-local` or reads PG/Neo4j/Consul/source credential env vars.

### 7. MEDIUM -- `OB1_REPO_KEY` rename is not just ADR text; client tooling still speaks `MCP_ACCESS_KEY`

Rev 2 correctly separates repo client keys from the legacy server admin
`MCP_ACCESS_KEY` (`docs/45-ob1-common-brain-access-proposal.md:136`). But this
repository has many client/import paths still wired to `MCP_ACCESS_KEY` or
`OPEN_BRAIN_ACCESS_KEY`.

Runtime evidence:

- Telegram bridge defaults to `MCP_ACCESS_KEY` / `OPEN_BRAIN_ACCESS_KEY` in
  `integrations/telegram-capture/telegram_bridge.py:77`.
- Dictation import defaults to `MCP_ACCESS_KEY` / `OPEN_BRAIN_ACCESS_KEY` in
  `recipes/dictation-import/import-dictation.py:67`.
- ChatGPT/Claude importers default to `MCP_ACCESS_KEY` in
  `recipes/chatgpt-conversation-import/import-chatgpt.py:73` and
  `recipes/claude-conversation-import/import-claude.py:50`.
- Smoke/eval scripts also use `MCP_ACCESS_KEY`, for example
  `scripts/smoke-open-brain-running-service.sh:23` and
  `scripts/eval-open-brain-ask-ab.mjs:165`.

Risk:

If the variable rename is treated as prose, the old collision survives in
scripts. Worse, some scripts need operator/server authority and some need
repo-client authority; one env name cannot safely mean both. We already watched
that movie. Bad ending. No sequel.

Required fix:

Inventory every client/integration/script credential variable:

- Repo/cloud client paths read `OB1_REPO_KEY` first and never require the legacy
  admin key.
- Operator/admin scripts read `OB1_OPERATOR_ACCESS_KEY` or an explicit operator
  env, not `MCP_ACCESS_KEY`.
- Server runtime may keep `MCP_ACCESS_KEY` only as the legacy admin variable
  while it exists.
- Compatibility fallbacks, if kept, must warn loudly and be forbidden in
  cloud-class env.

### 8. MEDIUM -- Local processor trust needs identity/pinning, not URL vibes

Rev 2 says private-tier processing may only use local trusted
`EMBEDDING_BASE_URL`/`LLM_BASE_URL` and warns about DNS rebinding/tunnels
(`docs/45-ob1-common-brain-access-proposal.md:140`). The warning is doing too
much work.

Runtime evidence:

- Consul service discovery returns an HTTP URL from whatever service address and
  port Consul reports in `local/open-brain-mcp/src/config.mjs:113`.
- LLM and embedding service names and base URLs are environment-configurable in
  `local/open-brain-mcp/src/config.mjs:250`.
- `CONSUL_SKIP_TLS_VERIFY` can set `NODE_TLS_REJECT_UNAUTHORIZED=0` globally in
  `local/open-brain-mcp/src/config.mjs:103`.

Risk:

"URL resolves to local-ish" is not service identity. A poisoned service
registration, explicit env override, tunnel, or TLS-disabled path can make OB1
send restricted content to a processor that is not actually inside the trusted
boundary. The document names the beast but does not cage it.

Required fix:

Make private-tier processor trust a real policy:

- Pin allowed processor identities, not just hostnames.
- Validate resolved IP/CIDR at request time and reject tunnels/untrusted ranges.
- Prefer mTLS or signed service identity for model/embedding services.
- For private-tier calls, fail if TLS validation is globally disabled unless the
  endpoint is explicitly local loopback or an approved on-box socket.
- Add tests for explicit URL override, Consul-discovered remote address, and
  `CONSUL_SKIP_TLS_VERIFY=true`.

## Acceptance Tests To Add

Add these to the v2 landing gate, on top of the v1 gate already adopted:

1. A cloud-bound key sharing a principal with a local-trusted key cannot read
   private-brain rows through principal-level membership; either Layer B clamps
   them or the private brain uses a distinct local-only principal.
2. A cloud-bound writer cannot patch metadata/status/type/source/enriched on an
   existing `restricted` row, even with brain editor role.
3. A cloud-bound owner/admin cannot delete, restore, or purge an existing
   `restricted` row.
4. Cloud-origin `restricted` captures are either rejected, quarantined, or
   stamped and excluded/marked in local-trusted retrieval.
5. `list_thoughts` preserves migration 015 conversation-record exclusion after
   the tier predicate migration.
6. The sensitivity backfill tool uses the new local-trusted tier endpoint, not
   the generic metadata patch route.
7. A repo-wide grep/test fails on new cloud/client scripts that source
   `.env.open-brain-local` or depend on PG/Neo4j/Consul/source credentials.
8. Repo client tooling accepts `OB1_REPO_KEY`; operator tooling accepts an
   operator key; neither silently falls back to the legacy admin key in
   cloud-class mode.
9. Private-tier model/embedding calls fail closed for untrusted Consul results,
   explicit remote URL overrides, and TLS-disabled HTTPS paths.

## Bottom Line

Rev 2 is no longer dumb. Annoying, but no longer dumb.

The next actual wall is not only "can we hide private reads from cloud?" It is
"which boundary are we using: principal, key, row, or processor?" Layer A is a
principal boundary. Layer B is a key/row boundary. Layer C is a write-integrity
boundary. Confuse them and the design looks secure on paper while granting the
same principal both hats.

After that, the second wall is "can we stop cloud-write capability from
corrupting the local-only side while still letting agents contribute?" That means
row-tier-aware write authorization and origin taint. Skip those and you get a
memory system that keeps secrets while faithfully preserving poisoned ones.
Progress, technically. The funniest kind of failure.
