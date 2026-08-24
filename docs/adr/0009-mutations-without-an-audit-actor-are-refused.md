---
status: accepted
date: 2026-08-23
---

# A mutation with no valid audit actor is refused, not recorded anonymously

`thought_audit.actor` is NOT NULL and the revision trigger (ADR-0008) cannot know
who the caller is, so the application announces it for the length of the
transaction. When that announcement is missing or malformed, the mutation **raises**
rather than recording the revision under an "unattributed" placeholder.

The placeholder was implemented first, on the reasoning that losing the writer's
name is better than losing the row's prior content. That was wrong for three
reasons. The warning it emitted fires *after* the write decision, so dropped or
ignored logging leaves a permanent unattributed edit. The metadata-patch route has
no row-level writer attribution of its own, so an unwired path there yields
recoverable content with no actor at all — half a forensic record. And "there are
only two call sites today" is an argument for making the invariant strict now, not
for leaving a bypass for the third one. A refused write is loud and fixed in
minutes; an unattributed edit is permanent.

Deliberate maintenance writes are not blocked — they announce a `system_maintenance`
actor through the same wrapper. The cost is real and was paid immediately: thirteen
existing tests across three suites were mutating `thoughts` with no actor and had to
be changed. One of those, a raw ranking update in migration-013's fixture, was a
genuinely unattributed mutation path that nobody had noticed.

## Consequences

- Any new mutation path must run inside the transaction wrapper. Forgetting is a
  hard failure at the first write, not a silent gap discovered during an incident.
- The validation checks the whole actor shape, not merely that it is JSON. `{}` is
  an object and would otherwise be stored as an actor naming nobody — and the first
  two attempts at this check both let it through, because a missing JSON key yields
  SQL NULL and `NULL <> 'string'` is NULL rather than true. Comparisons against
  possibly-absent keys must use `is distinct from`.
