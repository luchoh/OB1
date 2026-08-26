---
status: proposed
date: 2026-08-25
---

# The agent brain is read-wide and write-gated

OB1 names its three agent-facing knowledge scopes **Repo brain**, **Agent
brain**, and **Personal brain**. A repo brain is working memory for one
repository; the agent brain is curated cross-repository knowledge; a personal
brain contains one person's own thoughts.

The proposed topology would let every repo principal read the agent brain while
granting no agent principal direct write access. Agents would submit immutable
publication proposals containing the exact content and its hash; only an
operator approval bound to both could publish one.

## Status and implementation

This topology is **not implemented or accepted**. Repo principals currently have
no viewer membership on an agent brain, a legacy agent credential remains editor
on the `agent-common` storage slug, and no publication-proposal or approval path
exists. Credential custody must be resolved before this proposal advances.

Acceptance would also require explicit reconciliation with ADR-0001's shared
agent-write model and system-config ADR-0004's pi-only common-key model. This ADR
does not supersede either decision while it remains proposed.

## Considered options

- **Common brain** was rejected because it had already named incompatible
  designs and falsely suggests that the personal brain is commonly accessible.
- **Published brain** describes state but not audience; **Agent brain** names
  who consumes it while the publication gate states how content enters it.
- Direct agent write access was rejected because it makes review advisory.
  Viewer membership plus a separate proposal workflow makes the boundary
  structural.

## Consequences if accepted

- Every repo principal would be a viewer of the agent brain and an editor or
  owner of its repo brain.
- Publication would be an operator action, not a role granted to an agent
  credential.
- Existing `agent-common` and `common-public` names would remain legacy storage
  identifiers, not canonical domain terms.
