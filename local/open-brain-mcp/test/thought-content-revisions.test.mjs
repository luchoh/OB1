// Content versioning (migration 022) — DB-backed, like the rest of the
// thought-store suite: this behaviour IS the SQL (an AFTER UPDATE trigger with a
// WHEN clause and a transaction-scoped actor setting), so a mock would only
// prove the mock agrees with itself.
//
// The question these tests exist to keep answerable: after a writer overwrites a
// thought in place — same id, same created_at — can the previous content still
// be recovered, and does the history say who did it.
//
// The three that matter most and are easiest to regress:
//   * a no-op re-capture must write NOTHING (the ingest daemons re-import
//     idempotently and the enrichment scripts patch in bulk; without the WHEN
//     filter the history is almost entirely noise and the real edits are lost
//     in it);
//   * a soft delete must NOT also produce a revision (it already emits its own
//     'delete' row — double-recording one event as two kinds is worse than not
//     recording it);
//   * revisions must survive a PURGE of their own thought, which is why
//     thought_audit.thought_id is deliberately not a foreign key (012:40-46).
//
// Self-skips with an explicit reason when the dev database is unreachable or 022
// is missing, and HARD-REFUSES to run against prod `ob1`. Fixtures are
// `zzt-`-prefixed, unique per process, and torn down — EXCEPT the audit rows
// themselves, which the append-only trigger makes undeletable by design. A dev
// database therefore accumulates them; that is the intended trade.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const RUN = crypto.randomBytes(4).toString("hex");
const EST = `zzt-rev-est-${RUN}`;
const BRAIN = `zzt-rev-brain-${RUN}`;

const EMB = Array(1536).fill(0);
EMB[0] = 1;

const ACTOR = { auth_source: "service_key", principal_id: null, is_admin: false };

let query;
let closePool;
let store;
let skipReason = false;

try {
  const { config } = await import("../src/config.mjs");
  if (config.postgres?.database === "ob1") {
    skipReason = "refusing to run the content-revision DB suite against prod database 'ob1'";
  } else {
    const db = await import("../src/db.mjs");
    query = db.query;
    closePool = db.closePool;
    await query("select 1");
    // 022 ships a trigger and a relaxed CHECK, neither of which is a column, so
    // presence is probed directly rather than via information_schema.columns.
    const probe = await query(
      `select
         (select count(*) from pg_trigger
            where tgname = 'thoughts_record_revision' and not tgisinternal) as trg,
         (select count(*) from pg_constraint
            where conname = 'thought_audit_action_check'
              and pg_get_constraintdef(oid) like '%update%') as chk`,
    );
    const { trg, chk } = probe.rows[0];
    if (Number(trg) < 1 || Number(chk) < 1) {
      skipReason = "migration 022 is not applied to this database (no thoughts_record_revision trigger / action CHECK still rejects 'update')";
    } else {
      store = await import("../src/thought-store.mjs");
    }
  }
} catch (error) {
  skipReason = `dev database unreachable (run via 'direnv exec .' from the repo root): ${error.message}`;
}
if (skipReason && closePool) {
  try {
    await closePool();
  } catch {
    /* best effort */
  }
  closePool = null;
}

describe("thought content revisions (DB-backed, migration 022)", { skip: skipReason }, () => {
  let brainId;

  const capture = (opts) => store.captureThought({
    brainId,
    content: "x",
    embedding: EMB,
    embeddingModel: "zzt-test-model",
    metadata: {},
    ...opts,
  });

  // Ordered newest-first by `seq`, never by `at`. `at` is wall clock: values can
  // tie at microsecond precision and can move backwards under NTP adjustment, so
  // ordering a version history by it is approximate. `seq` is the total order.
  async function revisions(thoughtId) {
    const r = await query(
      `select actor, old_state, seq from thought_audit
       where thought_id = $1::uuid and action = 'update' order by seq desc`,
      [thoughtId],
    );
    return r.rows;
  }

  before(async () => {
    await query(
      "insert into households (slug, display_name) values ($1, 'zzt revisions') on conflict (slug) do nothing",
      [EST],
    );
    const b = await query(
      `insert into brains (household_id, slug, display_name, kind, egress_class, is_default_shared)
       select id, $2, 'zzt revisions', 'repo', 'repo', false from households where slug = $1
       returning id`,
      [EST, BRAIN],
    );
    brainId = b.rows[0].id;
  });

  after(async () => {
    // thought_audit rows are intentionally NOT cleaned: the append-only trigger
    // (012:80-88) refuses DELETE, which is the property being relied on.
    await query("delete from thoughts where brain_id = $1::uuid", [brainId]);
    await query("delete from brains where id = $1::uuid", [brainId]);
    await query("delete from households where slug = $1", [EST]);
    if (closePool) {
      await closePool();
    }
  });

  it("a fresh capture writes no revision", async () => {
    const t = await capture({ content: "fresh", dedupeKey: `zzt-fresh-${RUN}` });
    assert.equal((await revisions(t.id)).length, 0);
  });

  it("overwriting content records the PRIOR content, not the new one", async () => {
    const key = `zzt-overwrite-${RUN}`;
    const first = await capture({ content: "original", dedupeKey: key });
    const second = await capture({ content: "overwritten", dedupeKey: key, actor: ACTOR });

    assert.equal(second.id, first.id, "upsert should reuse the row, not insert a new one");

    const rows = await revisions(first.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].old_state.content, "original");
    assert.equal(rows[0].old_state._schema, 1);
  });

  it("re-capturing IDENTICAL content writes no revision", async () => {
    const key = `zzt-noop-${RUN}`;
    const first = await capture({ content: "same", dedupeKey: key });
    await capture({ content: "same", dedupeKey: key, actor: ACTOR });
    assert.equal((await revisions(first.id)).length, 0, "an idempotent re-import must not create history");
  });

  it("a metadata patch is versioned (it previously left no trace at all)", async () => {
    const key = `zzt-patch-${RUN}`;
    const t = await capture({ content: "patch me", dedupeKey: key, metadata: { a: 1 } });
    await store.patchThoughtMetadata({
      brainId,
      thoughtId: t.id,
      metadataPatch: { b: 2 },
      actor: ACTOR,
    });
    const rows = await revisions(t.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].old_state.metadata.b, undefined, "the revision holds the metadata as it was BEFORE the patch");
    assert.equal(rows[0].old_state.content, "patch me");
  });

  // THE test this design exists for. The rejected CTE design read the prior row
  // at statement-snapshot time, but ON CONFLICT DO UPDATE in READ COMMITTED can
  // overwrite a row version the snapshot never saw — so under concurrency it
  // would record a stale predecessor, or none, for a real overwrite. A trigger
  // sees the tuple actually updated. This asserts the resulting chain is
  // GAPLESS: every version except the survivor appears exactly once as some
  // revision's predecessor.
  it("records the truly-overwritten version under a forced conflicting interleaving", async () => {
    const key = `zzt-concurrent-${RUN}`;
    const base = await capture({ content: "C0", dedupeKey: key });
    const db = await import("../src/db.mjs");

    // Promise.all over two pooled calls is NOT this test: it may simply run them
    // in series, which the rejected CTE design would also survive. The schedule
    // below is the one that breaks a snapshot-based `prior`:
    //   1. T1 updates the row and HOLDS the lock, uncommitted.
    //   2. T2's upsert statement begins — taking its snapshot, in which the row
    //      still reads C0 — and then blocks on T1's row lock.
    //   3. T1 commits. T2 wakes and updates the version T1 wrote, which T2's own
    //      snapshot never saw.
    // A snapshot-based prior would record C0 here. The trigger sees the tuple
    // actually replaced, so it must record C1.
    // T1 holds an open transaction with a row lock, so the cleanup path matters
    // more than usual: `release()` on a client that is still in a transaction
    // returns it to the pool AS IS. node-pg does not roll back for you. Any
    // later test drawing that connection inherits an open transaction, and the
    // row lock is held until the process exits — so a single timeout here would
    // not fail one test, it would hang the suite. Hence the explicit rollback
    // before release, and settling T2's promise so it cannot become an unhandled
    // rejection while blocked on a lock nobody is going to release.
    const t1 = await db.pool.connect();
    let blocked;
    let committed = false;
    try {
      const t1Pid = (await t1.query("select pg_backend_pid() as pid")).rows[0].pid;
      await t1.query("begin");
      await t1.query("select set_config('ob1.actor', $1, true)", [JSON.stringify(ACTOR)]);
      await t1.query("update thoughts set content = 'C1' where id = $1::uuid", [base.id]);

      // T2 is the REAL capture upsert, not a bare UPDATE: the production hazard
      // is INSERT ... ON CONFLICT DO UPDATE, which is the statement that can
      // touch a row version its own snapshot never saw.
      blocked = capture({ content: "C2", dedupeKey: key, actor: ACTOR });

      // Wait for T2 to be genuinely BLOCKED, rather than sleeping and hoping. A
      // fixed delay is a race: if T2 has not yet sent its statement when T1
      // commits, the two run in series and the test passes without ever
      // exercising the interleaving it exists to test.
      //
      // The predicate must name T1. A previous version polled
      // `pg_locks where not granted`, which is CLUSTER-WIDE: any unrelated
      // blocked backend — another test suite on the shared dev database, another
      // session entirely — satisfied it, so the barrier could be released while
      // T2 was still idle and the test would pass having proved nothing.
      // Blocked-by-T1 alone is still not enough to mean "T2". T1 also holds a
      // relation-level lock on `thoughts`, so a concurrent migration ALTER on the
      // shared dev database would be blocked by T1 and satisfy the predicate
      // while T2 sat idle. The waiting backend must therefore ALSO be running the
      // capture upsert. Blocked by our transaction AND executing
      // `insert into thoughts ... on conflict` can only be T2.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const w = await query(
          `select count(*)::int as n from pg_stat_activity
           where pid <> $1
             and $1 = any(pg_blocking_pids(pid))
             and query ilike '%insert into thoughts%'
             and query ilike '%on conflict%'`,
          [t1Pid],
        );
        if (w.rows[0].n > 0) break;
        assert.ok(Date.now() < deadline,
          "no capture upsert ever blocked on T1; the interleaving was not forced");
        await new Promise((r) => setTimeout(r, 25));
      }

      await t1.query("commit");
      committed = true;
      await blocked;
    } finally {
      if (!committed) {
        // Releases the row lock so T2 can finish (or fail) instead of hanging.
        await t1.query("rollback").catch(() => { /* connection may already be dead */ });
      }
      t1.release();
      // T2 was started without being awaited on the failure path; settle it so a
      // rejection cannot surface later as an unhandled rejection in another test.
      if (blocked) {
        await blocked.catch(() => { /* the assertion above is the real failure */ });
      }
    }

    const current = await query("select content from thoughts where id = $1::uuid", [base.id]);
    assert.equal(current.rows[0].content, "C2");

    const rows = await revisions(base.id);
    assert.equal(rows.length, 2, "both overwrites must be recorded");
    assert.deepEqual(rows.map((r) => r.old_state.content), ["C1", "C0"],
      "newest revision must hold C1 — the version actually destroyed. C0 here would be the CTE bug.");
  });

  it("orders revisions by a monotonic sequence, not wall clock", async () => {
    const key = `zzt-order-${RUN}`;
    const t = await capture({ content: "S1", dedupeKey: key });
    await capture({ content: "S2", dedupeKey: key, actor: ACTOR });
    await capture({ content: "S3", dedupeKey: key, actor: ACTOR });

    const r = await query(
      `select seq, old_state->>'content' as prior from thought_audit
       where thought_id = $1::uuid and action = 'update' order by seq asc`,
      [t.id],
    );
    assert.deepEqual(r.rows.map((x) => x.prior), ["S1", "S2"]);
    assert.ok(Number(r.rows[1].seq) > Number(r.rows[0].seq), "seq must strictly increase");
  });

  // The upsert reassigns attribution to the latest writer even when content is
  // byte-identical (thought-store.mjs:222-225). Without written_by_* in the
  // trigger's WHEN clause, one principal could take over another's row silently.
  it("a provenance-only change is versioned even when content is unchanged", async () => {
    const key = `zzt-provenance-${RUN}`;
    const t = await capture({ content: "unchanged", dedupeKey: key });
    assert.equal((await revisions(t.id)).length, 0);

    // written_by_principal_id is a real FK to brain_principals, so the taking-over
    // principal has to exist.
    const p = await query(
      `insert into brain_principals (household_id, slug, display_name, principal_type)
       select id, $2, 'zzt takeover', 'repo_service' from households where slug = $1
       returning id`,
      [EST, `zzt-takeover-${RUN}`],
    );
    const db = await import("../src/db.mjs");
    await db.withAuditActor(ACTOR, (run) => run(
      "update thoughts set written_by_principal_id = $2::uuid where id = $1::uuid",
      [t.id, p.rows[0].id],
    ));

    const rows = await revisions(t.id);
    assert.equal(rows.length, 1, "an ownership takeover must leave a record");
    assert.equal(rows[0].old_state.content, "unchanged");
    assert.equal(rows[0].old_state.written_by_principal_id, null);
  });

  // FAIL CLOSED. Every malformed shape must be refused, not stored as an actor
  // that names nobody. `{}` is the one that matters most: it is a JSON object,
  // so a bare "is it an object" check passes it — and did, until the guard was
  // rewritten with `is distinct from`.
  it("refuses every malformed actor shape", async () => {
    const db = await import("../src/db.mjs");
    const bad = {
      "empty object": {},
      "auth_source not a string": { auth_source: 7, principal_id: null, is_admin: false },
      "auth_source empty": { auth_source: "", principal_id: null, is_admin: false },
      "principal_id wrong type": { auth_source: "service_key", principal_id: 5, is_admin: false },
      // The seventh shape, and the one that slipped through: a MISSING key makes
      // `->` yield SQL NULL, so `not in ('string','null')` evaluates to NULL and
      // the guard never fires. Absent from the first six, which is exactly why
      // the bug survived a round of review.
      "principal_id missing": { auth_source: "service_key", is_admin: false },
      "is_admin missing": { auth_source: "service_key", principal_id: null },
      "is_admin not boolean": { auth_source: "service_key", principal_id: null, is_admin: "no" },
    };

    for (const [label, actor] of Object.entries(bad)) {
      const t = await capture({ content: `bad-${label}`, dedupeKey: `zzt-bad-${label}-${RUN}` });
      await assert.rejects(
        () => db.withAuditActor(actor, (run) =>
          run("update thoughts set content = 'mutated' where id = $1::uuid", [t.id])),
        /valid audit actor/,
        `${label} must be refused`,
      );
      const still = await query("select content from thoughts where id = $1::uuid", [t.id]);
      assert.equal(still.rows[0].content, `bad-${label}`, `${label}: the write must have rolled back`);
    }
  });

  // set_config(..., true) is transaction scoped precisely so a pooled connection
  // cannot carry one caller's identity into the next caller's rows. Under
  // fail-closed the leak test is sharper than before: if the actor DID leak, the
  // unattributed write would succeed instead of being refused.
  it("refuses an unattributed write, and the actor does not leak from the previous transaction", async () => {
    const key = `zzt-leak-${RUN}`;
    const t = await capture({ content: "L1", dedupeKey: key });
    await capture({ content: "L2", dedupeKey: key, actor: ACTOR });   // attributed, commits

    await assert.rejects(
      () => query("update thoughts set content = 'L3' where id = $1::uuid", [t.id]),
      /valid audit actor/,
      "a later write with no actor must be refused, not inherit the committed transaction's actor",
    );

    const rows = await revisions(t.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].old_state.content, "L1");
    assert.equal(rows[0].actor.auth_source, "service_key");
  });

  it("a deliberate maintenance write is allowed when it announces itself", async () => {
    const key = `zzt-maint-${RUN}`;
    const t = await capture({ content: "m1", dedupeKey: key });
    const db = await import("../src/db.mjs");
    const maintenance = { auth_source: "system_maintenance", principal_id: null, is_admin: true };

    await db.withAuditActor(maintenance, (run) =>
      run("update thoughts set content = 'm2' where id = $1::uuid", [t.id]));

    const rows = await revisions(t.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor.auth_source, "system_maintenance");
  });

  it("a restore does not produce a revision either", async () => {
    const key = `zzt-restore-${RUN}`;
    const t = await capture({ content: "r1", dedupeKey: key });
    await store.softDeleteThought({ brainId, thoughtId: t.id, actor: ACTOR });
    await store.restoreThought({ brainId, thoughtId: t.id, actor: ACTOR });
    assert.equal((await revisions(t.id)).length, 0);
  });

  it("records the supplied actor on the revision", async () => {
    const key = `zzt-actor-${RUN}`;
    const t = await capture({ content: "a1", dedupeKey: key });
    await capture({ content: "a2", dedupeKey: key, actor: ACTOR });

    const rows = await revisions(t.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].old_state.content, "a1");
    assert.equal(rows[0].actor.auth_source, "service_key");
    assert.equal(rows[0].actor.is_admin, false);
  });

  it("a soft delete does not also produce a revision", async () => {
    const key = `zzt-delete-${RUN}`;
    const t = await capture({ content: "to delete", dedupeKey: key });
    await store.softDeleteThought({
      brainId,
      thoughtId: t.id,
      actor: ACTOR,
    });
    assert.equal((await revisions(t.id)).length, 0, "a tombstone flip is a lifecycle event, not a content revision");
  });

  it("revisions survive a purge of the thought they describe", async () => {
    const key = `zzt-purge-${RUN}`;
    const t = await capture({ content: "before purge", dedupeKey: key });
    const overwritten = await capture({ content: "after overwrite", dedupeKey: key, actor: ACTOR });
    assert.equal((await revisions(t.id)).length, 1);

    await store.softDeleteThought({ brainId, thoughtId: t.id, actor: ACTOR });
    await store.purgeThought({
      brainId,
      thoughtId: t.id,
      expectedContentHash: overwritten.content_hash,
      expectedDedupeKey: overwritten.dedupe_key,
      actor: ACTOR,
      purgeGraphNode: async () => {},
    });

    const gone = await query("select 1 from thoughts where id = $1::uuid", [t.id]);
    assert.equal(gone.rowCount, 0, "the thought should be hard-deleted");

    const rows = await revisions(t.id);
    assert.equal(rows.length, 1, "the revision must outlive its subject (thought_id is deliberately not a FK)");
    assert.equal(rows[0].old_state.content, "before purge");
  });

  it("thought_audit remains append-only", async () => {
    const key = `zzt-appendonly-${RUN}`;
    const t = await capture({ content: "v1", dedupeKey: key });
    await capture({ content: "v2", dedupeKey: key, actor: ACTOR });

    await assert.rejects(
      () => query("delete from thought_audit where thought_id = $1::uuid", [t.id]),
      /append-only/,
      "a writer that can overwrite must not be able to erase the evidence",
    );
  });
});
