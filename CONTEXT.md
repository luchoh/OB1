# OB1 Context

The personal-brain runtime: Postgres + pgvector storage, MCP server
exposing capture/search/ask, ingest pipelines for Telegram/dictation/
documents/email. Multi-tenant: multiple humans and (per ADR-0001)
multiple repo-scoped agents share the runtime through estates,
brains, principals, and memberships.

## Language

**Estate**:
A top-level container that groups principals and brains. Models
either a human grouping (a household, a family) or a non-human
grouping (a fleet of repo-scoped agents). Ownership / governance
boundary — and an enforced one: cross-estate reach is membership-
granted, never ambient (ADR-0003). No key shape except the legacy
admin env key sees past an estate without an explicit membership row.
_Avoid_: Household (legacy term, schema column is still `household_id`
until rename), workspace, tenant, account.

**Brain**:
A logical knowledge store: a set of thoughts, embeddings, and
metadata. Belongs to exactly one estate. Has zero or more principal
memberships granting access.
_Avoid_: Database (the brain is a logical view, not a Postgres database),
project, vault, workspace.

**Thought**:
A single captured note in a brain. Has content, embedding, metadata,
optional structured columns (type, source_type, sensitivity_tier,
importance, quality_score, enriched, status). Lives in `thoughts`,
scoped to a brain via `brain_id`.
_Avoid_: Note, memo, document, chunk, item.

**Principal**:
An identity that can hold access keys and memberships on brains.
Belongs to exactly one estate. `principal_type` is one of `person`
(today's only value) or `agent` (per ADR-0001).
_Avoid_: User, account, identity, role.

**Repo principal**:
A principal of `principal_type='agent'` whose slug matches a code
repository's name (e.g., `ob1`, `system-config`). All AI tools
running in that repo authenticate as this single principal. The
workspace is the identity, not the tool.
_Avoid_: Bot, service account, automation, workflow.

**Brain membership**:
A row granting one principal access to one brain (`brain_memberships`
table). Specific access. With ADR-0001, brain memberships also support
DENY rows that override estate memberships. Roles form a monotone
ladder: `viewer` (read) ⊂ `editor` (read + write) ⊂ `owner` (read +
write + delete/restore). Purge is outside the ladder entirely — it
requires a named admin service key, never a role.
_Avoid_: Permission, ACL, grant.

**Estate membership** (ADR-0001, migration 009):
A row granting one principal access to **all brains in an estate**
(`estate_memberships` table). Broad access. Subject to brain-level
DENY override. A row with `is_deny=true` is treated as **absent
membership** (fail-closed): estate-level DENY is not a granted
semantic — per ADR-0001, absence is denial — and the column exists
only for schema parity. (Migration 009's comment says the flag is
"not consulted"; the resolver does consult it, with exactly this
absent-membership meaning.) Roles: `member` (read all estate brains)
⊂ `admin` (read + write + delete/restore on all estate brains),
always subject to brain-level DENY override.

**Common brain** (forthcoming, ADR-0001):
A specific brain in the agent estate, with brain memberships granted
to every repo principal. The "shared knowledge" destination for
cross-cutting agent observations.
_Avoid_: Global brain (suggests no estate ownership; common brain
does live in an estate), shared brain (overlaps with `kind='shared_household'`).

**Access policy**:
The pure rules deciding what a principal may do: which brains are in
scope, which are nameable (and whether a failed naming reads as
not-found, denied, or ambiguous), and which actions — read, write,
delete, restore, purge — are allowed. Inputs: brain memberships,
estate memberships, the role ladder (ADR-0002), estate reach
(ADR-0003), and caller shape. Pure decision; fetching facts and
speaking HTTP are adapters' jobs.
_Avoid_: Authz (vague), ACL, permissions (the rows are memberships;
the rules are the policy).

**Access key**:
A credential identifying a principal (`brain_access_keys`, hashed).
A key is identity plus a default-brain hint — never a permission
clamp: capability comes from membership roles (ADR-0002), reach from
memberships and estates (ADR-0003). The bare legacy env key is the
one exception (global admin, unattributable, documented blast
radius) pending retirement.
_Avoid_: Token (overloaded with human JWTs), API key.

**Capture**:
The act of writing a thought. Today: ingest path goes through
`capture_thought` MCP tool or Telegram bridge → MCP `/ingest/thought`
→ Postgres. Per ADR-0001, capture will accept an explicit `brain`
parameter (default = principal's default brain).

**Default brain**:
A column on `brain_principals` (`default_brain_id`). The brain that
receives a capture if the caller does not specify one. For repo
principals: the repo brain.

**Author session**:
A free-form identifier (`metadata.author_session_id`) stamped on
each write to identify *which run of which writer* produced it (e.g.,
`telegram_bridge:<chat>:<msg>`, `claude_code:<session_uuid>`,
`mcp:<conn_id>`). Per ADR-27, every audit row copies this. Distinct
from the principal — a principal is durable identity, an author
session is a single execution.

**Projection / Projector**:
The graph in Neo4j is a *projection*: a derived, rebuildable copy of
the canonical Thoughts in Postgres, reshaped into nodes and edges
(Thought ↔ Conversation / Email / Document / Concept / Person / …)
for relationship-flavored retrieval. The *projector* is the runtime's
background loop that keeps it in sync: each tick it scans for new or
changed Thoughts (per-thought revision bookkeeping), turns each into a
plan via the pure projection planner, and applies the plan to Neo4j —
tombstones project as node deletions, restores re-project. Postgres is
always the source of truth; the graph trails capture by roughly one
tick and can always be rebuilt.
_Avoid_: Sync (hides the one-way, derived nature), index, mirror.

**Enriched / Enrichment**:
A boolean column on `thoughts` and the verb form. A thought is
"enriched" when an LLM has classified it into the structured columns
(`type`, `importance`, `source_type`, plus a metadata bundle). The
enrichment pipeline lives in `scripts/thought_enrichment/`.
_Avoid_: Tagged, classified (overloaded), labeled.

**Distilled vs source**:
A `metadata.retrieval_role` value. `distilled` = LLM-summarized
content fit for retrieval. `source` = raw source content (email body,
document chunk) preserved for provenance. Search prefers `distilled`
and falls back to `source` only when distilled doesn't yield enough.
_Avoid_: Original, processed, refined.

## Relationships

- An **Estate** contains many **Brains** (FK `brains.household_id`,
  to be renamed `estate_id`).
- An **Estate** contains many **Principals** (FK
  `brain_principals.household_id`, to be renamed).
- A **Brain** has many **Brain memberships**, each pointing at a
  **Principal**. A principal can be from a different estate than the
  brain (cross-estate access).
- An **Estate** has many **Estate memberships** (per ADR-0001), each
  pointing at a **Principal** (possibly from another estate).
- A **Brain** contains many **Thoughts**.
- A **Thought** has one author at write time, recorded as
  `metadata.author_session_id` (string, not a FK).

## Flagged ambiguities

- "household" vs "estate" — schema still says `household` everywhere;
  language is moving to "estate" per ADR-0001. Rename pending.
- "shared" vs "common" — `brains.kind = 'shared_household'` is the
  legacy term for cross-principal-within-an-estate access. The new
  "common brain" is a brain in the agent estate with explicit
  cross-principal memberships. Different mechanism, similar intent.
