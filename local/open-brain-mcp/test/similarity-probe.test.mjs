// Similarity probe — PRD docs/39 Package 2.
//
// Two cuts (PRD Testing):
//   * Pure unit tests over injected data for bucketing, distribution, band
//     recommendation, and report assembly — no I/O, always run.
//   * One DB-backed smoke test that asserts read-only operation BY ENFORCEMENT
//     (a stray write errors inside the probe's `begin transaction read only`)
//     and that the brain-scope predicate never samples a second brain's row.
//
// DB fixtures are `zzp-`-prefixed and torn down; the suite self-skips with an
// explicit message when the dev database is unreachable and HARD-REFUSES prod.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  bucketLabel,
  bucketize,
  summarizeDistribution,
  recommendBand,
  buildReport,
  renderReport,
  runProbe,
  MEASUREMENT_BUCKET_EDGES,
  BELOW_RANGE_LABEL,
} from "../src/similarity-probe.mjs";

// --- Pure unit tests -------------------------------------------------------

describe("bucketLabel", () => {
  it("places similarities in the right 0.05 bucket", () => {
    assert.equal(bucketLabel(0.99), "0.95-1.00");
    assert.equal(bucketLabel(0.95), "0.95-1.00");
    assert.equal(bucketLabel(0.9), "0.90-0.95");
    assert.equal(bucketLabel(0.87), "0.85-0.90");
    assert.equal(bucketLabel(0.7), "0.70-0.75");
  });

  it("sends anything below the measured range to the catch-all", () => {
    assert.equal(bucketLabel(0.69), BELOW_RANGE_LABEL);
    assert.equal(bucketLabel(0.0), BELOW_RANGE_LABEL);
    assert.equal(bucketLabel(-0.3), BELOW_RANGE_LABEL);
  });

  it("rejects non-finite input", () => {
    assert.throws(() => bucketLabel(NaN));
    assert.throws(() => bucketLabel("0.9"));
  });
});

describe("bucketize", () => {
  const pairs = [
    { similarity: 0.99 },
    { similarity: 0.97 },
    { similarity: 0.91 },
    { similarity: 0.5 },
  ];

  it("counts pairs per bucket, highest band first, catch-all last", () => {
    const buckets = bucketize(pairs);
    assert.equal(buckets[0].label, "0.95-1.00");
    assert.equal(buckets[buckets.length - 1].label, BELOW_RANGE_LABEL);
    const byLabel = Object.fromEntries(buckets.map((b) => [b.label, b.count]));
    assert.equal(byLabel["0.95-1.00"], 2);
    assert.equal(byLabel["0.90-0.95"], 1);
    assert.equal(byLabel[BELOW_RANGE_LABEL], 1);
    // every measurement bucket plus the catch-all is present
    assert.equal(buckets.length, MEASUREMENT_BUCKET_EDGES.length); // 6 bands + catch-all - 1 edge
  });

  it("caps the reviewable sample per bucket but keeps the full count", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ similarity: 0.96, id: i }));
    const [top] = bucketize(many, { samplesPerBucket: 3 });
    assert.equal(top.count, 10);
    assert.equal(top.samples.length, 3);
  });
});

describe("summarizeDistribution", () => {
  it("computes count/min/max/mean and percentiles", () => {
    const d = summarizeDistribution([0.1, 0.2, 0.3, 0.4, 0.5]);
    assert.equal(d.count, 5);
    assert.equal(d.min, 0.1);
    assert.equal(d.max, 0.5);
    assert.ok(Math.abs(d.mean - 0.3) < 1e-9);
    assert.ok(Math.abs(d.p50 - 0.3) < 1e-9);
  });

  it("ignores non-finite values and handles the empty case", () => {
    const d = summarizeDistribution([NaN, Infinity, 0.8]);
    assert.equal(d.count, 1);
    assert.equal(d.min, 0.8);
    const empty = summarizeDistribution([]);
    assert.equal(empty.count, 0);
    assert.equal(empty.p50, null);
  });
});

describe("recommendBand", () => {
  it("proposes skip above the near-identical top tail and reconcile below it", () => {
    // 100 pairs: 1 at 0.99, 4 in [0.90,0.95), the rest low.
    const sims = [
      0.99,
      ...Array(4).fill(0.92),
      ...Array(95).fill(0.4),
    ];
    const band = recommendBand(sims, { skipFraction: 0.01, reconcileFraction: 0.05 });
    assert.equal(band.provisional, true);
    assert.ok(band.skip >= band.reconcile, "skip threshold sits at or above reconcile");
    assert.ok(band.skip >= 0.7 && band.skip <= 0.95);
    assert.match(band.note, /PROVISIONAL/);
  });

  it("never auto-adopts: always flagged provisional, even on empty data", () => {
    const band = recommendBand([]);
    assert.equal(band.provisional, true);
    assert.equal(band.basis.total, 0);
  });
});

describe("buildReport / renderReport", () => {
  const pairs = [
    { sourceId: "a", neighborId: "b", similarity: 0.98, sourcePreview: "cat", neighborPreview: "cat!" },
    { sourceId: "c", neighborId: "d", similarity: 0.5, sourcePreview: "dog", neighborPreview: "fish" },
  ];

  it("assembles a JSON-serializable report and renders text", () => {
    const report = buildReport({ brainId: "brain-1", sampleSize: 2, k: 1, pairs });
    assert.equal(report.pairCount, 2);
    assert.equal(report.distribution.count, 2);
    assert.ok(report.recommendedBand.provisional);
    // round-trips through JSON without throwing
    JSON.parse(JSON.stringify(report));
    const text = renderReport(report);
    assert.match(text, /Similarity probe — brain brain-1/);
    assert.match(text, /PROVISIONAL/);
    assert.match(text, /measurement buckets/);
  });
});

describe("runProbe (injected query)", () => {
  it("issues a scoped sample then k neighbor lookups and assembles pairs", async () => {
    const calls = [];
    const runQuery = async (text, values) => {
      calls.push({ text, values });
      if (text.includes("order by created_at desc")) {
        return { rows: [{ id: "s1", embedding: "[1,0]", preview: "p1" }] };
      }
      return { rows: [{ id: "n1", preview: "p2", similarity: 0.97 }] };
    };
    const report = await runProbe({ runQuery, brainId: "B", sampleSize: 10, k: 3 });
    assert.equal(report.brainId, "B");
    assert.equal(report.pairCount, 1);
    assert.equal(report.distribution.max, 0.97);
    // sample query is brain-scoped with the exact match_thoughts predicate
    assert.match(calls[0].text, /deleted_at is null/);
    assert.match(calls[0].text, /embedding_dimension = 1536/);
    assert.equal(calls[0].values[0], "B");
  });

  it("requires runQuery and brainId", async () => {
    await assert.rejects(() => runProbe({ brainId: "B" }), /runQuery is required/);
    await assert.rejects(() => runProbe({ runQuery: async () => ({ rows: [] }) }), /brainId is required/);
  });
});

// --- DB-backed smoke test --------------------------------------------------

const EST = "zzp-probe-est";
const BRAIN_SLUG = "zzp-probe-brain";
const OTHER_BRAIN_SLUG = "zzp-probe-other";

// Two distinct valid 1536-d unit vectors (a zero vector makes cosine NaN).
const EMB_A = Array(1536).fill(0);
EMB_A[0] = 1;
const EMB_B = Array(1536).fill(0);
EMB_B[1] = 1;

let pool;
let query;
let closePool;
let store;
let brainId;
let otherBrainId;
let skipReason = false;

try {
  const { config } = await import("../src/config.mjs");
  if (config.postgres?.database === "ob1") {
    skipReason = "refusing to run the similarity-probe DB smoke test against prod database 'ob1'";
  } else {
    const db = await import("../src/db.mjs");
    pool = db.pool;
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

describe("similarity probe (DB-backed smoke)", { skip: skipReason }, () => {
  before(async () => {
    await query(
      `delete from thoughts where brain_id in
         (select b.id from brains b join households h on h.id = b.household_id where h.slug = $1)`,
      [EST],
    );
    await query("delete from households where slug = $1", [EST]);
    await query("insert into households(slug, display_name) values ($1, 'probe test')", [EST]);
    const b = await query(
      `insert into brains(household_id, slug, display_name, kind)
         select id, $2, 'pb', 'personal' from households where slug = $1 returning id`,
      [EST, BRAIN_SLUG],
    );
    brainId = b.rows[0].id;
    const o = await query(
      `insert into brains(household_id, slug, display_name, kind)
         select id, $2, 'po', 'personal' from households where slug = $1 returning id`,
      [EST, OTHER_BRAIN_SLUG],
    );
    otherBrainId = o.rows[0].id;

    const cap = (bid, content, embedding, dedupeKey) =>
      store.captureThought({
        brainId: bid,
        content,
        embedding,
        embeddingModel: "zzp-test-model",
        metadata: {},
        dedupeKey,
      });
    await cap(brainId, "probe thought one", EMB_A, "zzp-a");
    await cap(brainId, "probe thought two", EMB_B, "zzp-b");
    // a row in a different brain that scoping MUST exclude
    await cap(otherBrainId, "other brain thought", EMB_A, "zzp-other");
  });

  after(async () => {
    if (!query) return;
    await query(
      `delete from thoughts where brain_id in
         (select b.id from brains b join households h on h.id = b.household_id where h.slug = $1)`,
      [EST],
    );
    await query("delete from households where slug = $1", [EST]);
    if (closePool) await closePool();
  });

  it("runs read-only by enforcement and never samples another brain", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin transaction read only");
      const runQuery = (text, values) => client.query(text, values);

      // A stray write ERRORS inside the read-only block (enforcement, not faith).
      await assert.rejects(
        () => runQuery("insert into households(slug, display_name) values ($1, $2)", ["zzp-evil", "x"]),
        /read-only transaction/i,
      );

      // begin/insert above aborted the txn; restart it clean for the read path.
      await client.query("rollback");
      await client.query("begin transaction read only");

      const report = await runProbe({ runQuery, brainId, sampleSize: 100, k: 5 });
      await client.query("commit");

      // Only this brain's two rows were sampled; the other brain never appears.
      assert.equal(report.sampleSize, 2);
      assert.ok(report.pairCount >= 1);
      const otherRow = await query(
        "select id from thoughts where brain_id = $1::uuid",
        [otherBrainId],
      );
      const otherId = otherRow.rows[0].id;
      for (const b of report.buckets) {
        for (const s of b.samples) {
          assert.notEqual(s.sourceId, otherId);
          assert.notEqual(s.neighborId, otherId);
        }
      }
    } finally {
      client.release();
    }
  });
});
