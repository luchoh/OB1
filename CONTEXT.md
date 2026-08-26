# OB1 Context

The personal-brain runtime: Postgres + pgvector storage, MCP server
exposing capture/search/ask, ingest pipelines for Telegram/dictation/
documents/email. Multi-tenant: multiple humans and (per ADR-0001)
multiple repo-scoped agents share the runtime through estates,
brains, principals, and memberships.

## Language

**Estate**:
A top-level container grouping principals and brains — either a human
grouping such as a household, or a fleet of repo-scoped agents. It is
the ownership boundary, and an enforced one: reaching into another
estate requires an explicit membership (ADR-0003).
_Avoid_: Household (the legacy word, still the column name), workspace,
tenant, account.

**Brain**:
A logical knowledge store: a set of thoughts, embeddings, and
metadata. Belongs to exactly one estate. Has zero or more principal
memberships granting access.
_Avoid_: Database (the brain is a logical view, not a Postgres database),
project, vault, workspace.

**Thought**:
A single captured note in a brain, with its content, its embedding and
whatever the enrichment pipeline has worked out about it.
_Avoid_: Note, memo, document, chunk, item.

**Principal**:
An identity that can hold access keys and memberships on brains.
Belongs to exactly one estate. Kinds in use: a person, a repo service,
the superseded per-repo agents from June 2026, and the minter (which
holds no memberships and reaches no data).
_Avoid_: User, account, identity, role.

**Repo principal**:
A principal named after a code repository. Every AI tool working in
that repo authenticates as this one identity — the workspace is the
identity, not the tool.
_Avoid_: Bot, service account, automation, workflow.

**Caged agent principal**:
The identity the caged agent uses to reach a person's personal brain.
There is one for the whole fleet, not one per repo. For ordinary repo
work the caged agent uses the repo principal like any other tool.
_Avoid_: pi principal (pi is the tool, this is the identity), common
principal.

**Brain membership**:
A grant of access to one specific brain for one principal. Roles are a
ladder: viewer reads, editor also writes, owner also deletes and
restores. A membership can instead be a DENY, which overrides any
estate-level grant. Purge sits outside the ladder and no role confers
it.
_Avoid_: Permission, ACL, grant.

**Estate membership** (ADR-0001):
A grant of access to every brain in an estate, for one principal.
Roles: member reads, admin also writes, deletes and restores. Always
overridden by a brain-level DENY. There is no such thing as an
estate-level DENY — absence is denial.

**Personal brain**:
The brain holding one person's own thoughts. It lives in that person's
estate, not the agent estate, so an agent reaches it only through an
explicit membership — never automatically.
_Avoid_: Common brain (retired, see below), private brain, owner brain.

**Access policy**:
The rules deciding what a principal may do: which brains it can reach,
which it can name, and which of read, write, delete, restore and purge
are allowed. It only decides — looking facts up and speaking HTTP are
someone else's job.
_Avoid_: Authz (vague), ACL, permissions (the rows are memberships; the
rules are the policy).

**Access key**:
A credential identifying a principal. It says who you are and which
brain to use by default — it never limits what you may do. Capability
comes from membership roles, reach from memberships and estates. The
legacy shared key is the one exception, and it is being retired.
_Avoid_: Token (overloaded with human JWTs), API key.

**Capture**:
The act of writing a thought. The caller may name a brain; otherwise it
lands in the principal's default brain.

**Default brain**:
The brain a capture lands in when the caller does not name one. For a
repo principal, that is its repo's brain.

**Revision**:
The prior state of a thought, kept when that thought is changed in
place. Deleting or restoring a thought is not a revision — those change
whether it exists, not what it says.
_Avoid_: Version, history, snapshot, backup.

**Writer**:
The principal a thought belongs to.
_Avoid_: Owner (that is a membership role), author (ambiguous — see the
note under Relationships).

**Audit actor**:
The principal that made one particular change. Every change must name
one, and a change that cannot is refused rather than recorded
anonymously (ADR-0009).
_Avoid_: Author (ambiguous), user, caller.

**Author session**:
An identifier for a single run of a single writer, stamped on each
write — one execution, not a durable identity.

**Projection / Projector**:
The graph in Neo4j is a projection: a derived, rebuildable view of the
thoughts in Postgres, reshaped into nodes and edges for
relationship-flavoured retrieval. The projector is the background loop
that keeps it current. Postgres is always the source of truth, and the
graph can always be rebuilt from it.
_Avoid_: Sync (hides that it is one-way and derived), index, mirror.

**Enriched / Enrichment**:
A thought is enriched once an LLM has worked out what kind of thing it
is and how much it matters, and recorded that alongside it.
_Avoid_: Tagged, classified (overloaded), labeled.

**Distilled vs source**:
Distilled content is an LLM summary written for retrieval; source
content is the raw original, kept for provenance. Search prefers
distilled and falls back to source.
_Avoid_: Original, processed, refined.

**Stuck message**:
An inbound item an ingest daemon has failed to process and keeps
retrying — recorded with its stage, error and attempt count, backed off,
and listed. Stuck is a description, not a verdict: nothing about it says
whose fault the failure is, and a daemon is not entitled to decide
(ADR-0010).
_Avoid_: Failed (ambiguous between the attempt and the message), poisoned,
bad message.

**Given up**:
An operator's decision to stop retrying a stuck message. Deliberately a
human, slightly uncomfortable word: only a person sets it, and it can be
undone. Nothing infers it — not an attempt count, not an error type, not
silence in reply to a notification.
_Avoid_: Dead-lettered, quarantined, retired (all imply the system sorted
it on its own authority — the exact claim this word denies).

## Relationships

- An **Estate** contains many **Brains** and many **Principals**.
- A **Stuck message** may be **Given up** on — by a person, never by the
  daemon that is stuck on it.
- A **Brain** contains many **Thoughts**.
- A **Brain** has many **Brain memberships**, each naming a
  **Principal** — which may belong to a different estate.
- An **Estate** has many **Estate memberships**, likewise.
- A **Thought** has a **Writer** (whose thought it is), every change to
  it has an **Audit actor** (who made that change), and every write
  records an **Author session** (which run did it). Three different
  questions. When one principal overwrites another's thought the writer
  changes and the audit actor says who changed it — which is the case
  the distinction exists for. "Author" on its own is ambiguous between
  all three; avoid it.

## Flagged ambiguities

- Egress vocabulary is missing entirely. `read_egress_class`,
  `cloud_bound`, `local_trusted` and `private_local` are the axis the
  access model turns on (docs/48, docs/49, ADR-0006) and none of them is
  defined here. Noticed 2026-08-25 while deciding whether email subjects
  may cross to Telegram — a question the glossary could not help answer.
- "household" vs "estate" — schema still says `household` everywhere;
  language is moving to "estate" per ADR-0001. Rename pending.
- "common brain" — RETIRED 2026-08-23. ADR-0001 forecast a brain in the
  agent estate with memberships for every repo principal, as a
  cross-cutting agent scratchpad; it was built as `common-public` and
  then dropped without ever being used. What replaced it is narrower and
  differently shaped: one agent (pi) reaching the human's **personal
  brain** by a single cross-estate membership. Do not revive the word for
  that — it is common to nobody.
- "shared" vs "common" — `brains.kind = 'shared_household'` remains the
  legacy term for cross-principal-within-an-estate access. Unrelated to
  the retired "common brain".
