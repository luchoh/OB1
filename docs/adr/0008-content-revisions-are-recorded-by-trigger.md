---
status: accepted
date: 2026-08-23
---

# Content revisions are recorded by a database trigger, not by the store

Every other audit row in OB1 is written by the thought store, inside the same
statement as the mutation — the module says so explicitly: "a caller never writes
a `thought_audit` row". Content revisions (migration 022) deliberately break that
idiom and use an `AFTER UPDATE` trigger on `thoughts` instead.

The store-shaped design was written first and rejected. It read the prior row in a
`prior` CTE alongside the capture upsert. All sub-statements of a data-modifying
CTE share one snapshot, but `INSERT ... ON CONFLICT DO UPDATE` under READ COMMITTED
may update a row version created by a *concurrent* transaction that the snapshot
never saw. So: T1's `prior` sees version A (or nothing); T2 commits version B; T1's
upsert then overwrites B while recording A as the predecessor. The history would be
wrong precisely when two writers race, which is the only case it exists for. A
trigger sees the tuple actually replaced, always.

Two consequences worth stating. The trigger leaves `captureThought`'s statement
completely untouched, so the §6.10 tier guard, the shared-brain ownership backstop,
the monotone origin/trust labels, the zero-rows-means-NOT_FOUND shape and the
RETURNING projection cannot be broken by this change. And a trigger cannot know its
caller, which is what forces the audit actor to be announced per transaction — see
ADR-0009.

## Considered options

- **A `prior` CTE beside the upsert**, matching the delete/restore pattern: rejected
  above. It passes every test that does not force a conflicting interleaving, which
  is why the first version of the concurrency test also had to be rewritten.
- **Application-level emission in the two store functions**: covers every HTTP and
  MCP path, which is everything an agent can reach, but not direct SQL, and it
  inherits the same snapshot problem on the upsert path.
