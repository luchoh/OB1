---
status: accepted
date: 2026-08-25
---

# Ingest daemon state belongs in Postgres, reached through the MCP server

`ob1-imap-watch` keeps its memory — which messages it has seen, which are failing —
in `recipes/email-history-import/imap-sync-log.json`, a local file it is the sole
writer of. That state moves to Postgres. The daemon does **not** get a database
credential; it reaches the state over HTTP through the MCP server, with the ingest
key it already holds.

The file works while exactly one process cares. It stops working the moment a second
one does — and one does, as soon as an operator can answer "give up on this message?"
from somewhere other than the daemon's own command line. Every way of bridging that
gap across a file is a workaround: a second file the other process writes, two
writers on one file with no lock, or one process shelling out to the other. All three
were considered and rejected as mechanism invented to avoid naming the real problem,
which is that shared state is in the wrong place.

Postgres is where OB1 keeps shared facts, and it supplies the primitives this
needs. It does not, on its own, answer the concurrency question that was left
open while the state was a file: two writers still require an explicit protocol —
a claim, a row version, or a lease — and that protocol has to be designed rather
than assumed. What changes is that the primitives exist to build it correctly,
instead of the question being deferred again for want of any.

Direct credentials were rejected. No recipe in this repo imports a Postgres driver;
`local/open-brain-mcp/src/db.mjs` is the only thing that touches the database, and
daemons reach it over `/ingest/thought`, `/ask`, `/whoami`, `/admin/*`. `docs/51` is
explicitly about *narrowing* what these daemons can reach — giving each a
`local_trusted`, non-admin key in place of the shared admin key. Handing the mail
importer a database password would be the first recipe to hold one and would run
against that. One owner of the database is what makes the access model legible.

The cost is real and is the reason this is not shipping today: it needs new endpoints
in the MCP server, a migration, and a release on the fleet-wide pin — the whole repo
moves together (see the deploy note in `hosts/m2maxstudio.nix`). The file-based
version ships first, because the amplifier it fixes is live in production and the
file is what makes the migration safe to do slowly. Running it also tests the retry
policy before that policy is committed to a schema.

What is lost in the move: atomic writes, refusal to start on a corrupt log, and the
defensive shape of `load_sync_log` — roughly 150 lines that exist because the store
is a file. The policy they protect is unaffected.
