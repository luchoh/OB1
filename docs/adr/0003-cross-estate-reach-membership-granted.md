---
status: accepted
date: 2026-06-11
---

# Cross-estate reach is membership-granted, never ambient

Pre-v24, a stored `is_admin` access key resolved brains household-wide via L1
selectors but **globally** (any estate) via body/tool-arg selectors — so an
admin key could read, write, delete, restore, and purge thoughts in estates
its principal had no relationship with. That ambient reach contradicted
ADR-0001's founding privacy property (the estate is the governance boundary;
the operator's permissions must never touch the spouse's brain). We decided:
a stored admin key's accessible scope is **all brains in its home estate ∪
its principal's membership-derived scope**, and all selector resolution (L1
and body alike) flows through the same scope machinery and 404/403/409
verdicts as every other caller. Wanting reach into another estate means
granting a membership row — one row, auditable, revocable — not holding a
stronger key. The bare legacy env key remains the only global actor
(documented blast radius, see docs/32 D9), pending its separate retirement.

Verified before deciding (2026-06-11, prod `ob1`): the single active admin
key belongs to the operator, whose explicit estate-admin membership on the
agent estate already covers all reach in actual use — the unification is
zero-loss today and removes two special-cased resolution branches from the
policy.

## Consequences

- Future admin keys do not see estates they lack memberships in (fail-closed;
  the fix is a membership row, not a code change).
- L1 selector resolution for admin keys *widens* to match: membership-derived
  cross-estate brains become nameable via header/query, where they previously
  404ed — the asymmetry is resolved in both directions.
- Purge capability remains key-shape-gated (named admin service key, v24 D9);
  this ADR governs *reach* (which brains are nameable), not capability.
- The pre-v24 "brain-bound key" restriction (`brain_access_keys.brain_id` as
  a naming clamp) is retired with the same reasoning: it was half-enforced
  (L1 selectors only — body args and fanout never checked it) and applied to
  zero live keys as a restriction. `brain_id` on a key remains only a
  default-brain hint. A key is identity plus a default; capability comes from
  roles (ADR-0002), reach from memberships and estates (this ADR). If
  key-scoped capability is ever wanted, it arrives as an explicit feature.
