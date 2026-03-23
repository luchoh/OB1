# PRD: OB1 Local Household Multitenancy

Date: 2026-03-22
Status: Proposed
Owner: Platform / Runtime / Retrieval

## Summary

Extend Open Brain Local from a single-brain local service into a household-capable system that can serve multiple people from one deployment.

The target use case is not SaaS multitenancy.
It is one local OB1 instance that can support:

- one personal brain for the primary owner
- one personal brain for a spouse
- one personal brain for a child
- optionally one shared household brain

without mixing memories, retrieval results, graph context, or capture imports across those boundaries by accident.

## Problem

The current local runtime is single-brain in three hard ways:

- authentication is one global access key
- `thoughts` is globally deduped by `dedupe_key`
- retrieval and graph expansion operate on the whole corpus unless explicitly filtered by metadata

That is fine for a single owner.
It is wrong for a household.

If multiple family members use the same OB1 deployment today:

- one person can retrieve another person's memories
- identical content across people collides at ingest time
- graph expansion can cross personal boundaries
- capture integrations have no first-class tenant target

So "let my wife and kid use OB1 too" is not just an auth problem.
It is a storage, retrieval, graph, and capture-isolation problem.

## Goals

- Support multiple household members on one local OB1 deployment.
- Give each member a separate personal brain by default.
- Support one optional shared household brain for family-wide memory.
- Keep retrieval, graph expansion, and stats scoped to the active brain by default.
- Preserve compatibility with the current local runtime and importer shape where practical.
- Allow migration of the existing single-owner corpus into the new model without data loss.
- Keep the design local-first and operationally simple.

## Non-Goals

- Full SaaS user management
- OAuth or hosted identity providers
- Fine-grained per-thought ACLs in v1
- Arbitrary team/workspace permissions
- Multi-host distributed tenancy
- Requiring a separate PostgreSQL database per household member
- Requiring a separate Neo4j database per household member in v1

## Product Position

This is a household multibrain system, not a cloud multi-tenant platform.

The intended model is:

- each person has a personal brain
- the family may also have a shared brain
- clients authenticate with a local access key
- the active brain is resolved locally and enforced server-side

The system should feel like:

- one OB1 service
- multiple private memory spaces
- optional shared family memory

## User Model

### Brain

A `brain` is the main isolation boundary.

Each brain has:

- stable id
- slug
- display name
- kind
- household id

Initial brain kinds:

- `personal`
- `shared_household`

### Principal

A `principal` is the actor authenticating to OB1.

Examples:

- Lucho
- spouse
- kid
- Telegram capture bridge for the shared household brain

A principal may have:

- one default personal brain
- access to additional brains, such as the shared household brain

### Household

A `household` groups brains and principals that belong to the same family deployment.

In v1, one OB1 instance is expected to serve one household, but the schema should still model `household` explicitly so the data model is not trapped in a hidden singleton assumption.

## Core Decisions

### 1. `brain_id` is the storage and retrieval boundary

This is the main design choice.

Do not try to infer tenant boundaries only from metadata.

Add a first-class `brain_id` to:

- `thoughts`
- graph projection state
- any future source-tracking tables that need direct ownership

Reason:

- retrieval must be brain-scoped by default
- dedupe must be brain-local, not global
- graph projection and stats must know which brain owns a row

### 2. Keep one shared PostgreSQL database

Use one PostgreSQL database with brain-scoped rows, not one Postgres database per family member.

Reason:

- simpler operations
- easier migration from the current single-brain design
- easier reuse of current importer/runtime code
- easier future shared-brain workflows

### 3. Use server-side access-key resolution, not client-trusted brain ids

The current single `MCP_ACCESS_KEY` model becomes:

- one bootstrap/admin key for local administration and migration
- one or more principal access keys stored in OB1 metadata tables

Requests must authenticate with an access key that resolves to:

- principal id
- allowed brain ids
- default brain id

The client may request a specific target brain only if the principal is authorized for it.

Reason:

- prevents trivial cross-brain spoofing
- allows shared-household access without full external auth

### 4. Shared household memory is a separate brain, not a flag on personal rows

Do not mix "shared" memories into personal brains through row-level sharing flags in v1.

Instead:

- each person has a personal brain
- household-shared memory goes into a distinct shared brain

Reason:

- simpler semantics
- simpler retrieval defaults
- easier explanation to users
- avoids per-row ACL complexity

### 5. Graph projection stays in one Neo4j database in v1, but must be brain-aware

Use one graph database in v1 and make all graph projection and traversal brain-scoped.

That means:

- each projected node carries `brain_id`
- graph queries constrain expansion to the active brain
- canonical ids and projection state remain stable

Do not require per-brain Neo4j databases in v1.

Reason:

- lower operational burden
- easier migration of the current graph tooling
- preserves one graph runtime while still enforcing isolation

## Data Model

### New Tables

#### `households`

- `id uuid primary key`
- `slug text unique not null`
- `display_name text not null`
- `created_at timestamptz`
- `updated_at timestamptz`

#### `brains`

- `id uuid primary key`
- `household_id uuid not null references households(id)`
- `slug text not null`
- `display_name text not null`
- `kind text not null`
- `is_default_shared boolean not null default false`
- `created_at timestamptz`
- `updated_at timestamptz`

Uniqueness:

- `(household_id, slug)`

#### `brain_principals`

- `id uuid primary key`
- `household_id uuid not null references households(id)`
- `slug text not null`
- `display_name text not null`
- `principal_type text not null`
- `default_brain_id uuid references brains(id)`
- `created_at timestamptz`
- `updated_at timestamptz`

Examples of `principal_type`:

- `person`
- `service`

#### `brain_memberships`

- `principal_id uuid not null references brain_principals(id)`
- `brain_id uuid not null references brains(id)`
- `role text not null`
- `created_at timestamptz`
- primary key `(principal_id, brain_id)`

Initial roles:

- `owner`
- `member`
- `capture_agent`

#### `brain_access_keys`

- `id uuid primary key`
- `principal_id uuid not null references brain_principals(id)`
- `key_hash text not null`
- `label text not null`
- `is_active boolean not null default true`
- `last_used_at timestamptz`
- `created_at timestamptz`
- `updated_at timestamptz`

Notes:

- store hashes, not plaintext keys
- plaintext keys are only shown at creation time

### Changes To Existing Tables

#### `thoughts`

Add:

- `brain_id uuid not null references brains(id)`

Change uniqueness:

- replace global `thoughts_dedupe_key_idx`
- with `(brain_id, dedupe_key)` unique

Keep `content_hash` non-unique across the whole table.

Reason:

- two family members may legitimately store the same content
- one person's import must not suppress another person's memory

#### `thought_graph_projection_state`

Add:

- `brain_id uuid not null references brains(id)`

Reason:

- projection bookkeeping should not depend on joining `thoughts` just to learn scope
- graph jobs and audits need direct brain context

## Request Resolution Model

Every authenticated request resolves to an `access context`:

- `principal_id`
- `household_id`
- `default_brain_id`
- `allowed_brain_ids`
- `requested_brain_id`
- `effective_brain_id`
- `is_admin`

Resolution order:

1. validate the access key
2. load principal and memberships
3. if request explicitly asks for a brain, verify membership
4. otherwise use principal default brain
5. apply `effective_brain_id` to all reads and writes

## API Changes

### New Headers / Query Parameters

Add optional request brain selection:

- `x-brain-slug`
- or `brain` query parameter

These are optional.

If omitted:

- use the principal default brain

If provided:

- resolve the slug inside the principal's household
- reject if not allowed

### Existing Endpoints

All existing endpoints remain, but become brain-scoped:

- `/ingest/thought`
- `/ask`
- `/admin/thought/metadata`
- `/admin/thought/similar`
- graph endpoints
- MCP tools

The API contract should remain stable from the client point of view, but results and writes must use the effective brain context automatically.

## Retrieval And Answering

Retrieval must apply `brain_id = effective_brain_id` before:

- vector search
- recent-list queries
- stats
- duplicate review
- graph-assisted retrieval

Answer synthesis must only see evidence from the active brain.

This is a hard requirement, not a best-effort filter.

## Graph Requirements

Graph projection must preserve brain boundaries.

Requirements:

- projected thought nodes carry `brain_id`
- source and derived nodes connected to a thought remain scoped to that brain
- graph neighbor search, lineage, why-connected, and context expansion all constrain to the same brain

If a future shared artifact truly needs cross-brain linkage, it should be modeled explicitly later, not leaked implicitly in v1.

## Capture And Import Requirements

All capture paths must resolve a brain explicitly or by principal default.

This includes:

- manual thought capture
- Telegram text capture
- Telegram-origin dictation
- ChatGPT import
- Claude import
- email import
- document import

Service principals are valid principals.

Examples:

- wife's Telegram bot key -> wife's personal brain
- shared household Telegram bot key -> household shared brain

## Migration Strategy

### Phase 1: Foundation

- create `households`, `brains`, `brain_principals`, `brain_memberships`, `brain_access_keys`
- create one bootstrap household
- create one owner personal brain
- backfill all existing `thoughts` rows into that owner brain
- change dedupe uniqueness to `(brain_id, dedupe_key)`

### Phase 2: Runtime Auth Context

- replace single-key check with access-key lookup
- keep legacy `MCP_ACCESS_KEY` as bootstrap admin key for migration and local admin calls
- add effective-brain resolution to all handlers

### Phase 3: Graph Scoping

- add `brain_id` to graph projection state
- add `brain_id` to projected nodes
- constrain graph traversal by effective brain

### Phase 4: Capture Integration Wiring

- make Telegram and dictation worker credentials brain-aware
- add explicit service principals for family capture paths where needed

## Backward Compatibility

The current single-user setup must continue to work after migration.

That means:

- existing `MCP_ACCESS_KEY` still works as admin/bootstrap access
- existing thoughts remain retrievable under the migrated owner brain
- existing integrations can keep working while being gradually reassigned to service principals

## Security And Privacy Requirements

- cross-brain retrieval must be impossible without explicit authorization
- identical content across brains must not collide
- graph expansion must not leak another person's evidence
- access keys must be hashed at rest
- admin/bootstrap access should be limited and clearly documented

## Acceptance Criteria

- owner, spouse, and kid can each store memories into separate personal brains
- the shared household brain can be used explicitly
- default retrieval never crosses brain boundaries
- graph-assisted retrieval never crosses brain boundaries
- identical content can be stored in two brains without conflict
- Telegram and dictation captures can be targeted to a chosen brain
- the existing single-user corpus is migrated safely into the owner brain

## First Implementation Slice

The first implementation slice should be:

1. migration-backed household/brain tables
2. `brain_id` on `thoughts`
3. scoped dedupe
4. access-key resolution with default-brain enforcement
5. brain-scoped capture, search, ask, list, and stats

Do not start with:

- full graph refactor
- importer-wide brain routing
- per-row sharing semantics

The storage and auth boundary must be correct first.
