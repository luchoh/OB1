# 55 — Agent Brain with Approved Publication

**Date:** 2026-08-25  
**Status:** RESEARCH / DESIGN RECOMMENDATION — not approved, not implemented

## Answer

The requested design does **not** currently exist as one accepted, coherent OB1
design. The repo contains most of its parts, plus two older proposals that nearly
describe it. The live domain model and accepted ADR now point elsewhere:
`common-public` was dropped without use, and only the caged agent retains a
designed shared-brain path (`CONTEXT.md:197-204`; `docs/adr/0006-caged-agent-is-more-trusted-not-less.md:14-24`).

Proposed ADR-0012 names the clean design an **Agent brain plus a proposal
ledger**:

- every repo principal is `viewer` on the Agent brain;
- no agent principal is `editor` or `owner` there;
- agents can submit immutable publication proposals through a narrow tool, but
  cannot call the Agent brain's write path;
- only an operator approval, bound to the exact proposal and approved content,
  inserts into the Agent brain.

That gives all agents read-only access while keeping publication behind the
operator. Yes, this is boring access control plus workflow state. That is a
feature.

## What already exists

| Piece | State | Evidence |
|---|---|---|
| Read-only membership | Implemented. `viewer` can read but not write; `editor` adds write. | `CONTEXT.md:62-68`; `local/open-brain-mcp/src/access-policy.mjs:162-180` |
| Principal-scoped reach | Implemented. Membership belongs to a principal, while a key identifies that principal and only hints the default brain. | `local/open-brain-mcp/migrations/005_household_multitenancy.sql:54-60,83-95`; `CONTEXT.md:95-100` |
| Cloud-readable vs local-only brain classes | Implemented in schema and scope derivation. `repo`/`public` remain visible to cloud-bound callers; local-only classes are excluded under enforcement. | `local/open-brain-mcp/migrations/016_egress_boundary_columns.sql:49-67`; `local/open-brain-mcp/src/access-policy.mjs:315-370` |
| One shared-agent-brain marker | Implemented, schema-only. It permits at most one marked brain per estate and creates none automatically. | `local/open-brain-mcp/migrations/020_shared_agent_brain.sql:19-40` |
| Human choice when creating a shared brain | Implemented, but for a different topology. The script creates a cloud-readable brain after confirmation, gives people `owner`, and says every pi key gets read-write. | `local/open-brain-mcp/scripts/create-shared-agent-brain.mjs:138-159,190-215,247-252` |
| Per-repo common key | Implemented for pi only, as `editor` on the shared brain and nothing else. | `local/open-brain-mcp/src/repo-key-minting.mjs:549-556,607-639`; `docs/adr/0006-caged-agent-is-more-trusted-not-less.md:18-24` |
| Provenance-preserving explicit promotion | Proposed in the old Scribe PRD. | `docs/44-ob1-reflexive-capture-and-veil-prd.md:49-56` |
| Submit-only agents plus out-of-band operator approval | Proposed, explicitly unvalidated and never endorsed. | `docs/46-ob1-common-brain-access-design-and-postmortem.md:73-79,104-126` |
| Approval authority separated from read trust | Frozen design baseline. Approval requires an operation-specific capability and human confirmation bound to the exact operation and target. | `docs/45-ob1-common-brain-access-proposal.md:124-128` |

## What does not exist

There is no publication proposal table or queue, no `propose_shared_thought`
tool, no operator `approve_shared_thought` tool, and no approval audit linking a
proposal to its published thought. The current server explicitly leaves tier
transitions for a later dedicated capability, while the registered operator
surface covers minting and inventory, not publication review
(`local/open-brain-mcp/src/server.mjs:97-105,1431-1537`).

The current shared-brain implementation is therefore unsuitable without changes:

1. It grants pi `editor`, not all agents `viewer`
   (`local/open-brain-mcp/src/repo-key-minting.mjs:607-639`).
2. Generic capture is an upsert, so exposing it as a submission mechanism also
   exposes mutation semantics. The frozen design already identifies that trap
   (`docs/45-ob1-common-brain-access-proposal.md:157-168`).
3. The accepted vocabulary says the old cross-agent `common-public` brain was
   retired and dropped. Reusing that name would quietly resurrect a dead design
   (`CONTEXT.md:197-204`).
4. Current repo-key minting treats any membership outside the one repo brain as
   a dangerous inherited scope and refuses mint/rotate. Supported viewer fan-out
   therefore requires changing this confinement rule, not merely inserting
   membership rows by hand
   (`local/open-brain-mcp/src/repo-key-minting.mjs:208-283`).

## Recommended architecture

### 1. Agent brain

Create one new estate brain, provisionally `agent-published`, with:

- `egress_class = 'repo'` because cloud agents will read it;
- only `standard` thoughts, consistent with the v1 invariant that restricted
  thoughts stay in local-only brains
  (`docs/45-ob1-common-brain-access-proposal.md:420-424`);
- human operator principal as `owner`;
- every `repo-service:<slug>` principal as `viewer`;
- no agent principal with `editor` or `owner`.

Add an explicit `is_agent_publication_brain` marker rather than reusing
`is_shared_agent_brain`. The latter is coupled to `mint_agent_key`, whose purpose
is to grant pi write access. One boolean doing two opposite jobs would be the
usual economy where everything costs twice.

Provisioning must add `viewer` membership when a repo principal is minted and
backfill existing repo principals. It must also explicitly allow the publication
brain as the sole second membership in the repo-principal confinement check.
Because all tools in a repo share its repo principal, one membership makes the
Agent brain readable by Claude, Codex, and pi without per-tool identity
machinery (`CONTEXT.md:38-47`). Existing unscoped reads already fan out across
all accessible brains (`local/open-brain-mcp/src/access-policy.mjs:710-749`).

### 2. Immutable proposal ledger

Add `shared_thought_proposals`, separate from `thoughts`. Minimum fields:

- proposal id and idempotency key;
- proposed content and metadata snapshot plus content hash;
- source brain/thought id when promoting an existing thought;
- proposing principal, access key, and author session;
- `pending | approved | rejected | withdrawn` state;
- deciding operator, executing service principal, human-confirmation id, reason,
  and decision timestamps;
- published thought id after approval.

Agents receive only `propose_shared_thought`. It inserts a new immutable pending
row. It cannot edit a proposal, approve one, or write the Agent brain. If a
source thought is referenced, the server verifies the proposer can read it and
stores the exact proposed snapshot; approval must not chase a later-mutated
source row.

### 3. Operator review and atomic publication

Expose review through a credential/channel absent from agent environments. A
browser passkey/WebAuthn or Touch ID-backed local approval surface fits the
existing requirement better than a shell `--yes` prompt an agent can invoke.
The earlier design correctly requires an operator-only channel and display of
the proposed content plus taint/provenance before approval
(`docs/46-ob1-common-brain-access-design-and-postmortem.md:120-126`).

Approval must be one transaction:

1. lock the pending proposal;
2. verify operator capability and confirmation bound to proposal id + content
   hash + target brain;
3. insert the exact approved snapshot into `agent-published` using an internal
   operator path;
4. record the operator as decision actor, the service principal as execution
   actor, preserve source provenance, and mark the proposal approved;
5. make retries idempotent and refuse a second publication.

Rejection records the decision but publishes nothing. Editing content creates a
new proposal/hash and requires a new approval. Approval is not a magic wand that
retroactively approves whatever bytes happen to be nearby.

### 4. Read behavior

Existing named and fan-out reads can serve the Agent brain through ordinary
membership scope. Search results should expose safe provenance: proposer repo,
approval timestamp, reviewer identity or operator role, and source linkage when
the caller may see it. They must not reveal inaccessible source-brain content or
private review artifacts.

## State gap and implementation boundary

No new role is required. The existing `viewer` role is sufficient for the
Agent brain. What is missing is the workflow boundary:

- schema for proposals and publication audit;
- a submit-only tool that is not generic brain write access;
- operator-only review/list/approve/reject tools;
- exact-target human confirmation;
- atomic publish and immutable provenance;
- provisioning/backfill of viewer memberships;
- negative tests proving every agent credential can read but none can capture,
  patch, delete, restore, approve, or bypass the queue.

ADR-0012 records this topology as a proposal. It does not supersede ADR-0001,
ADR-0006, or system-config ADR-0004 unless the operator later accepts the access
model and those cross-repo decisions are reconciled explicitly. The vocabulary
— **Repo brain**, **Agent brain**, **Personal brain**, and **Publication
proposal** — is canonical independently of that unresolved topology.
