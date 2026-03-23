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

The current development/local runtime is single-brain in three hard ways:

- authentication is one global access key
- `thoughts` is globally deduped by `dedupe_key`
- retrieval and graph expansion operate on the whole corpus unless explicitly filtered by metadata

That is fine for a single owner and local development.
It is wrong for a household-facing stable service.

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
- Fine-grained per-thought ACLs in v1
- Arbitrary team/workspace permissions
- Multi-host distributed tenancy
- Requiring a separate PostgreSQL database per household member
- Requiring a separate Neo4j database per household member in v1
- Directly changing Consul-managed infrastructure from this repo

## Product Position

This is a household multibrain system, not a cloud multi-tenant platform.

The intended model is:

- each person has a personal brain
- the family may also have a shared brain
- human users authenticate through Keycloak
- the public MCP/HTTP path is protected by Traefik forward-auth and oauth2-proxy
- the public household path terminates at a sysadmin-managed stable OB1 service running from `main`
- internal services and background jobs use OB1-managed service keys
- the active brain is resolved server-side and enforced server-side

The system should feel like:

- one OB1 service
- multiple private memory spaces
- optional shared family memory
- one family sign-in flow instead of many static user keys

## Operational Boundary

This repo owns:

- OB1 schema changes
- OB1 runtime changes
- OB1 integrations and importers
- OB1 documentation and handoff requirements

This repo does not own live changes to Consul-managed platform services such as:

- Traefik
- oauth2-proxy
- Keycloak
- other shared services registered in Consul

Any required changes to those services must be handed off to the sysadmin team.
The PRD may specify those dependencies, but implementation in this repo must not assume those changes can be applied here directly.

## Deployment Split

Use two OB1 runtimes:

- stable OB1 service
  - sysadmin-managed
  - runs from the `main` branch
  - intended public/household target
  - example fixed port: `8788`
- development OB1 runtime
  - user-managed
  - runs from the working tree via `devenv up open_brain_local`
  - intended for local development, testing, and verification only
  - current local port: `8787`

The public household-authenticated MCP route should target the stable service, not the development runtime.

Example split:

- stable/public:
  - `https://ob1.lincoln.luchoh.net/mcp`
  - `https://ob1.lincoln.luchoh.net/mcp/brains/:brain_slug`
- local/dev:
  - `http://localhost:8787`

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

### Identity Binding

An `identity binding` maps an external authenticated identity onto a principal.

The main v1 human identity source is:

- Keycloak token claims validated by OB1, especially stable `sub`

Service identities remain separate:

- Telegram bridge
- dictation importer
- future internal workers

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

### 3. Human users authenticate with validated Keycloak identity, not per-user static MCP keys

The current single `MCP_ACCESS_KEY` model becomes a split model:

- human users authenticate through the existing Keycloak -> oauth2-proxy -> Traefik path
- OB1 validates the forwarded Keycloak access token and resolves identity from token claims
- internal services and background jobs continue to use OB1-managed service keys
- one legacy bootstrap/admin key remains for local administration and migration

Human requests must resolve from trusted identity into:

- principal id
- household id
- allowed brain ids
- default brain id

Service-key requests must resolve into the same access context, but from a stored OB1 credential instead of Keycloak identity.

Reason:

- avoids one static MCP key per family member
- matches the auth stack already present on this machine
- keeps human auth in the identity provider, not in ad hoc shared secrets
- still preserves an internal key path for non-human workers

The authoritative human identity source is the validated token `sub`, not mutable username or email headers.

### 3a. MCP remains the protocol

Multitenancy does not replace MCP.

The design is:

- OB1 remains an MCP server
- human MCP access goes through an authenticated public MCP route
- services and local automation may continue to call the internal OB1 runtime directly with service/admin keys

In v1, human MCP sessions should still be effectively single-brain per connector/session.
The difference is:

- not one static key per brain
- instead, one authenticated user session with a connector or route that chooses the target brain context

Practical consequence:

- a user may still keep separate MCP connectors for `personal` and `shared household`
- but both connectors are authenticated by the same Keycloak user session, not two different long-lived secrets

Do not depend on MCP clients varying custom headers per tool call in v1.
If per-call brain switching is needed later, it should be implemented as an explicit OB1 feature, not assumed from client behavior.

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
- canonical ids remain stable within a brain-qualified namespace

Do not require per-brain Neo4j databases in v1.

Reason:

- lower operational burden
- easier migration of the current graph tooling
- preserves one graph runtime while still enforcing isolation

Concretely:

- Neo4j `canonical_id` values must be brain-qualified
- for example, a conversation node becomes conceptually:
  - `brain:<brain_id>:conversation:chatgpt:<conversation_id>`
- raw external identifiers such as chat conversation ids or document hashes remain separate node properties

This avoids accidental cross-brain merges when two brains import the same external source artifact.

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

#### `principal_identity_bindings`

- `id uuid primary key`
- `principal_id uuid not null references brain_principals(id)`
- `provider text not null`
- `subject text not null`
- `preferred_username text`
- `email text`
- `is_active boolean not null default true`
- `last_seen_at timestamptz`
- `created_at timestamptz`
- `updated_at timestamptz`

Uniqueness:

- `(provider, subject)`

Notes:

- v1 human provider is `keycloak`
- match should use stable subject first, with username/email as supporting attributes
- this is the main human-auth resolution path

#### `brain_access_keys`

- `id uuid primary key`
- `principal_id uuid not null references brain_principals(id)`
- `brain_id uuid references brains(id)`
- `key_hash text not null`
- `label text not null`
- `credential_type text not null`
- `is_active boolean not null default true`
- `is_admin boolean not null default false`
- `last_used_at timestamptz`
- `created_at timestamptz`
- `updated_at timestamptz`

Notes:

- store hashes, not plaintext keys
- plaintext keys are only shown at creation time
- human users should not normally use these keys directly
- normal service keys should be bound to exactly one brain when possible
- `credential_type` should distinguish:
  - `service`
  - `admin`
  - future migration/compat paths if needed

#### `principal_capture_routes`

- `id uuid primary key`
- `principal_id uuid not null references brain_principals(id)`
- `brain_id uuid not null references brains(id)`
- `channel text not null`
- `external_subject text not null`
- `created_at timestamptz`
- `updated_at timestamptz`

Uniqueness:

- `(channel, external_subject)`

Examples:

- `channel = 'telegram'`, `external_subject = '<telegram_user_id>'`
- future capture adapters can reuse the same pattern

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

Resolution should support two trusted auth sources.

### Human request path

1. request arrives through the trusted proxy path
2. OB1 reads a forwarded Keycloak access token from:
   - `X-Auth-Request-Access-Token`
   - or `Authorization: Bearer ...` if explicitly enabled later
3. OB1 validates that token as a JWT against the configured Keycloak issuer and JWKS set, and extracts:
   - `sub`
   - `preferred_username`
   - `email`
   - role/group claims if needed
4. OB1 resolves the Keycloak identity binding from `provider = keycloak` and `subject = sub`
5. OB1 loads memberships and default brain
6. if the route/session requests a specific allowed brain, use it
7. otherwise use the principal default brain

### Service/admin request path

1. validate the service or bootstrap/admin key
2. if it is the legacy bootstrap/admin key, mark `is_admin = true`
3. otherwise load the stored key, principal, and memberships
4. if the key is brain-bound, use that brain as `effective_brain_id`
5. only if the request is an admin/service path that supports explicit override:
   - resolve requested brain
   - verify it is allowed
6. apply `effective_brain_id` to all reads and writes

The runtime must never trust `X-Auth-Request-*` identity headers by themselves.
Those headers are advisory only unless accompanied by a valid Keycloak token that OB1 has verified.

The runtime must also remain on a non-public interface.
The public human path is:

- internet/client
- Traefik
- oauth2-proxy
- stable OB1 upstream on loopback or private-only bind

Do not expose the OB1 human-auth upstream directly on a public interface.
Do not point the public household route at the development runtime.

## API Changes

### Public Authenticated Route

Add a public OB1 route behind:

- Traefik
- oauth2-proxy
- Keycloak

Do not assume OB1 should reuse the existing dictation role policy.
Provision a dedicated OB1 Keycloak client and household-access role/group policy for this route.
This is a sysadmin-managed dependency, not a change this repo can apply by itself.
That public route should target the stable service instance, not the developer `devenv` process.

Expected forwarded identity inputs from the trusted proxy path:

- `X-Auth-Request-Access-Token` as the primary token source
- `X-Auth-Request-Preferred-Username`
- `X-Auth-Request-Email`
- `X-Auth-Request-User`
- `Authorization` only if explicitly enabled for a future direct bearer-token client path

The runtime should primarily bind humans by the validated Keycloak token `sub`, not by mutable forwarded username/email values and not by client-held static secrets.

Validation mode in v1:

- prefer standard JWT verification against Keycloak issuer metadata and JWKS
- do not require per-request token introspection for the first slice
- only accept tokens whose issuer, audience/client expectations, signature, and expiry checks pass

### Brain Selection

Brain selection should be explicit at the connector or route level, not hidden in arbitrary per-tool headers.

v1 acceptable shapes are:

- one public MCP route per brain context
- or one connector configuration per brain context
- or one default brain per user with an optional explicit server-supported override for non-MCP HTTP/admin flows

Do not assume per-tool header switching in v1.

The concrete v1 MCP route shape should be:

- `/mcp` -> principal default brain
- `/mcp/brains/:brain_slug` -> explicit requested brain for that connector

The server must resolve `:brain_slug` inside the authenticated principal's household and reject unauthorized access.
Do not silently fall back to the default brain when a requested slug is unknown or no longer authorized.

Expected failure behavior:

- `404` if the slug does not exist in the household
- `403` if the slug exists but the principal is not allowed to use it

### MCP Connection Model

For MCP specifically:

- OB1 still exposes MCP
- the human-facing MCP route is protected by Keycloak-authenticated proxying
- tool schemas do not gain `brain_id` or `brain_slug` parameters in the first slice
- users may connect to different brains by using different MCP connectors pointed at different MCP URLs
- those connectors should reuse the same human identity session rather than different static user keys

Practical compatibility note:

- not every MCP client will handle browser-style OAuth/proxy login equally well
- v1 should target app/browser-capable MCP clients or a household app/gateway that can complete the sign-in flow reliably
- direct raw-client OAuth support can be expanded later if needed

Examples:

- `OB1 Personal (Lucho)` -> `.../mcp/brains/lucho`
- `OB1 Shared Household` -> `.../mcp/brains/household`
- `OB1 Default` -> `.../mcp`

This keeps the MCP tool surface stable and avoids relying on client-specific per-call header tricks.
It also keeps MCP usable for the household model.

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
- projected non-thought nodes use brain-qualified canonical ids
- source and derived nodes connected to a thought remain scoped to that brain
- graph neighbor search, lineage, why-connected, and context expansion all constrain to the same brain

If a future shared artifact truly needs cross-brain linkage, it should be modeled explicitly later, not leaked implicitly in v1.

Interim safety rule:

- before graph scoping is implemented, graph-assisted retrieval and graph endpoints must be disabled for non-admin multitenant requests
- do not allow partially scoped graph behavior to ship

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

- wife's Keycloak-authenticated MCP session -> wife's personal brain
- household shared MCP session -> household shared brain
- Telegram bridge service key -> routed personal brain via capture routing

### Telegram Routing Decision

Telegram is the concrete v1 routing case and must be specified explicitly.

Use one household Telegram bot by default.

Routing model:

- the bridge reads `telegram_user_id`
- `telegram_user_id` resolves through `principal_capture_routes`
- that route maps to one principal and one target brain
- the default route for a family member is their personal brain

This avoids requiring one separate bot per household member.

Shared-household Telegram capture is not required in the first implementation slice.
If we add it later, it should be explicit, for example:

- a second shared bot
- or a deliberate share command / review action

It should not happen implicitly.

## Migration Strategy

### Phase 1: Foundation

- create `households`, `brains`, `brain_principals`, `brain_memberships`, `brain_access_keys`
- create `principal_identity_bindings`
- create one bootstrap household
- create one owner personal brain
- backfill all existing `thoughts` rows into that owner brain
- change dedupe uniqueness to `(brain_id, dedupe_key)`

### Phase 2: Runtime Auth Context

- add human identity resolution from trusted proxy headers
- keep legacy `MCP_ACCESS_KEY` as bootstrap admin key for migration and local admin calls
- retain OB1-managed service keys for background jobs and integrations
- add effective-brain resolution to all handlers
- support connector- or route-level brain targeting for authenticated human MCP use

### Phase 3: Graph Scoping

- add `brain_id` to graph projection state
- add `brain_id` to projected nodes
- brain-qualify canonical ids for non-thought nodes
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
- MCP users can continue with one connector initially, then add per-brain authenticated connectors as household access is introduced

## Security And Privacy Requirements

- cross-brain retrieval must be impossible without explicit authorization
- identical content across brains must not collide
- graph expansion must not leak another person's evidence
- access keys must be hashed at rest
- human identity must be derived from a validated Keycloak token, not bare forwarded headers
- the human-auth upstream must remain loopback-only or otherwise non-public behind the reverse proxy
- admin/bootstrap access should be limited and clearly documented

## Acceptance Criteria

- owner, spouse, and kid can each store memories into separate personal brains
- the shared household brain can be used explicitly
- default retrieval never crosses brain boundaries
- graph-assisted retrieval never crosses brain boundaries
- identical content can be stored in two brains without conflict
- Telegram and dictation captures can be targeted to a chosen brain
- household users can access MCP through Keycloak-authenticated identity without one static user key per person
- the existing single-user corpus is migrated safely into the owner brain

## First Implementation Slice

The first implementation slice should be:

1. migration-backed household/brain tables
2. `brain_id` on `thoughts`
3. scoped dedupe
4. trusted human identity resolution from the existing Keycloak/oauth2-proxy/Traefik path
5. service/admin key resolution for non-human callers
6. explicit MCP route-level brain selection via `/mcp` and `/mcp/brains/:brain_slug`
7. brain-scoped capture, search, ask, list, and stats
8. graph features disabled for non-admin multitenant requests until phase 3

Do not start with:

- full graph refactor
- importer-wide brain routing
- per-row sharing semantics

The storage and auth boundary must be correct first.

## External Service Dependencies

The following non-OB1 changes are expected to be sysadmin-owned if and when this PRD is implemented:

- a stable OB1 runtime running from `main`, separate from the developer runtime
- Traefik public route for OB1 human-authenticated MCP access
- oauth2-proxy policy for the OB1 route
- dedicated Keycloak client, redirect configuration, and household access role/group policy
- any Consul registration or routing changes needed for the public OB1 MCP route

These should be handled through a separate sysadmin handoff document when implementation begins.
