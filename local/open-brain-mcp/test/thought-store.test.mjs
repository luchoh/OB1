// Thought store — DB-backed suite (module 2 of PRD docs/34).
//
// This module's logic IS the SQL, so these tests run against the real dev
// database — they are NOT mocked. They self-skip with an explicit message when
// the database is unreachable (run them via `direnv exec . npm test` from the
// repo root) and HARD-REFUSE to run against prod `ob1`.
//
// Fixtures are `zzt-`-prefixed and torn down. One deliberate exception: rows in
// `thought_audit` are append-only (migration 012 enforces a raise-on-delete
// trigger — even the app role cannot erase the trail), so teardown drops the
// fixture household/brain/thoughts but leaves the audit rows. Every audit
// assertion below keys on the specific `thought_id` under test, which is fresh
// per test, so leftover rows never cross-contaminate.

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";

const EST = "zzt-store-est";
const BRAIN_SLUG = "zzt-store-brain";

// A valid 1536-d unit vector (the embedding column is vector(1536) with a
// dimension CHECK; a zero vector would make cosine similarity NaN).
const EMB = Array(1536).fill(0);
EMB[0] = 1;

const ACTOR = { auth_source: "service_key", principal_id: "zzt-p", is_admin: false };
const LEGACY_ACTOR = { auth_source: "legacy_admin_key", principal_id: null, is_admin: true };

// --- Resolve infra, or compute a clean skip reason -------------------------
let query;
let closePool;
let store;
let brainId;
let skipReason = false;

try {
  const { config } = await import("../src/config.mjs");
  const dbName = config.postgres?.database;
  if (dbName === "ob1") {
    skipReason = "refusing to run the thought-store DB suite against prod database 'ob1'";
  } else {
    const db = await import("../src/db.mjs");
    query = db.query;
    closePool = db.closePool;
    await query("select 1");
    store = await import("../src/thought-store.mjs");
  }
} catch (error) {
  skipReason = `dev database unreachable (run via 'direnv exec .' from the repo root): ${error.message}`;
}
// If a pool was created but we are skipping, close it so the process can exit.
if (skipReason && closePool) {
  try {
    await closePool();
  } catch {
    /* best effort */
  }
  closePool = null;
}

// --- Helpers ---------------------------------------------------------------
async function capture({ content, dedupeKey, metadata = {} }) {
  return store.captureThought({
    brainId,
    content,
    embedding: EMB,
    embeddingModel: "zzt-test-model",
    metadata,
    dedupeKey,
  });
}

async function rowExists(thoughtId) {
  const r = await query("select 1 from thoughts where id = $1::uuid", [thoughtId]);
  return r.rowCount > 0;
}

async function deletedAt(thoughtId) {
  const r = await query("select deleted_at from thoughts where id = $1::uuid", [thoughtId]);
  return r.rowCount === 0 ? undefined : r.rows[0].deleted_at;
}

async function auditRows(thoughtId, action) {
  const sql = action
    ? "select * from thought_audit where thought_id = $1::uuid and action = $2 order by at"
    : "select * from thought_audit where thought_id = $1::uuid order by at";
  const r = await query(sql, action ? [thoughtId, action] : [thoughtId]);
  return r.rows;
}

function graphSpy() {
  const calls = [];
  const fn = async (canonicalId) => {
    calls.push({ canonicalId, rowPresentAtCall: await rowExists(calls.lastThoughtId) });
  };
  fn.calls = calls;
  return fn;
}

// --- Suite -----------------------------------------------------------------
describe("thought store (DB-backed)", { skip: skipReason }, () => {
  before(async () => {
    await query(
      `delete from thoughts where brain_id in
         (select b.id from brains b join households h on h.id = b.household_id where h.slug = $1)`,
      [EST],
    );
    await query("delete from households where slug = $1", [EST]);
    await query("insert into households(slug, display_name) values ($1, 'store test')", [EST]);
    const b = await query(
      `insert into brains(household_id, slug, display_name, kind)
         select id, $2, 'sb', 'personal' from households where slug = $1
         returning id`,
      [EST, BRAIN_SLUG],
    );
    brainId = b.rows[0].id;
  });

  afterEach(async () => {
    // Reset the brain between tests. thought_audit rows are append-only and
    // intentionally survive (see file header).
    await query("delete from thoughts where brain_id = $1::uuid", [brainId]);
  });

  after(async () => {
    await query("delete from thoughts where brain_id = $1::uuid", [brainId]);
    await query("delete from households where slug = $1", [EST]);
    if (closePool) await closePool();
  });

  // --- capture / upsert ---
  it("captureThought inserts a live row and lifts metadata.type into the column", async () => {
    const row = await capture({ content: "first thought", dedupeKey: "c1", metadata: { type: "note", source: "test" } });
    assert.ok(row.id);
    assert.equal(row.brain_id, brainId);
    assert.equal(row.content, "first thought");
    assert.equal(row.type, "note");
    assert.equal(await rowExists(row.id), true);
    assert.equal(await deletedAt(row.id), null);
  });

  it("captureThought upserts on (brain_id, dedupe_key): same row id, merged metadata", async () => {
    const first = await capture({ content: "v1", dedupeKey: "dup", metadata: { a: 1 } });
    const second = await capture({ content: "v2", dedupeKey: "dup", metadata: { b: 2 } });
    assert.equal(second.id, first.id, "same dedupe key updates the same row");
    assert.equal(second.content, "v2");
    assert.equal(second.metadata.a, 1, "prior metadata preserved");
    assert.equal(second.metadata.b, 2, "new metadata merged in");
  });

  it("captureThought after soft-delete of the same key inserts a NEW row (D6 resurrection)", async () => {
    const original = await capture({ content: "res", dedupeKey: "rk" });
    await store.softDeleteThought({ brainId, thoughtId: original.id, actor: ACTOR });
    const resurrected = await capture({ content: "res again", dedupeKey: "rk" });
    assert.notEqual(resurrected.id, original.id, "partial unique index lets a tombstone + live row coexist");
    assert.notEqual(await deletedAt(original.id), null, "the tombstone stays deleted");
    assert.equal(await deletedAt(resurrected.id), null, "the new row is live");
  });

  // --- egress-boundary stamp (docs/45 §6.8/§6.11, slice 4). The fixture brain
  //     is private_local (kind 'personal' → 016 default), so restricted captures
  //     are allowed here; the monotone-conflict cases also exercise the 016
  //     monotonic-taint trigger (a downgrade must not be attempted/persisted). ---
  const cap = (extra) => store.captureThought({
    brainId, content: extra.content ?? "x", embedding: EMB, embeddingModel: "zzt-test-model",
    metadata: {}, ...extra,
  });

  it("captureThought persists the egress stamp columns on insert", async () => {
    const row = await cap({ dedupeKey: "st1", content: "stamped", sensitivityTier: "restricted", originEgressClass: "cloud_origin", sourceTrustClass: "trusted", reviewState: "unreviewed" });
    assert.equal(row.sensitivity_tier, "restricted");
    assert.equal(row.origin_egress_class, "cloud_origin");
    assert.equal(row.source_trust_class, "trusted");
    assert.equal(row.review_state, "unreviewed");
  });

  it("captureThought defaults sensitivity_tier to standard when not provided", async () => {
    const row = await cap({ dedupeKey: "st2", originEgressClass: "local_trusted", sourceTrustClass: "trusted", reviewState: "none" });
    assert.equal(row.sensitivity_tier, "standard");
    assert.equal(row.origin_egress_class, "local_trusted");
  });

  it("re-capture taints origin monotonically: local_trusted then cloud_origin → cloud_origin", async () => {
    const first = await cap({ dedupeKey: "stmono", content: "v1", originEgressClass: "local_trusted", reviewState: "none" });
    assert.equal(first.origin_egress_class, "local_trusted");
    const second = await cap({ dedupeKey: "stmono", content: "v2", originEgressClass: "cloud_origin", reviewState: "none" });
    assert.equal(second.id, first.id);
    assert.equal(second.origin_egress_class, "cloud_origin", "cloud taint applied on re-capture");
  });

  it("re-capture cannot wash cloud_origin back to local_trusted (monotone; trigger-safe)", async () => {
    const first = await cap({ dedupeKey: "stwash", content: "v1", originEgressClass: "cloud_origin", reviewState: "none" });
    const second = await cap({ dedupeKey: "stwash", content: "v2", originEgressClass: "local_trusted", reviewState: "none" });
    assert.equal(second.id, first.id);
    assert.equal(second.origin_egress_class, "cloud_origin", "cloud_origin sticks despite a local re-capture");
  });

  it("re-capture does not clear an existing quarantine (review_state)", async () => {
    // local_trusted: re-capturing a restricted row is allowed (the cloud_bound
    // upsert-over-restricted denial is exercised separately below).
    const first = await cap({ dedupeKey: "stq", content: "q1", sensitivityTier: "restricted", originEgressClass: "cloud_origin", reviewState: "unreviewed", callerReadEgressClass: "local_trusted" });
    assert.equal(first.review_state, "unreviewed");
    const second = await cap({ dedupeKey: "stq", content: "q2", sensitivityTier: "restricted", originEgressClass: "cloud_origin", reviewState: "none", callerReadEgressClass: "local_trusted" });
    assert.equal(second.review_state, "unreviewed", "re-capture must not clear the quarantine");
  });

  // --- Layer C write-guard (docs/45 §6.10): a cloud_bound caller may not mutate
  //     an existing restricted row; it appears NOT_FOUND (no existence oracle).
  //     local_trusted may; a standard row stays mutable by cloud_bound. Absent
  //     caller egress fails closed (cloud_bound). ---
  const notFound = (e) => e.name === "ThoughtStoreError" && e.kind === "not_found";

  it("Layer C: cloud_bound cannot patch a restricted row (NOT_FOUND); local_trusted can", async () => {
    const row = await cap({ dedupeKey: "lcp", sensitivityTier: "restricted", originEgressClass: "local_trusted", reviewState: "none" });
    await assert.rejects(() => store.patchThoughtMetadata({ brainId, thoughtId: row.id, status: "x", callerReadEgressClass: "cloud_bound" }), notFound);
    const ok = await store.patchThoughtMetadata({ brainId, thoughtId: row.id, status: "x", callerReadEgressClass: "local_trusted" });
    assert.equal(ok.status, "x");
  });

  it("Layer C: cloud_bound CAN patch a standard row", async () => {
    const row = await cap({ dedupeKey: "lcs" });
    const ok = await store.patchThoughtMetadata({ brainId, thoughtId: row.id, status: "ok", callerReadEgressClass: "cloud_bound" });
    assert.equal(ok.status, "ok");
  });

  it("Layer C: cloud_bound cannot soft-delete or restore a restricted row; local_trusted can", async () => {
    const row = await cap({ dedupeKey: "lcd", sensitivityTier: "restricted", originEgressClass: "local_trusted", reviewState: "none" });
    await assert.rejects(() => store.softDeleteThought({ brainId, thoughtId: row.id, actor: ACTOR, callerReadEgressClass: "cloud_bound" }), notFound);
    await store.softDeleteThought({ brainId, thoughtId: row.id, actor: ACTOR, callerReadEgressClass: "local_trusted" });
    await assert.rejects(() => store.restoreThought({ brainId, thoughtId: row.id, actor: ACTOR, callerReadEgressClass: "cloud_bound" }), notFound);
    const r = await store.restoreThought({ brainId, thoughtId: row.id, actor: ACTOR, callerReadEgressClass: "local_trusted" });
    assert.equal(r.outcome, "restored");
  });

  it("Layer C: absent/unknown caller egress fails closed (cannot mutate a restricted row)", async () => {
    const row = await cap({ dedupeKey: "lcu", sensitivityTier: "restricted", originEgressClass: "local_trusted", reviewState: "none" });
    await assert.rejects(() => store.patchThoughtMetadata({ brainId, thoughtId: row.id, status: "x" }), notFound);
  });

  // --- Layer C, capture-upsert path (docs/45 §6.10 / Codex v3 F1): a cloud_bound
  //     caller may not upsert OVER an existing restricted row (its content must
  //     not change). local_trusted may; a standard row stays re-capturable. ---
  it("Layer C: cloud_bound cannot upsert-over an existing restricted row (content unchanged); local_trusted can", async () => {
    const first = await cap({ dedupeKey: "uc1", content: "v1", sensitivityTier: "restricted", originEgressClass: "local_trusted", reviewState: "none", callerReadEgressClass: "local_trusted" });
    assert.equal(first.sensitivity_tier, "restricted");
    await assert.rejects(() => cap({ dedupeKey: "uc1", content: "hacked", callerReadEgressClass: "cloud_bound" }), notFound);
    const check = await query("select content from thoughts where id = $1::uuid", [first.id]);
    assert.equal(check.rows[0].content, "v1", "cloud_bound upsert must not mutate the restricted row");
    const second = await cap({ dedupeKey: "uc1", content: "v2", callerReadEgressClass: "local_trusted" });
    assert.equal(second.id, first.id);
    assert.equal(second.content, "v2");
  });

  it("Layer C: cloud_bound CAN re-capture over a standard row", async () => {
    const first = await cap({ dedupeKey: "uc2", content: "s1", callerReadEgressClass: "cloud_bound" });
    const second = await cap({ dedupeKey: "uc2", content: "s2", callerReadEgressClass: "cloud_bound" });
    assert.equal(second.id, first.id);
    assert.equal(second.content, "s2");
  });

  // peekBrainEgressClass backs the capture preflight (review #5): a restricted
  // capture into a non-private brain is rejected BEFORE the processors run.
  it("peekBrainEgressClass returns the brain class (private_local fixture); null for a missing brain", async () => {
    assert.equal(await store.peekBrainEgressClass({ brainId }), "private_local");
    assert.equal(await store.peekBrainEgressClass({ brainId: "00000000-0000-4000-8000-000000000000" }), null);
  });

  // migration 018 (review #12): a brain cannot be opened to a cloud-readable
  // class while it holds a restricted thought (a one-column declassification).
  it("brain egress guard: cannot open a brain to public/repo while it holds a restricted thought", async () => {
    await cap({ dedupeKey: "bd1", sensitivityTier: "restricted", originEgressClass: "local_trusted", reviewState: "none", callerReadEgressClass: "local_trusted" });
    await assert.rejects(() => query("update brains set egress_class = 'public' where id = $1::uuid", [brainId]), /restricted/i);
    await assert.rejects(() => query("update brains set egress_class = 'repo' where id = $1::uuid", [brainId]), /restricted/i);
    const r = await query("select egress_class from brains where id = $1::uuid", [brainId]);
    assert.equal(r.rows[0].egress_class, "private_local", "rejected update must not have changed the brain");
  });

  // --- soft-delete / restore ---
  it("softDeleteThought sets deleted_at and writes exactly one delete audit row", async () => {
    const row = await capture({ content: "to delete", dedupeKey: "d1" });
    const res = await store.softDeleteThought({ brainId, thoughtId: row.id, actor: ACTOR });
    assert.equal(res.outcome, "deleted");
    assert.notEqual(await deletedAt(row.id), null);
    const audit = await auditRows(row.id, "delete");
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].actor, ACTOR);
  });

  it("softDeleteThought is idempotent: a second delete adds no audit row", async () => {
    const row = await capture({ content: "twice", dedupeKey: "d2" });
    await store.softDeleteThought({ brainId, thoughtId: row.id, actor: ACTOR });
    const again = await store.softDeleteThought({ brainId, thoughtId: row.id, actor: ACTOR });
    assert.equal(again.outcome, "already_deleted");
    assert.equal((await auditRows(row.id, "delete")).length, 1, "no second delete audit row");
  });

  it("softDeleteThought on a missing / out-of-brain thought is NOT_FOUND", async () => {
    await assert.rejects(
      () => store.softDeleteThought({ brainId, thoughtId: "00000000-0000-4000-8000-000000000000", actor: ACTOR }),
      (e) => e.name === "ThoughtStoreError" && e.kind === "not_found",
    );
  });

  it("restoreThought clears deleted_at, audits, and is idempotent", async () => {
    const row = await capture({ content: "restore me", dedupeKey: "r1" });
    await store.softDeleteThought({ brainId, thoughtId: row.id, actor: ACTOR });
    const restored = await store.restoreThought({ brainId, thoughtId: row.id, actor: ACTOR });
    assert.equal(restored.outcome, "restored");
    assert.equal(await deletedAt(row.id), null);
    assert.equal((await auditRows(row.id, "restore")).length, 1);

    const again = await store.restoreThought({ brainId, thoughtId: row.id, actor: ACTOR });
    assert.equal(again.outcome, "already_live");
    assert.equal((await auditRows(row.id, "restore")).length, 1, "restoring a live thought adds no audit row");
  });

  // --- metadata patch ---
  it("patchThoughtMetadata updates a live row; tombstoned and cross-brain are NOT_FOUND", async () => {
    const row = await capture({ content: "patch me", dedupeKey: "p1", metadata: { source: "x" } });
    const patched = await store.patchThoughtMetadata({
      brainId,
      thoughtId: row.id,
      metadataPatch: { user_metadata: { tag: "v" } },
      importance: 5,
    });
    assert.equal(patched.id, row.id);
    assert.equal(patched.importance, 5);
    assert.equal(patched.metadata.user_metadata.tag, "v");

    await store.softDeleteThought({ brainId, thoughtId: row.id, actor: ACTOR });
    await assert.rejects(
      () => store.patchThoughtMetadata({ brainId, thoughtId: row.id, metadataPatch: { x: 1 } }),
      (e) => e.kind === "not_found",
      "a soft-deleted thought is invisible to a metadata write",
    );
  });

  // --- purge (Neo4j-first ordering, injected graph delete) ---
  it("purgeThought deletes the node BEFORE the PG row, then audits with a recovery snapshot", async () => {
    const row = await capture({ content: "purge target", dedupeKey: "pg1", metadata: { source: "s" } });
    const spy = graphSpy();
    spy.calls.lastThoughtId = row.id;
    const res = await store.purgeThought({ brainId, thoughtId: row.id, actor: ACTOR, purgeGraphNode: spy });
    assert.equal(res.outcome, "purged");
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].canonicalId, `thought:${row.id}`);
    assert.equal(spy.calls[0].rowPresentAtCall, true, "Neo4j-first: PG row still present when the node is deleted");
    assert.equal(await rowExists(row.id), false, "PG row hard-deleted after the node");
    const audit = await auditRows(row.id, "purge");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].old_state.content, "purge target", "old_state snapshots content for recovery");
  });

  it("purgeThought aborts on a confirmation mismatch without touching the node or row", async () => {
    const row = await capture({ content: "confirm", dedupeKey: "pg2" });
    const spy = graphSpy();
    await assert.rejects(
      () => store.purgeThought({
        brainId,
        thoughtId: row.id,
        expectedContentHash: "definitely-wrong",
        actor: ACTOR,
        purgeGraphNode: spy,
      }),
      (e) => e.kind === "confirmation_mismatch",
    );
    assert.equal(spy.calls.length, 0, "graph not touched on a failed confirmation");
    assert.equal(await rowExists(row.id), true, "PG row intact");
  });

  it("purgeThought aborts BEFORE the PG delete when the graph delete fails (pointer survives)", async () => {
    const row = await capture({ content: "graph down", dedupeKey: "pg3" });
    const failing = async () => {
      throw new Error("neo4j unreachable");
    };
    await assert.rejects(
      () => store.purgeThought({ brainId, thoughtId: row.id, actor: ACTOR, purgeGraphNode: failing }),
      /neo4j unreachable/,
    );
    assert.equal(await rowExists(row.id), true, "PG row (the only pointer) survives a graph outage");
  });

  it("purgeThought on a PG-gone orphan cleans graph residue and records a graph_only purge", async () => {
    const row = await capture({ content: "orphan", dedupeKey: "pg4" });
    // Simulate a past raw-delete: remove the PG row directly, leaving only graph residue.
    await query("delete from thoughts where id = $1::uuid", [row.id]);
    const spy = graphSpy();
    const res = await store.purgeThought({ brainId, thoughtId: row.id, actor: ACTOR, purgeGraphNode: spy });
    assert.equal(res.outcome, "graph_only");
    assert.equal(spy.calls.length, 1);
    const audit = await auditRows(row.id, "purge");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].old_state.orphan, true);
  });

  it("purgeThought with a wrong brain (thought lives elsewhere) is NOT_FOUND, node untouched", async () => {
    const row = await capture({ content: "wrong brain", dedupeKey: "pg5" });
    const spy = graphSpy();
    const otherBrain = "00000000-0000-4000-8000-0000000000ff";
    await assert.rejects(
      () => store.purgeThought({ brainId: otherBrain, thoughtId: row.id, actor: ACTOR, purgeGraphNode: spy }),
      (e) => e.kind === "not_found",
    );
    assert.equal(spy.calls.length, 0, "a wrong-brain call must not delete the live node");
    assert.equal(await rowExists(row.id), true);
  });

  // --- reads (soft-delete invisibility) ---
  it("readThoughtRowsByIds returns live rows in id order and excludes tombstones", async () => {
    const a = await capture({ content: "row a", dedupeKey: "ra" });
    const b = await capture({ content: "row b", dedupeKey: "rb" });
    const c = await capture({ content: "row c", dedupeKey: "rc" });
    await store.softDeleteThought({ brainId, thoughtId: b.id, actor: ACTOR });

    const ids = [a.id, b.id, c.id];
    const rows = await store.readThoughtRowsByIds({ brainId, ids, filter: {} });
    assert.deepEqual(rows.map((r) => r.id), [a.id, c.id], "tombstone excluded, order preserved");

    // brain scoping: a foreign brain id returns nothing
    const none = await store.readThoughtRowsByIds({ brainId: "00000000-0000-4000-8000-0000000000ff", ids, filter: {} });
    assert.equal(none.length, 0);
  });

  it("brainStats counts exclude soft-deleted thoughts", async () => {
    const a = await capture({ content: "stat a", dedupeKey: "sa", metadata: { source: "email", type: "note" } });
    await capture({ content: "stat b", dedupeKey: "sb", metadata: { source: "email", type: "note" } });
    await capture({ content: "stat c", dedupeKey: "sc", metadata: { source: "web", type: "fact" } });
    await store.softDeleteThought({ brainId, thoughtId: a.id, actor: ACTOR });

    const stats = await store.brainStats(brainId);
    const emailSource = stats.top_sources.find((s) => s.source === "email");
    assert.equal(Number(emailSource.count), 1, "the deleted email thought is not counted");
    const webSource = stats.top_sources.find((s) => s.source === "web");
    assert.equal(Number(webSource.count), 1);
  });

  // --- audit integrity ---
  it("the audit actor is recorded verbatim, including a null principal for legacy-admin", async () => {
    const row = await capture({ content: "legacy delete", dedupeKey: "leg" });
    await store.softDeleteThought({ brainId, thoughtId: row.id, actor: LEGACY_ACTOR });
    const audit = await auditRows(row.id, "delete");
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].actor, LEGACY_ACTOR);
    assert.equal(audit[0].actor.principal_id, null);
  });

  it("thought_audit is append-only: deleting an audit row is rejected by the DB", async () => {
    const row = await capture({ content: "append only", dedupeKey: "ao" });
    await store.softDeleteThought({ brainId, thoughtId: row.id, actor: ACTOR });
    await assert.rejects(
      () => query("delete from thought_audit where thought_id = $1::uuid", [row.id]),
      /append-only/,
    );
  });
});
