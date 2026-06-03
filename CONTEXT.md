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
boundary.
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
DENY rows that override estate memberships.
_Avoid_: Permission, ACL, grant.

**Estate membership** (forthcoming, ADR-0001):
A row granting one principal access to **all brains in an estate**
(`estate_memberships`, new table). Broad access. Subject to brain-
level DENY override.

**Common brain** (forthcoming, ADR-0001):
A specific brain in the agent estate, with brain memberships granted
to every repo principal. The "shared knowledge" destination for
cross-cutting agent observations.
_Avoid_: Global brain (suggests no estate ownership; common brain
does live in an estate), shared brain (overlaps with `kind='shared_household'`).

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
