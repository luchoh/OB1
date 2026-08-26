# 56 — Agent Brain Custody and Approved Publication Plan

**Date:** 2026-08-26

**Status:** IMPLEMENTATION PLAN — production changes not started

## Outcome and order

Implement in this order:

1. Audit and preserve critical operator authority.
2. Establish repo-agent credential custody on M2, then M4.
3. Implement classified publication into `agent-published`.
4. Accept ADR-0012 only after production proof.
5. Design the cross-repo message broker as a separate project.

Each phase is gated by its completion criteria. A later phase does not repair an
unmet earlier gate.

## Phase 0 — Preserve operator authority

Complete every prerequisite before rotating or revoking a credential:

- Use the operator minter credential to inventory keys and principals
  server-side.
- Include active credentials behind `.env.local`, agenix files, shell exports,
  pi/Grok loaders, and the M2 `ob1-ingest-access-key` fallback.
- Compare hashes only. Never print key material.
- Confirm an active named stored-admin credential exists. If absent, issue and
  verify one through the ADR-0005 one-shot path.
- Keep these four authorities distinct:
  - **Server boot secret:** M2-only agenix file; server runtime only.
  - **Named stored admin:** password manager; operator-present injection only.
  - **Minter:** password manager; operator-present, WireGuard-gated calls only.
  - **Approval key:** M2 operator Keychain; released only after console startup
    authentication.
- Freeze every UID-501 process or container capable of reading or presenting an
  OB1 credential. Check actual authority, not process names.
- Make sudo rules command-scoped and one-directional: operator to pinned agent
  wrappers only, with no inverse or sibling transitions.
- Remove ambient and conditional credential fallbacks before testing their
  replacements.
- Run exact `/whoami` checks under `env -i`. Require the expected principal, key
  ID, capabilities, and memberships.
- Treat boot-key rotation as consumer-restart-coupled. Restart and verify OB1,
  caged pi, IMAP, Telegram, dictation, and every other long-lived consumer. Turn
  the existing stale-container `401` into a regression test.

**Phase 0 gate:** the inventory is complete, a named stored admin is verified,
all four authorities have distinct custody, every credential-capable UID-501
process is frozen or accounted for, fallbacks are removed, exact clean-room
identity checks pass, and every boot-key consumer has restarted and verified.
No rotation proceeds before this gate passes.

## Phase 1 — Repo-agent credential custody

Implement this phase in `system-config`. Roll out M2 first, verify it, then roll
out M4.

### Repo registry and filesystem custody

- Generalize the existing ACS modules into an explicit ten-repo registry.
- Give each repository:
  - a stable `agent-<slug>` UID/GID mapping, identical on both hosts;
  - a private `0700` home and an agent-owned clone under `$HOME/work`;
  - one production OB1 repo key reused across both hosts;
  - one repo-scoped HTTPS forge write token.
- Install secrets through agenix as repo-UID-owned `0400` files.
- Use absolute Nix-store interpreter and tool paths.

### Agent wrappers and vendor authentication

- Generalize the two-stage `env -i`, exact-UID, root-refusing wrappers for Codex
  and Claude.
- Add an equivalent Grok wrapper.
- Support:
  - Codex device authentication;
  - serialized, atomic Claude OAuth import;
  - serialized, atomic Grok OAuth import.
- Restore repo identity after OB1 verification. Enable Codex, Claude, and Grok
  independently only after each vendor authentication verifies.
- Require operator participation for every create-only mint. Correct mistakes
  by rotation; never use a fallback credential.
- Schedule revocation of the current OB1 pane's legacy credential only after its
  replacement passes verification.

### Explicit non-goals and accepted risks

- Phase 1 isolates OB1 and forge credential files. It does not isolate networks
  or all authority.
- One OB1 key per repo spans both hosts, coupling audit and revocation.
- Vendor accounts remain shared upstream identities. A repo compromise may
  affect billing or the refresh family. Test whole-family logout and recovery.

**Phase 1 gate:** both host configurations evaluate for all ten registry
entries; M2 then M4 pass wrapper, credential-file, identity, and vendor-auth
tests; the replacement OB1 credential works with exact expected authority; and
the legacy credential has a scheduled, operator-approved revocation path.

## Phase 2 — Agent brain and publication proposals

Prove Phase 2 first on `ob1_dev` with a throwaway publication brain. Deploy the
topology, confinement changes, and proposal workflow together; a half-deployed
fan-out is merely a new class of accident.

### Agent brain topology

Add `agent-published` with a new `is_agent_publication_brain` marker. Its
resolver must require exactly one marked brain in the agent estate and validate:

- the expected estate;
- `kind = repo`;
- `egress_class = repo`;
- `is_default_shared = false`.

Zero, multiple, cross-estate, Personal/private, or malformed targets refuse
before membership changes. A negative test must deliberately mark the Personal
brain and prove refusal.

In one deployment:

- Update repo-principal confinement to allow exactly:
  - `editor` on its Repo brain;
  - `viewer` on `agent-published`.
- Backfill existing principals.
- Update mint and rotate behavior.
- Revoke all agent access and writer credentials for `agent-common` before
  enabling the new fan-out.
- Recheck the live `agent-common` thought count. Submit each legacy row
  individually with legacy provenance; never grandfather or bulk-approve it.

Unscoped search and ask continue querying every accessible brain. Each repo
principal's accessible set must be exactly its Repo brain plus
`agent-published`.

### Proposal authority and interfaces

Add access-key capabilities, defaulting to false:

- `can_propose_agent_thought`
- `can_approve_agent_thought`
- `can_unpublish_agent_thought`

Enrollment grants proposal capability to intended repo and caged-agent
credentials. Rotation preserves the managed capability set. Membership and
free-form principal type never imply proposal authority.

Expose these agent MCP tools:

- `propose_agent_thought`
- `list_agent_thought_proposals` — own proposals only
- `withdraw_agent_thought_proposal` — own pending proposals only

Derive idempotency server-side from the proposer principal and content hash.
Apply a partial unique constraint only while a proposal is pending. Terminal
rows do not burn a hash.

### Classification and payload placement

Classification is the worst of three independent signals:

1. source-brain boundary;
2. deterministic secret-pattern and high-entropy scan;
3. M3 model classification.

Personal, `private_local`, and `quarantine_review` sources are always sensitive,
regardless of M3 output. M3 may restrict sourced content; it can never promote
it.

Use the existing M3 `mlx-server` with this pinned deterministic classifier
configuration:

- model: `DeepSeek-V4-Flash-nvfp4`;
- temperature zero;
- schema-constrained output;
- allowed results: `standard`, `sensitive`, `uncertain`.

Unavailable, malformed, and uncertain results fail closed. Persist distinct
states:

- `classified_standard`
- `classified_sensitive`
- `classifier_uncertain`
- `classifier_unavailable`
- `classifier_error`

Standard content enters the normal proposal payload store. Every other result
enters a local-only quarantine payload store. Cloud callers receive proposal ID
and status only.

Classifier outages alert the operator and permit automatic reclassification
after recovery. They must remain distinguishable from content judgments.

Both standard and quarantine payloads expire after seven days. Warn before
expiry. Expiry, rejection, and withdrawal lock the row and null payload columns
while retaining the proposal row and audit record.

### M3 privacy boundary

Use a dedicated authenticated TLS classifier route from M2 to M3 with a
classifier-only secret installed through agenix. It is unrelated to OB1
authority.

- Pin oMLX above `TRACE`; `TRACE` can log request bodies.
- Send `skip_cache_store=true`.
- Forbid bodies in oMLX, wrapper, launchd, proxy, access, and telemetry logs.
- Run a sentinel-content test across every configured log and cache path.
- Block Phase 2 on any sentinel occurrence.
- Re-run the sentinel test after upgrades and periodically.
- Replace the classifier runtime before deployment if the pinned runtime cannot
  prove these properties.

These controls follow the official
[oMLX request-logging implementation](https://github.com/jundot/omlx/blob/main/omlx/server.py)
and
[cache-store control](https://github.com/jundot/omlx/blob/main/omlx/request.py).

### Publication guard

Deny generic capture, patch, delete, restore, and purge on `agent-published` to
every caller, including owner, estate admin, stored admin, and legacy admin.

- Evaluate publication-brain denial before generic admin allowances.
- Backstop the denial with a database trigger.
- Permit one insertion exception: an internal publication-executor identity
  invoking a narrow stored procedure.
- Allow the procedure to insert only the exact locked, standard, pending
  proposal into the uniquely resolved publication brain.
- Test the executor through the trigger, not around it.
- Record:
  - proposer as `written_by`;
  - operator as decision actor;
  - publication executor as execution actor.

This attribution is intentional even though the proposer lacks direct write
capability.

Approval checks for an existing published content hash. If present, link the
proposal to that thought rather than inserting a duplicate.

### Operator console

Install a pinned `system-config`/Nix-store console binary. Repository-owned
console code does not run.

- Run the process on M2 inside a logged-in GUI session.
- Use only M2's loopback `local_trusted` listener.
- Treat raw SSH as insufficient because Keychain/OS authentication must unlock
  interactively.
- Make the public listener refuse the approval credential.
- Record the standing `local_trusted` approval credential as an explicit
  exception to docs/49's ephemeral-session design.
- Authenticate once at startup through Keychain and retain authority until the
  console exits.
- Refuse non-foreground TTY, piped stdin, and batch operations.
- Treat `HERDR_ENV` refusal as advisory, not an enforcement boundary.
- Independently fetch and display exact content, hash, source, classification,
  proposer, and target.
- Require per-item interactive confirmation.
- State that publication exposes content to cloud-bound Codex, Claude, and Grok
  providers.
- Put proposal IDs and counts only in pi notifications.

Expose these operator-only loopback routes:

- list/watch pending proposals;
- approve;
- reject;
- withdraw;
- sanitize/declassify into a new standard proposal with a new hash;
- unpublish an already published thought.

Approval is an egress decision, not merely a quality review. Use that framing in
the console and ADR.

### Specialized unpublish

`unpublish_agent_thought` is neither generic purge nor plain `DELETE`. It must:

- be operator-only, non-batchable, hash-bound, and two-actor audited;
- remove content, embeddings, graph projection, and graph-projection state;
- redact or remove every revision payload created by migration 022 that
  contains the erased bytes;
- retain only hashes, actors, reason, timestamps, and proposal linkage;
- prove sentinel content appears nowhere in thoughts, revision history,
  projection state, or Neo4j;
- warn that provider copies and historical backups cannot be recalled.

The named stored admin remains separate for general purge and graph
administration.

## Verification matrix

Automated and live tests must cover:

- both host configurations and every repo registry entry;
- wrapper refusal for wrong UID, root, missing secrets, wrong ownership,
  symlinks, and ambient credentials;
- exact `/whoami` behavior from Codex, Claude, and Grok;
- capability preservation during rotation;
- publication-marker refusal on Personal/private and malformed targets;
- confinement and membership changes in one deployment;
- generic-write denial for every caller shape, including operator and admin;
- executor isolation through the database trigger;
- source-boundary, secret-scan, and M3-classifier worst-of behavior;
- classifier outage, retry, alerting, and expiry behavior;
- M3 logging/cache sentinel verification;
- M2-only `local_trusted` console placement and public-listener rejection;
- pending-only idempotency and duplicate-publication linking;
- immutable snapshots and concurrent approval/expiry locking;
- redaction after rejection, withdrawal, and expiry;
- complete specialized-unpublish erasure, including revision and graph residue;
- exact Repo-plus-Agent fan-out;
- individual review of legacy `agent-common` content.

## Governance and acceptance

Keep ADR-0012 `proposed` until production credentials prove every positive and
negative path. Only then:

1. Mark ADR-0012 accepted.
2. Reconcile OB1 ADR-0001.
3. Have `system-config` explicitly reopen and reconcile ADR-0004.
4. Record the deployed topology and residual risks in the Brain with
   attributable actors.

## Deferred broker

The cross-repo message broker remains a separate project with:

- separate UID-owned Herdr servers;
- durable inert messages and typed references;
- declarative peer edges;
- no TTY control or reference dereferencing;
- macOS sender authentication through `LOCAL_PEERCRED` with `SOL_LOCAL`.

## Accepted residual risks

- One repo key spans M2 and M4.
- Vendor identities are shared upstream.
- M2 retains the `system-config` ADR-0009 UID-501 residual.
- Console authority lasts for the process lifetime without idle
  reauthentication.
- M3 and backups may retain non-payload operational artifacts.
- Unpublish cannot revoke bytes already received by model providers or retained
  backups.

## Peer-review record

Claude and Grok both returned `SHIP` after three adversarial iterations. Both
had prior case contact and helped refine the design. This is consensus review,
not independent blind review. Their blocking findings are incorporated here.
