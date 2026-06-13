// Migration 015 — exclude *_conversation_record thoughts from ranked reads.
// DB-backed: a record-type thought must be ABSENT from all five ranked read
// functions, a normal thought PRESENT, and thoughts_stats must STILL count the
// record (exclude-from-retrieval, not from totals). Self-skips if dev DB is
// unreachable; HARD-REFUSES prod.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const EST = "zzr-rec-est";
const BRAIN_SLUG = "zzr-rec-brain";
const TOKEN = "zzr015token";
const EMB = Array(1536).fill(0);
EMB[0] = 1;

let query;
let closePool;
let store;
let brainId;
let recordId;
let normalId;
let sourceId;
let skipReason = false;

try {
  const { config } = await import("../src/config.mjs");
  if (config.postgres?.database === "ob1") {
    skipReason = "refusing to run the migration-015 DB suite against prod 'ob1'";
  } else {
    const db = await import("../src/db.mjs");
    query = db.query;
    closePool = db.closePool;
    await query("select 1");
    store = await import("../src/thought-store.mjs");
  }
} catch (error) {
  skipReason = `dev database unreachable (run via 'direnv exec .'): ${error.message}`;
}
if (skipReason && closePool) {
  try { await closePool(); } catch { /* best effort */ }
  closePool = null;
}

describe("migration 015 — conversation_record exclusion", { skip: skipReason }, () => {
  before(async () => {
    await query(
      `delete from thoughts where brain_id in
         (select b.id from brains b join households h on h.id = b.household_id where h.slug = $1)`,
      [EST],
    );
    await query("delete from households where slug = $1", [EST]);
    await query("insert into households(slug, display_name) values ($1, 'rec test')", [EST]);
    const b = await query(
      `insert into brains(household_id, slug, display_name, kind)
         select id, $2, 'rb', 'personal' from households where slug = $1 returning id`,
      [EST, BRAIN_SLUG],
    );
    brainId = b.rows[0].id;

    const cap = (content, dedupeKey, metadata) =>
      store.captureThought({ brainId, content, embedding: EMB, embeddingModel: "zzr-model", metadata, dedupeKey });

    // A content-free record pointer (the thing to exclude).
    recordId = (await cap(
      `[ChatGPT Export Record: ${TOKEN} thing | 2025-01-01] Canonical raw export record for conversation abc.`,
      "zzr-record",
      { type: "chatgpt_conversation_record", topics: [TOKEN] },
    )).id;
    // A normal content-bearing thought sharing the token + topic.
    normalId = (await cap(
      `${TOKEN} a real distilled note about a genuine fact worth retrieving`,
      "zzr-normal",
      { type: "chatgpt_conversation", topics: [TOKEN] },
    )).id;
    // A source thought to query get_thought_connections from (shares the topic).
    sourceId = (await cap(
      `${TOKEN} the source thought for connection queries`,
      "zzr-source",
      { type: "note", topics: [TOKEN] },
    )).id;
  });

  after(async () => {
    if (!query) return;
    await query("delete from thoughts where brain_id = $1::uuid", [brainId]);
    await query("delete from households where slug = $1", [EST]);
    if (closePool) await closePool();
  });

  const vec = `[${EMB.join(",")}]`;

  it("match_thoughts excludes the record, includes the normal thought", async () => {
    const r = await query(
      "select id::text from match_thoughts($1::uuid, $2::vector, 0.1, 50, '{}'::jsonb)",
      [brainId, vec],
    );
    const ids = r.rows.map((x) => x.id);
    assert.ok(!ids.includes(recordId), "record must be excluded");
    assert.ok(ids.includes(normalId), "normal must be present");
  });

  it("match_thoughts_recency excludes the record", async () => {
    const r = await query(
      "select id::text from match_thoughts_recency($1::uuid, $2::vector, 0.1, 50, '{}'::jsonb, 0.3, 90)",
      [brainId, vec],
    );
    const ids = r.rows.map((x) => x.id);
    assert.ok(!ids.includes(recordId), "record must be excluded");
    assert.ok(ids.includes(normalId), "normal must be present");
  });

  it("list_recent_thoughts excludes the record", async () => {
    const r = await query("select id::text from list_recent_thoughts($1::uuid, 50)", [brainId]);
    const ids = r.rows.map((x) => x.id);
    assert.ok(!ids.includes(recordId), "record must be excluded");
    assert.ok(ids.includes(normalId), "normal must be present");
  });

  it("search_thoughts_text excludes the record", async () => {
    const r = await query("select id::text from search_thoughts_text($1, 50)", [TOKEN]);
    const ids = r.rows.map((x) => x.id);
    assert.ok(!ids.includes(recordId), "record must be excluded");
    assert.ok(ids.includes(normalId), "normal must be present");
  });

  it("get_thought_connections excludes the record from candidates", async () => {
    const r = await query("select id::text from get_thought_connections($1::uuid, 50)", [sourceId]);
    const ids = r.rows.map((x) => x.id);
    assert.ok(!ids.includes(recordId), "record must be excluded from connection candidates");
    assert.ok(ids.includes(normalId), "normal (shares topic) must be present");
  });

  it("thoughts_stats STILL counts the record (exclude from retrieval, not from totals)", async () => {
    const r = await query("select total_thoughts from thoughts_stats($1::uuid)", [brainId]);
    assert.equal(Number(r.rows[0].total_thoughts), 3, "all three thoughts incl. the record are counted");
  });
});
