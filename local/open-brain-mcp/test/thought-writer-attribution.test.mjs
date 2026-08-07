// Writer attribution + the shared-brain overwrite guard (0.8.0, migrations
// 020/021) — DB-backed, like the rest of the thought-store suite: this behaviour
// IS the SQL (a namespaced dedupe key and an ownership predicate on the DO
// UPDATE), so a mock would only prove the mock agrees with itself.
//
// The question these tests exist to keep answerable: on a brain that three
// mutually-distrusting agents share, "which principal wrote this row" and "can
// one of them silently rewrite another's row in place".
//
// Self-skips with an explicit reason when the dev database is unreachable or the
// 020/021 columns are missing, and HARD-REFUSES to run against prod `ob1`.
// Fixtures are `zzt-`-prefixed and torn down.

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// Fixture names are unique per process: several agents run `npm test` against
// the same dev database at once, and a shared fixture slug means one run's setup
// deletes another run's rows mid-transaction.
const RUN = crypto.randomBytes(4).toString("hex");
const EST = `zzt-writer-est-${RUN}`;
const SOLO_BRAIN = `zzt-writer-solo-${RUN}`;
const SHARED_BRAIN = `zzt-writer-shared-${RUN}`;
const PRINCIPAL_A = `zzt-writer-pi-${RUN}`;
const PRINCIPAL_B = `zzt-writer-repo-${RUN}`;

const EMB = Array(1536).fill(0);
EMB[0] = 1;

let query;
let closePool;
let store;
let skipReason = false;

try {
  const { config } = await import("../src/config.mjs");
  if (config.postgres?.database === "ob1") {
    skipReason = "refusing to run the writer-attribution DB suite against prod database 'ob1'";
  } else {
    const db = await import("../src/db.mjs");
    query = db.query;
    closePool = db.closePool;
    await query("select 1");
    const columns = await query(
      `select
         (select count(*) from information_schema.columns
            where table_name = 'thoughts'
              and column_name in ('written_by_principal_id', 'written_by_key_id')) as thought_cols,
         (select count(*) from information_schema.columns
            where table_name = 'brains' and column_name = 'is_shared_agent_brain') as brain_cols`,
    );
    const { thought_cols: thoughtCols, brain_cols: brainCols } = columns.rows[0];
    if (Number(thoughtCols) < 2 || Number(brainCols) < 1) {
      skipReason = "migrations 020/021 are not applied to this database (no writer columns on thoughts / no is_shared_agent_brain on brains)";
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

describe("writer attribution and the shared-brain overwrite guard (DB-backed)", { skip: skipReason }, () => {
  let soloBrainId;
  let sharedBrainId;
  let principalA;
  let principalB;
  let keyA;

  // A capture as a named writer. Everything else is held constant so the only
  // variable across these tests is WHO is writing.
  const capture = (opts) => store.captureThought({
    content: "x",
    embedding: EMB,
    embeddingModel: "zzt-test-model",
    metadata: {},
    ...opts,
  });

  async function readRow(id) {
    const r = await query(
      "select id, content, created_at, written_by_principal_id, written_by_key_id, dedupe_key from thoughts where id = $1::uuid",
      [id],
    );
    return r.rows[0];
  }

  before(async () => {
    await query(
      `delete from thoughts where brain_id in
         (select b.id from brains b join households h on h.id = b.household_id where h.slug = $1)`,
      [EST],
    );
    await query("delete from households where slug = $1", [EST]);
    await query("insert into households(slug, display_name) values ($1, 'writer attribution test')", [EST]);

    const brains = await query(
      `insert into brains(household_id, slug, display_name, kind, egress_class, is_shared_agent_brain)
         select h.id, v.slug, v.slug, v.kind, v.egress, v.shared
         from households h,
              (values ($2, 'personal', 'private_local', false),
                      ($3, 'repo', 'repo', true)) as v(slug, kind, egress, shared)
         where h.slug = $1
         returning id, slug`,
      [EST, SOLO_BRAIN, SHARED_BRAIN],
    );
    soloBrainId = brains.rows.find((r) => r.slug === SOLO_BRAIN).id;
    sharedBrainId = brains.rows.find((r) => r.slug === SHARED_BRAIN).id;

    const principals = await query(
      `insert into brain_principals(household_id, slug, display_name, principal_type)
         select h.id, v.slug, v.slug, v.ptype
         from households h,
              (values ($2, 'caged_agent'),
                      ($3, 'repo_service')) as v(slug, ptype)
         where h.slug = $1
         returning id, slug`,
      [EST, PRINCIPAL_A, PRINCIPAL_B],
    );
    principalA = principals.rows.find((r) => r.slug === PRINCIPAL_A).id;
    principalB = principals.rows.find((r) => r.slug === PRINCIPAL_B).id;

    const key = await query(
      `insert into brain_access_keys(principal_id, brain_id, key_hash, label, credential_type)
       values ($1::uuid, $2::uuid, $3, 'zzt writer key', 'agent_key')
       returning id`,
      [principalA, sharedBrainId, `zzt-${crypto.randomBytes(16).toString("hex")}`],
    );
    keyA = key.rows[0].id;
  });

  afterEach(async () => {
    await query("delete from thoughts where brain_id = any($1::uuid[])", [[soloBrainId, sharedBrainId]]);
  });

  after(async () => {
    await query("delete from thoughts where brain_id = any($1::uuid[])", [[soloBrainId, sharedBrainId]]);
    await query("delete from households where slug = $1", [EST]);
    if (closePool) await closePool();
  });

  // --- attribution ---------------------------------------------------------

  it("captureThought records the writing principal and the exact key row", async () => {
    const row = await capture({
      brainId: soloBrainId, dedupeKey: "w1", content: "attributed",
      writtenByPrincipalId: principalA, writtenByKeyId: keyA,
    });
    assert.equal(row.written_by_principal_id, principalA);
    assert.equal(row.written_by_key_id, keyA);
    const stored = await readRow(row.id);
    assert.equal(stored.written_by_principal_id, principalA, "attribution is persisted, not just returned");
    assert.equal(stored.written_by_key_id, keyA);
  });

  it("an unattributed writer stores NULL rather than guessing", async () => {
    const row = await capture({ brainId: soloBrainId, dedupeKey: "w2", content: "legacy admin" });
    assert.equal(row.written_by_principal_id, null, "NULL means unknown (021: never retro-attributed)");
    assert.equal(row.written_by_key_id, null);
  });

  it("an unattributed re-capture never ERASES a known writer", async () => {
    const first = await capture({
      brainId: soloBrainId, dedupeKey: "w3", content: "v1",
      writtenByPrincipalId: principalA, writtenByKeyId: keyA,
    });
    const second = await capture({ brainId: soloBrainId, dedupeKey: "w3", content: "v2" });
    assert.equal(second.id, first.id);
    assert.equal(second.content, "v2");
    assert.equal(second.written_by_principal_id, principalA, "attribution survives an unattributed re-capture");
    assert.equal(second.written_by_key_id, keyA);
  });

  it("the containment query answers 'what did this principal write in this brain'", async () => {
    const mine = await capture({
      brainId: soloBrainId, dedupeKey: "w4a", content: "mine", writtenByPrincipalId: principalA,
    });
    await capture({ brainId: soloBrainId, dedupeKey: "w4b", content: "theirs", writtenByPrincipalId: principalB });
    await capture({ brainId: soloBrainId, dedupeKey: "w4c", content: "unknown" });

    const r = await query(
      "select id from thoughts where brain_id = $1::uuid and written_by_principal_id = $2::uuid",
      [soloBrainId, principalA],
    );
    assert.deepEqual(r.rows.map((x) => x.id), [mine.id], "NULL rows are unknown, not implicitly this principal's");
  });

  // --- the overwrite guard -------------------------------------------------
  //
  // dedupe_key defaults to sha256(content), which any principal that can READ a
  // row can recompute. These are the cases that decide whether recomputing it
  // buys an overwrite.

  it("SHARED brain: a second principal capturing IDENTICAL content inserts its own row", async () => {
    const first = await capture({
      brainId: sharedBrainId, content: "identical content", writtenByPrincipalId: principalA, writtenByKeyId: keyA,
    });
    const second = await capture({
      brainId: sharedBrainId, content: "identical content", writtenByPrincipalId: principalB,
    });

    assert.notEqual(second.id, first.id, "no silent in-place rewrite of another principal's row");
    assert.equal(second.written_by_principal_id, principalB);

    const original = await readRow(first.id);
    assert.equal(original.content, "identical content");
    assert.equal(original.written_by_principal_id, principalA, "the original row keeps its writer");
    assert.equal(original.written_by_key_id, keyA);
    assert.deepEqual(original.created_at, (await readRow(first.id)).created_at);
  });

  it("SHARED brain: an EXPLICIT dedupe key does not let one principal overwrite another's row", async () => {
    const first = await capture({
      brainId: sharedBrainId, dedupeKey: "collide", content: "written by A", writtenByPrincipalId: principalA,
    });
    const second = await capture({
      brainId: sharedBrainId, dedupeKey: "collide", content: "hijacked by B", writtenByPrincipalId: principalB,
    });
    assert.notEqual(second.id, first.id);

    const original = await readRow(first.id);
    assert.equal(original.content, "written by A", "A's content is untouched");
    assert.notEqual(original.dedupe_key, (await readRow(second.id)).dedupe_key, "each writer has its own key namespace");

    const live = await query(
      "select count(*)::int as n from thoughts where brain_id = $1::uuid and deleted_at is null",
      [sharedBrainId],
    );
    assert.equal(live.rows[0].n, 2, "both rows are live");
  });

  it("SHARED brain: the SAME principal re-capturing still upserts its own row in place", async () => {
    const first = await capture({
      brainId: sharedBrainId, dedupeKey: "mine", content: "v1", writtenByPrincipalId: principalA, writtenByKeyId: keyA,
    });
    const second = await capture({
      brainId: sharedBrainId, dedupeKey: "mine", content: "v2", writtenByPrincipalId: principalA, writtenByKeyId: keyA,
    });
    assert.equal(second.id, first.id, "idempotent re-import by the same writer must still work");
    assert.equal(second.content, "v2");
  });

  it("SHARED brain: an unattributed writer owns nothing, so it can overwrite nothing", async () => {
    // A row written BEFORE the per-writer namespace existed: a raw dedupe key
    // that an unattributed capture will collide with head-on. This is the
    // residual case the namespaced key alone cannot cover.
    const legacy = await query(
      `insert into thoughts (brain_id, content, embedding, embedding_model, embedding_dimension,
                             dedupe_key, metadata, written_by_principal_id)
       values ($1::uuid, 'legacy row', $2::vector, 'zzt-test-model', $3, 'legacy-key', '{}'::jsonb, $4::uuid)
       returning id`,
      [sharedBrainId, `[${EMB.join(",")}]`, EMB.length, principalA],
    );
    const legacyId = legacy.rows[0].id;

    await assert.rejects(
      () => capture({ brainId: sharedBrainId, dedupeKey: "legacy-key", content: "overwritten" }),
      (e) => e.name === "ThoughtStoreError" && e.kind === "not_found",
      "an unattributed writer must not inherit an attributed row",
    );
    assert.equal((await readRow(legacyId)).content, "legacy row", "the attributed row is untouched");
  });

  it("SHARED brain: a DIFFERENT principal cannot take over a pre-namespace row either", async () => {
    const legacy = await query(
      `insert into thoughts (brain_id, content, embedding, embedding_model, embedding_dimension,
                             dedupe_key, metadata, written_by_principal_id)
       values ($1::uuid, 'A wrote this', $2::vector, 'zzt-test-model', $3, 'legacy-key-2', '{}'::jsonb, $4::uuid)
       returning id`,
      [sharedBrainId, `[${EMB.join(",")}]`, EMB.length, principalA],
    );
    const legacyId = legacy.rows[0].id;

    // B's key is namespaced, so B cannot even address A's raw key: it inserts.
    const mine = await capture({
      brainId: sharedBrainId, dedupeKey: "legacy-key-2", content: "B wrote this", writtenByPrincipalId: principalB,
    });
    assert.notEqual(mine.id, legacyId);
    assert.equal((await readRow(legacyId)).content, "A wrote this");
  });

  // --- the non-shared brain must not change behaviour ----------------------

  it("NON-shared brain: dedupe stays global, so identical content still upserts one row", async () => {
    const first = await capture({
      brainId: soloBrainId, content: "same text", writtenByPrincipalId: principalA,
    });
    const second = await capture({
      brainId: soloBrainId, content: "same text", writtenByPrincipalId: principalB,
    });
    assert.equal(second.id, first.id, "single-tenant idempotent import is unchanged");
    assert.equal(second.written_by_principal_id, principalB, "attribution follows the last writer");
    assert.equal(first.dedupe_key, second.dedupe_key);
    assert.doesNotMatch(first.dedupe_key, /:/, "no writer namespace on a non-shared brain");
  });

  it("peekCaptureConflictTier looks at the SAME key the capture will conflict on", async () => {
    await capture({
      brainId: sharedBrainId, dedupeKey: "peek", content: "A's row",
      sensitivityTier: "standard", writtenByPrincipalId: principalA,
    });
    assert.equal(
      await store.peekCaptureConflictTier({ brainId: sharedBrainId, dedupeKey: "peek", writtenByPrincipalId: principalA }),
      "standard",
      "the writer's own row is visible to its own preflight",
    );
    assert.equal(
      await store.peekCaptureConflictTier({ brainId: sharedBrainId, dedupeKey: "peek", writtenByPrincipalId: principalB }),
      undefined,
      "another principal's row is not the row B would upsert over",
    );
  });

  // The preflight is what keeps restricted content away from the cloud
  // processors: it runs BEFORE embedding/LLM, and the store's tier guard is only
  // the after-the-fact backstop. On a shared brain the writer is part of the
  // key, so a caller that omits it peeks at a key nothing is stored under and
  // gets a clean bill of health for a row it is about to upsert over. Stated as
  // a test because the requirement lives in a comment on the caller's side.
  //
  // The fixture row is `standard` only because a restricted thought cannot live
  // in a cloud-readable brain at all (016/018) — the blindness is a property of
  // the key namespace, not of the tier, and it is a private_local shared agent
  // brain where it turns into a leak.
  it("peekCaptureConflictTier is BLIND on a shared brain when the caller omits the writer", async () => {
    await capture({
      brainId: sharedBrainId, dedupeKey: "blind", content: "A's row",
      sensitivityTier: "standard", writtenByPrincipalId: principalA,
    });
    assert.equal(
      await store.peekCaptureConflictTier({ brainId: sharedBrainId, dedupeKey: "blind", writtenByPrincipalId: principalA }),
      "standard",
    );
    assert.equal(
      await store.peekCaptureConflictTier({ brainId: sharedBrainId, dedupeKey: "blind" }),
      undefined,
      "every capture call site must pass the SAME writer it will capture with",
    );
  });

  // Attribution is evidence: it has to survive the event it is evidence of.
  it("a key that authored history cannot be deleted out from under its rows", async () => {
    await capture({
      brainId: sharedBrainId, dedupeKey: "evidence", content: "written under key A",
      writtenByPrincipalId: principalA, writtenByKeyId: keyA,
    });
    await assert.rejects(
      () => query("delete from brain_access_keys where id = $1::uuid", [keyA]),
      /violates foreign key constraint/,
      "021: on delete restrict — evidence is retired by revocation, never deleted",
    );
    // Revocation (the supported path) leaves the attribution intact.
    await query("update brain_access_keys set is_active = false where id = $1::uuid", [keyA]);
    const r = await query(
      "select count(*)::int as n from thoughts where written_by_key_id = $1::uuid",
      [keyA],
    );
    assert.equal(r.rows[0].n, 1);
    await query("update brain_access_keys set is_active = true where id = $1::uuid", [keyA]);
  });
});
