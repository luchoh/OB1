// Migration 013 — retrieval SQL correctness (PRD docs/39 Package 1).
//
// DB-backed assertions, split because the rank fix is a DELIBERATE change, not
// pure equivalence (PRD Testing):
//   (c) each redefined function carries provolatile = 's' AND keeps its
//       non-default attributes (search_thoughts_text statement_timeout;
//       get_thought_connections security definer / search_path);
//   (b) a row with NULL importance/quality_score now ranks the SAME as an
//       explicit-default row (importance 3, quality_score 50) — the fix —
//       and DIFFERENTLY from the old 5 / 0.50 fallback.
//
// Functions are addressed by their exact live signature (identity arguments),
// because legacy single-tenant overloads of these names still exist in the
// catalog. Self-skips when the dev DB is unreachable; HARD-REFUSES prod.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// The three functions 013 redefines, keyed by their LIVE identity arguments.
const LIVE = {
  match_thoughts:
    "target_brain_id uuid, query_embedding vector, match_threshold double precision, match_count integer, filter jsonb",
  search_thoughts_text: "p_query text, p_limit integer, p_filter jsonb, p_offset integer",
  get_thought_connections: "p_thought_id uuid, p_limit integer, p_exclude_restricted boolean",
  list_recent_thoughts: "target_brain_id uuid, list_count integer, filter jsonb",
  thoughts_stats: "target_brain_id uuid",
};

const EST = "zzm-mig013-est";
const BRAIN_SLUG = "zzm-mig013-brain";
const TOKEN = "zzqmarker013"; // unique so search_thoughts_text matches only our rows
const EMB = Array(1536).fill(0);
EMB[0] = 1;

let query;
let closePool;
let store;
let brainId;
let skipReason = false;

try {
  const { config } = await import("../src/config.mjs");
  if (config.postgres?.database === "ob1") {
    skipReason = "refusing to run the migration-013 DB suite against prod database 'ob1'";
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
if (skipReason && closePool) {
  try {
    await closePool();
  } catch {
    /* best effort */
  }
  closePool = null;
}

async function provolatile(name) {
  const r = await query(
    `select provolatile, prosecdef, proconfig
       from pg_proc
      where proname = $1 and pg_get_function_identity_arguments(oid) = $2`,
    [name, LIVE[name]],
  );
  assert.equal(r.rowCount, 1, `expected exactly one ${name} with the live signature`);
  return r.rows[0];
}

describe("migration 013 — volatility + preserved attributes", { skip: skipReason }, () => {
  it("marks match_thoughts STABLE", async () => {
    assert.equal((await provolatile("match_thoughts")).provolatile, "s");
  });

  it("marks search_thoughts_text STABLE and keeps statement_timeout", async () => {
    const p = await provolatile("search_thoughts_text");
    assert.equal(p.provolatile, "s");
    assert.ok(
      (p.proconfig ?? []).some((c) => c.startsWith("statement_timeout=")),
      "statement_timeout must survive the re-emit",
    );
  });

  it("marks get_thought_connections STABLE and keeps security definer / search_path", async () => {
    const p = await provolatile("get_thought_connections");
    assert.equal(p.provolatile, "s");
    assert.equal(p.prosecdef, true);
    assert.ok((p.proconfig ?? []).some((c) => c.startsWith("search_path=")));
  });

  it("marks the LANGUAGE sql functions list_recent_thoughts and thoughts_stats STABLE", async () => {
    // These default to VOLATILE like every other function; story 1 wants them
    // marked with their true (STABLE) volatility, not left mismarked.
    assert.equal((await provolatile("list_recent_thoughts")).provolatile, "s");
    assert.equal((await provolatile("thoughts_stats")).provolatile, "s");
  });
});

describe("migration 013 — rank fallback fix (search_thoughts_text)", { skip: skipReason }, () => {
  let nullId;
  let defaultId;
  let oldFallbackId;

  before(async () => {
    await query(
      `delete from thoughts where brain_id in
         (select b.id from brains b join households h on h.id = b.household_id where h.slug = $1)`,
      [EST],
    );
    await query("delete from households where slug = $1", [EST]);
    await query("insert into households(slug, display_name) values ($1, 'mig013')", [EST]);
    const b = await query(
      `insert into brains(household_id, slug, display_name, kind)
         select id, $2, 'mb', 'personal' from households where slug = $1 returning id`,
      [EST, BRAIN_SLUG],
    );
    brainId = b.rows[0].id;

    const content = `the ${TOKEN} fact stays identical across rows`;
    const cap = (dk) =>
      store.captureThought({
        brainId,
        content,
        embedding: EMB,
        embeddingModel: "zzm-model",
        metadata: {},
        dedupeKey: dk,
      });
    nullId = (await cap("zzm-null")).id;
    defaultId = (await cap("zzm-default")).id;
    oldFallbackId = (await cap("zzm-old")).id;

    // Identical content/text-rank; differ ONLY in the rank-fallback inputs.
    await query("update thoughts set importance = null, quality_score = null where id = $1::uuid", [nullId]);
    await query("update thoughts set importance = 3, quality_score = 50 where id = $1::uuid", [defaultId]);
    await query("update thoughts set importance = 5, quality_score = 0.50 where id = $1::uuid", [oldFallbackId]);
  });

  after(async () => {
    await query(
      `delete from thoughts where brain_id in
         (select b.id from brains b join households h on h.id = b.household_id where h.slug = $1)`,
      [EST],
    );
    await query("delete from households where slug = $1", [EST]);
    if (closePool) await closePool();
  });

  it("ranks a NULL-importance/quality row identically to an explicit-default row", async () => {
    const r = await query("select id, rank from search_thoughts_text($1, 50)", [TOKEN]);
    const byId = Object.fromEntries(r.rows.map((row) => [row.id, Number(row.rank)]));
    assert.ok(byId[nullId] !== undefined, "NULL-default row must be returned");
    assert.ok(byId[defaultId] !== undefined, "explicit-default row must be returned");
    assert.ok(
      Math.abs(byId[nullId] - byId[defaultId]) < 1e-6,
      `NULL row (${byId[nullId]}) must equal explicit-default row (${byId[defaultId]})`,
    );
    // And differs from a row carrying the OLD fallback values — proving the
    // fix changed behavior rather than being a no-op.
    assert.ok(
      Math.abs(byId[nullId] - byId[oldFallbackId]) > 1e-6,
      "the fix must change ranking relative to the old 5 / 0.50 fallback",
    );
  });
});
