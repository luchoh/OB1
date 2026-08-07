---
status: accepted
date: 2026-08-07
---

# The caged agent is the more trusted one, and holds the wider key

pi runs inside an Apple `container` cage. claude and codex run **as the operator, on
the host**, with the operator's filesystem, shell, and credentials. The containment
asymmetry runs the opposite way to the intuition that "the sandboxed agent with
ungated bash is the dangerous one": ungated bash *inside a cage* is bounded by the
cage, while a host agent's tools are bounded by nothing.

pi therefore holds the **wider** brain reach — `common-public`, the estate-wide shared
brain — precisely because it is the contained one. claude and codex hold repo-scoped
access only.

Key shape, decided with the operator:

- **One shared repo principal per repo**, `repo-service:<slug>`, with `editor` on
  `repo:<slug>`. claude, codex *and* pi all present that key for repo work. Losing the
  ability to distinguish pi from claude on the repo brain is accepted.
- **Per-repo common principals**, `pi-common:<slug>`, each with `editor` on the single
  estate-wide `common-public` brain. Only pi holds these.

A key grants the reach of its **principal** (`auth.mjs` `fetchBrainMemberships`); the
key's `brain_id` is a default-brain hint, never a clamp (ADR-0003). One key is
therefore one membership set, which is why pi cannot simply be handed "the same key
plus one brain" — it needs a second credential.

## Considered options

- **pi gets its own repo principal** (`pi:<slug>`, editor on the repo brain, distinct
  from claude/codex): rejected by the operator. The argument for it was that the repo
  brain is read by reflex (AGENTS.md) and so is the highest-value injection channel
  into the host agents, and a shared principal makes pi-authored rows
  indistinguishable from claude's. The argument against, which won: pi already has
  read-write access to the repo's **source code** via the `/work` mount, so denying it
  a distinct brain identity is theatre, and every extra credential is another thing to
  provision, rotate and leak.
- **One estate-wide common key** shared by every repo's pi: rejected in favour of
  per-repo. Minting cost is identical, and per-repo buys revocation granularity (kill
  one repo's cage without killing all of them) and tells you which repo a shared note
  came from.
- **Keep `common-public` out of default fan-out** (`include_in_default_fanout`):
  dropped as unnecessary. Each key's principal has exactly one membership, so fan-out
  is naturally scoped to one brain with no new flag. It would also not have been a
  control — pi can always name the brain explicitly.

## Consequences

- `mint_agent_key` as built in 0.8.0 creates `pi:<slug>` with **two** memberships
  (repo brain + shared brain). Under this ADR that is wrong: the agent principal needs
  `common-public` **only**. It must be reworked before use.
- `common-public` becomes genuinely multi-writer across repos, so the cross-principal
  overwrite guard shipped in 0.8.0 has a real case: one repo's pi cannot silently
  overwrite another's row via a guessable `dedupe_key` collision.
- The trust in pi rests entirely on the cage holding. `$PWD` is bind-mounted
  **read-write** at `/work` (`pi-cli/default.nix:500`, no `readonly`, while the skills
  mounts at `:505-508` do have it), so an injected pi can write files the host agents
  auto-load. Closing that is system-config's, and this ADR's premise depends on it.
- Content exfiltration from the cage is unmitigable on macOS (all-or-nothing egress).
  Credential exfiltration is largely inert because OB1 is not internet-reachable — a
  leaked key is only useful to something already inside the boundary.
