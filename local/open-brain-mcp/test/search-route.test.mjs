// POST /search route — DB + embedding-service backed integration (self-skips
// when dev infra is unreachable; HARD-REFUSES prod). The projection logic is
// unit-tested separately in search-projection.test.mjs; this verifies the route
// glue: auth, brain-scoping, the slim shape end-to-end, and empty-on-weak-query.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const EST = "zzsr-est";
const BRAIN_SLUG = "zzsr-brain";
const NONCE = "zzsearchnonce20260616 a unique fixture thought body for the search route test";

let app, query, closePool, store, createEmbedding, config, accessKey;
let brainId;
let skipReason = false;
let serviceUp = true;

try {
  const cfg = await import("../src/config.mjs");
  config = cfg.config;
  if (config.postgres?.database === "ob1") {
    skipReason = "refusing to run the /search route suite against prod 'ob1'";
  } else {
    const db = await import("../src/db.mjs");
    query = db.query;
    closePool = db.closePool;
    await query("select 1");
    store = await import("../src/thought-store.mjs");
    createEmbedding = (await import("../src/models.mjs")).createEmbedding;
    app = (await import("../src/server.mjs")).app;
    accessKey = config.accessKey;
  }
} catch (error) {
  skipReason = `dev infra unreachable (run via 'direnv exec .'): ${error.message}`;
}
if (skipReason && closePool) {
  try { await closePool(); } catch { /* best effort */ }
  closePool = null;
}

const req = (body, headers = {}) =>
  app.request("/search", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("POST /search", { skip: skipReason }, () => {
  before(async () => {
    await query(
      `delete from thoughts where brain_id in
         (select b.id from brains b join households h on h.id = b.household_id where h.slug = $1)`,
      [EST],
    );
    await query("delete from households where slug = $1", [EST]);
    await query("insert into households(slug, display_name) values ($1, 'search route test')", [EST]);
    const b = await query(
      `insert into brains(household_id, slug, display_name, kind)
         select id, $2, 'srb', 'personal' from households where slug = $1 returning id`,
      [EST, BRAIN_SLUG],
    );
    brainId = b.rows[0].id;
    // Capture a fixture whose embedding == its own content, so an identical-text
    // query scores cosine ~1.0 and is deterministically retrievable.
    try {
      const emb = await createEmbedding(NONCE);
      await store.captureThought({
        brainId,
        content: NONCE,
        embedding: emb,
        embeddingModel: config.embeddingModel,
        metadata: { type: "note", summary: "fixture summary" },
        dedupeKey: "zzsr-1",
      });
    } catch {
      serviceUp = false; // embedding service unavailable -> skip service-dependent cases
    }
  });

  after(async () => {
    if (!query) return;
    await query("delete from thoughts where brain_id = $1::uuid", [brainId]);
    await query("delete from households where slug = $1", [EST]);
    if (closePool) await closePool();
  });

  it("401 without an access key", async () => {
    const res = await req({ query: "anything" });
    assert.equal(res.status, 401);
  });

  it("rejects a missing query (with a key)", async () => {
    const res = await req({}, { "x-access-key": accessKey });
    assert.notEqual(res.status, 200);
    assert.equal((await res.json()).success, false);
  });

  it("returns ranked slim results for a matching query, scoped to the brain", async () => {
    if (!serviceUp) return; // embedding service down
    const res = await req(
      { query: NONCE, brain: BRAIN_SLUG, min_similarity: 0.5, match_count: 5 },
      { "x-access-key": accessKey },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.results) && body.results.length >= 1, "fixture should be found");
    const r0 = body.results[0];
    assert.deepEqual(Object.keys(r0).sort(), ["brain", "id", "score", "summary", "title"]);
    assert.equal(r0.brain, BRAIN_SLUG);
    assert.ok(typeof r0.score === "number" && r0.score >= 0.5, "score is a number above the floor");
  });

  it("is empty (not an error) when nothing clears the relevance floor", async () => {
    if (!serviceUp) return;
    const res = await req(
      { query: "completely unrelated xyzzy plugh", brain: BRAIN_SLUG, min_similarity: 0.99, match_count: 5 },
      { "x-access-key": accessKey },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.count, 0);
    assert.deepEqual(body.results, []);
  });
});
