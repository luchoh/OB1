# 45 Proposal Review V1 -- Red-Team Findings

**Date:** 2026-06-23
**Reviewer:** Codex
**Reviewed target:** `docs/45-ob1-common-brain-access-proposal.md`

## Verdict

The rewrite has the right frame: the problem is cloud egress, credential custody,
processor custody, and private-derived artifacts. That is the adult version.

It still has two real bypasses, not cosmetic rough edges:

1. `sensitivity_tier` is treated as a read filter but remains write-mutable by
   ordinary writers.
2. v0 says "env split" while runtime code still auto-loads the server secret
   file from the repo.

Fix those before anyone pretends this is implementable. The rest is mostly
implementation hardening and test coverage.

## Findings

### 1. CRITICAL -- Cloud writers can declassify restricted rows

The proposal's clamp is read-side only: `read_egress_class` withholds
`restricted` rows from cloud-bound readers (`docs/45-ob1-common-brain-access-proposal.md:112`),
while cloud harnesses keep write/capture ability (`docs/45-ob1-common-brain-access-proposal.md:139`).
That misses the write-side label mutation path.

Runtime evidence:

- `sensitivity_tier` is accepted by the metadata patch schema in `local/open-brain-mcp/src/server.mjs:87`.
- `/admin/thought/metadata` authorizes only `WRITE`, then passes `sensitivityTier` into the store in `local/open-brain-mcp/src/server.mjs:1064`.
- `patchThoughtMetadata` writes the `sensitivity_tier` column directly in `local/open-brain-mcp/src/thought-store.mjs:163`.

Exploit path:

A cloud-bound repo editor that knows a restricted `thought_id` calls
`/admin/thought/metadata` with `sensitivity_tier: "standard"`. The row is now
cloud-safe by label, so the read clamp no longer withholds it. No model
impersonation needed. Just boring HTTP. The usual assassin.

Required fix:

Treat `sensitivity_tier` as a security label, not ordinary metadata. Remove it
from the generic metadata patch route, or gate tier transitions through a
separate local-trusted owner/publish capability with audit. In particular,
`restricted`/`personal` -> `standard` must require local-trusted human/operator
confirmation. Cloud-bound writers may submit content, but they must not be able
to lower a private label.

### 2. CRITICAL -- Capture cannot set the tier atomically, so sensitive writes are born standard

The proposal admits the column defaults to `standard` and capture does no
auto-tiering (`docs/45-ob1-common-brain-access-proposal.md:146`), but it does
not make atomic tiering a v0/v1 requirement.

Runtime evidence:

- `capture_thought` input has no `sensitivity_tier` field in `local/open-brain-mcp/src/server.mjs:40`.
- `captureThought` inserts `content`, `embedding`, `metadata`, and `type`, but not `sensitivity_tier`, in `local/open-brain-mcp/src/thought-store.mjs:63`.
- The DB default is `sensitivity_tier text default 'standard'` in `local/open-brain-mcp/migrations/006_lexical_search.sql:22`.

Exploit path:

A local-trusted caller captures private content that should be restricted. The
row lands as `standard` until a later metadata patch. During that window, a
cloud-bound reader can retrieve it. If the later patch never happens, it leaks
forever. Security by "remember to patch it later" remains undefeated in the
worst possible category.

Required fix:

Add `sensitivity_tier` to the capture API and insert/upsert it atomically. Define
server-side rules: default remains `standard`, unknown values fail closed, and
any local-only capture path can mark `restricted` at creation time. Add tests
that a restricted capture is never visible to cloud-bound search/list/ask/stats
between insert and return.

### 3. CRITICAL -- v0 env split is bypassed by repo dotenv autoload

The proposal correctly calls non-MCP credential custody "the foundation"
(`docs/45-ob1-common-brain-access-proposal.md:102`) and requires the cloud
harness env to contain only MCP client credentials (`docs/45-ob1-common-brain-access-proposal.md:107`).
But the current runtime still loads the service secret file from the repo.

Runtime evidence:

- `config.mjs` unconditionally reads `.env.open-brain-local` from the repo and
  merges it into `process.env` on import in `local/open-brain-mcp/src/config.mjs:18`.
- `devenv.nix` loads `.env.open-brain-local` into the dev shell in `devenv.nix:4`.
- `devenv.nix` also sources the same file in the service process block in `devenv.nix:75`.
- `.env.open-brain-local` exists in the repo with mode `600`; that helps against
  other OS users, not same-user agents.

Exploit path:

A cloud harness starts with a clean env, then runs a repo script or imports
runtime code that touches `config.mjs`. The official code path reads the server
dotenv and populates PG/Neo4j/Consul/source credentials. Now the harness can
bypass MCP with normal DB/graph clients. This is not malware. This is Tuesday.

Required fix:

Move service secrets out of the repo and out of agent-visible dotenv files.
Examples: `$XDG_CONFIG_HOME/open-brain/service.env`, launchd/systemd env,
Keychain/agenix/1Password CLI injection, or another operator-owned secret
provider. Remove repo-dotenv autoload from `config.mjs`, or gate it behind an
explicit service-only env var pointing to a file outside the repo. Run the
cloud-harness allowlist guard before any dotenv load. Repo agent env should hold
only MCP endpoint plus `OB1_REPO_KEY`.

### 4. HIGH -- Layer A overclaims brain-scope coverage; graph is not covered

Layer A says that if a brain never lands in `accessible`, "every read plane" is
covered transitively (`docs/45-ob1-common-brain-access-proposal.md:70`). The same
document later admits graph reads have no `brain_id` or `accessibleIds`
parameter (`docs/45-ob1-common-brain-access-proposal.md:87`). The table is more
honest than the invariant. Awkward.

Runtime evidence:

- Graph projection scans `thoughts` across brains and tiers in `local/open-brain-mcp/src/graph-projection.mjs:71`.
- Neo4j nodes are merged by `canonical_id` only in `local/open-brain-mcp/src/graph-projection.mjs:154`.
- Projected Thought nodes include `summary` and `content_preview` in `local/open-brain-mcp/src/projection-planner.mjs:1232`.
- Graph read scrubbing validates liveness only, not brain scope or tier, in `local/open-brain-mcp/src/graph-reads.mjs:117`.

Exploit path:

Local-only brain content is projected into the same flat Neo4j namespace as
everything else. If any cloud-held key reaches graph admin, or if graph data is
exposed by an operator route, brain membership absence no longer helps.

Required fix:

Narrow Layer A's claim to Postgres read planes that actually use
`resolveReadBrains`/`brainId`. For graph, choose one explicit v1 rule:
exclude restricted/local-only rows from projection, partition graph by
brain/tier and filter every graph read, or keep graph completely unavailable to
cloud-held credentials and prove that with tests.

### 5. HIGH -- `read_egress_class` only attaches to stored keys

The proposal binds `read_egress_class` to stored access keys
(`docs/45-ob1-common-brain-access-proposal.md:112`) and handles legacy admin
separately (`docs/45-ob1-common-brain-access-proposal.md:117`). It does not
settle human tokens or internal operator jobs.

Runtime evidence:

- Human JWT auth builds a principal context without any egress class in
  `local/open-brain-mcp/src/auth.mjs:330`.
- `makeContext` has no egress-class field in `local/open-brain-mcp/src/auth.mjs:314`.

Risk:

Implementation gets to choose one of two bad defaults later: human tokens cannot
read restricted content even for local pi, or they accidentally default to local
trusted. Neither should be discovered during implementation by stepping on a
rake.

Required fix:

Define `read_egress_class` for every caller shape: stored service key, human
token, legacy admin, and internal operator/maintenance path. Default must be
`cloud_bound`. Local-trusted human sessions need an explicit local transport or
session binding. Legacy admin should be denied or forced cloud-bound on normal
MCP/HTTP routes.

### 6. MEDIUM/HIGH -- The proposal cites migration 011, but migration 015 is the live read-function source

The plane table names migration 011 as the active source for `match_thoughts`,
`match_thoughts_recency`, and `list_recent_thoughts`
(`docs/45-ob1-common-brain-access-proposal.md:83`). That is stale for
implementation purposes.

Runtime evidence:

- Migration 015 redefines `match_thoughts` and adds the conversation-record
  exclusion predicate in `local/open-brain-mcp/migrations/015_exclude_conversation_records_from_reads.sql:41`.
- Migration 015 redefines `match_thoughts_recency` with the same exclusion in
  `local/open-brain-mcp/migrations/015_exclude_conversation_records_from_reads.sql:88`.
- Migration 015 explicitly says stats still count those records in
  `local/open-brain-mcp/migrations/015_exclude_conversation_records_from_reads.sql:19`.

Risk:

If the tier-clamp migration copies the bodies from migration 011, it can
silently drop the migration 015 record-exclusion fix and resurrect the old
chat-export record pollution/leak. This is how "security migration" becomes
"undo previous production fix." Neat trick. Bad trick.

Required fix:

Base the new migration on the latest live function definitions, preferably from
`pg_get_functiondef` or migration 015, not migration 011. Preserve all existing
predicates: brain scope, tombstone exclusion, conversation-record exclusion,
metadata filter, dimension check, volatility/stability markings, and limit
placement. Add regression tests for both `restricted` exclusion and
conversation-record exclusion.

### 7. MEDIUM -- Query-string credentials remain accepted

The proposal focuses on credential custody but does not ban credentials in query
strings.

Runtime evidence:

- `authKey` accepts `?key=` before header keys in `local/open-brain-mcp/src/auth.mjs:35`.

Risk:

If a local-trusted key ever appears in a URL, it can land in shell history,
proxy logs, browser history, access logs, screenshots, or tool output. Then
custody is dead and we can all admire the corpse.

Required fix:

Reject query-string credentials for `local_trusted` immediately. Preferably
deprecate `?key=` entirely and require `Authorization: Bearer ...` or an
explicit access-key header. Add log redaction for all credential-shaped headers
and query params while the compatibility path exists.

### 8. MEDIUM -- "Log full error server-side" is still a private-derived artifact leak

The proposal says to sanitize caller-facing errors but "log the full message
server-side" (`docs/45-ob1-common-brain-access-proposal.md:131`). That is not
safe enough for restricted paths.

Runtime evidence:

- `requestJson` currently throws upstream URL, status, and response body in
  `local/open-brain-mcp/src/models.mjs:284`.
- `errorToolResult` relays `error.message` to MCP callers in
  `local/open-brain-mcp/src/server.mjs:194`.
- Retrieval telemetry stores truncated error text when `error` is passed in
  `local/open-brain-mcp/src/observability.mjs:136` and
  `local/open-brain-mcp/src/observability.mjs:200`.

Risk:

If an upstream local model or embedding service echoes prompt/evidence in an
error, the caller-facing path is one leak, but the server log/telemetry path is
another. Since the threat model treats same-user artifacts as relevant for
telemetry, logs do not get a magic exemption because they wear a little
server-side hat.

Required fix:

Use opaque error ids and structured categories. Do not store upstream body,
full URL, brain slug, tier, query text, or evidence snippets in agent-readable
logs/telemetry for restricted paths. If full diagnostics are needed, route them
to an operator-only sink outside the repo and outside cloud-harness reach, with
retention policy.

### 9. MEDIUM -- Tier values are unconstrained text

The proposal correctly calls out that `personal` has no real schema semantics
(`docs/45-ob1-common-brain-access-proposal.md:54`), but the same underlying
problem affects the whole tier model.

Runtime evidence:

- `sensitivity_tier` is plain text with default `standard` in
  `local/open-brain-mcp/migrations/006_lexical_search.sql:22`.
- The HTTP metadata patch schema accepts `standard`, `personal`, and
  `restricted` in `local/open-brain-mcp/src/server.mjs:87`.

Risk:

Unknown/typo tier values become fail-open unless every predicate is written
carefully. `restrictred`, `private`, `Restricted`, or a null-ish value can drift
into the corpus through direct SQL, import tooling, or future code. Text labels
as security controls. Very artisanal. Very breakable.

Required fix:

Add a DB constraint or enum before the tier becomes a security boundary. Decide
whether `personal` exists or maps to `restricted`, then enforce it in the
database and in every write path. The read clamp should fail closed on unknown
tier values.

## Minimum Acceptance Tests

These are the tests I would require before calling the design landed:

1. A cloud-bound key with editor access cannot change a thought from
   `restricted` to `standard`.
2. A restricted capture lands atomically as restricted and is never visible to
   cloud-bound `search_thoughts`, `list_thoughts`, `ask_brain`, `stats`, or HTTP
   equivalents.
3. A cloud-bound process with a clean env cannot obtain PG/Neo4j/Consul/source
   credentials by importing runtime config or running repo scripts.
4. The startup guard fails closed before any repo dotenv is loaded.
5. The new tier SQL preserves migration 015's conversation-record exclusion.
6. Graph projection either skips restricted/local-only rows or graph tools are
   provably unreachable by cloud-held credentials.
7. Human-token, service-key, legacy-admin, and maintenance callers each have an
   explicit `read_egress_class` behavior.
8. Query-string credentials are rejected for local-trusted access.
9. Upstream model/embedding errors never return or persist prompt/evidence text
   in caller output, telemetry, or agent-readable logs.

## Bottom Line

Claude stopped digging the original hole. Fine. But this proposal still leaves
the shovel sitting in two places: write-side declassification and repo-secret
autoload. Fix those, then the design becomes mostly normal engineering instead
of another séance with the access-control gods.
