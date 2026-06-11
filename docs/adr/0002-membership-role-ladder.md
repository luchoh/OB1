---
status: accepted
date: 2026-06-11
---

# Membership roles form an enforced monotone ladder

v24 recorded membership roles but deliberately deferred enforcing them: any
non-deny brain membership granted read **and** write regardless of role, and
only delete/restore checked roles. While extracting the membership decision
into a pure policy module (PRD docs/34), we decided to enforce a monotone
ladder instead of embalming the deferred state: brain roles `viewer` (read)
⊂ `editor` (+ write) ⊂ `owner` (+ delete/restore); estate roles `member`
(read all estate brains) ⊂ `admin` (+ write + delete/restore). Purge stays
outside the ladder — it requires a named admin service key (v24 D9),
never a role. Brain-level DENY continues to override everything.

Verified zero-impact before deciding (2026-06-11, prod `ob1`: 4×owner +
2×editor brain rows, 1×admin estate row; dev `ob1_dev`: 2×owner): every
existing row keeps its current effective permissions; only the unused roles
(`viewer`, `member`) gain meaning, in the fail-closed direction.

## Considered options

- **Stay deferred** (roles decorative for read/write, matching v24): rejected
  — the pure policy module's decision table would permanently document
  `(viewer, write) → ALLOW` as intended, turning an deferral into a contract.
- **Estate `member` = write-capable** (member ≈ editor): rejected in favor of
  member = read-only — widening later is backward-compatible, narrowing later
  breaks provisioned memberships, and broad-write-by-default is the wrong
  default for an estate-wide grant.

## Consequences

- The role ladder is now load-bearing: provisioning scripts and future
  memberships must pick roles meaning what the ladder says.
- Related cleanup recorded here: an `estate_memberships.is_deny = true` row
  is treated as **absent membership** (fail-closed), resolving the
  contradiction between migration 009's comment ("not consulted") and the
  resolver SQL (which consults it). Estate-level DENY remains a non-feature
  per ADR-0001; absence is denial.
- Roles **compose additively**: a principal's capability on a brain is the
  union of its brain-role and estate-role grants (a brain `viewer` who is also
  estate `admin` gets admin capability). Grants only add; nothing clamps a
  capability *down* except a brain-level DENY.
- Brain-level DENY is the **only subtractive mechanism**, and it clamps **every
  caller shape — stored admin keys included**. ADR-0003 made an admin key's
  home-estate reach a broad grant; per ADR-0001 a brain-level DENY overrides
  broad grants, so admin home-reach is not an exception. This is the only
  mechanism able to carve a sensitive brain out of an admin key's home estate —
  the founding privacy scenario if such a brain ever shares the operator's
  estate. Verified zero-impact (no DENY rows in prod, 2026-06-11); it supersedes
  the pre-v24 behavior where a stored `is_admin` key short-circuited before any
  deny check.
