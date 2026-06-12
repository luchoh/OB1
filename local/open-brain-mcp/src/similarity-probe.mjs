// similarity-probe.mjs — PRD docs/39, Package 2.
//
// A strictly read-only measurement tool: per brain, sample thoughts and
// measure their nearest-neighbor cosine similarity under OUR embedding model,
// so the owner can decide whether semantic reconciliation (Package 3) is worth
// its risk, and at which thresholds — on evidence, not on thresholds tuned for
// a different model.
//
// Design split for testability:
//   * The bucketing / distribution / band-recommendation logic is PURE
//     (functions over injected arrays — no DB, no I/O). Unit-tested exhaustively.
//   * runProbe() takes an injected `runQuery` so it can be driven by a real
//     read-only client (CLI / smoke test) or a fake (unit test).
//   * The CLI opens a `begin transaction read only` block, so ANY stray write
//     ERRORS rather than passing unnoticed — read-only by enforcement, not
//     discipline (PRD Testing).
//
// Scope predicate mirrors match_thoughts exactly: one brain at a time, no
// tombstones, non-null 1536-d embeddings only (ADR-0003: never cross-brain).

// Fixed MEASUREMENT buckets — NOT decision thresholds. Histogram edges every
// 0.05 across [0.70, 1.00]; everything below 0.70 lands in the catch-all.
export const MEASUREMENT_BUCKET_EDGES = [0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0];

export const BELOW_RANGE_LABEL = "<0.70";

// The brain-scope WHERE predicate, mirroring match_thoughts (011). Kept as a
// single source of truth so the sample and the neighbor query cannot drift.
const SCOPE_PREDICATE =
  "brain_id = $1 and deleted_at is null and embedding is not null and embedding_dimension = 1536";

// --- Pure core -------------------------------------------------------------

// Label a similarity into its measurement bucket, e.g. "0.85-0.90" or "<0.70".
export function bucketLabel(similarity) {
  if (typeof similarity !== "number" || !Number.isFinite(similarity)) {
    throw new Error(`bucketLabel: non-finite similarity ${similarity}`);
  }
  if (similarity < MEASUREMENT_BUCKET_EDGES[0]) return BELOW_RANGE_LABEL;
  for (let i = MEASUREMENT_BUCKET_EDGES.length - 1; i >= 1; i -= 1) {
    if (similarity >= MEASUREMENT_BUCKET_EDGES[i - 1]) {
      const lo = MEASUREMENT_BUCKET_EDGES[i - 1];
      const hi = MEASUREMENT_BUCKET_EDGES[i];
      return `${lo.toFixed(2)}-${hi.toFixed(2)}`;
    }
  }
  return BELOW_RANGE_LABEL;
}

// Group (sourceId, neighborId, similarity, previews) pairs into buckets with
// counts and a capped reviewable sample per bucket. Order of buckets is
// highest-similarity first (the bands the owner cares about most).
export function bucketize(pairs, { samplesPerBucket = 5 } = {}) {
  const labels = [
    ...MEASUREMENT_BUCKET_EDGES.slice(0, -1)
      .map((lo, i) => `${lo.toFixed(2)}-${MEASUREMENT_BUCKET_EDGES[i + 1].toFixed(2)}`)
      .reverse(),
    BELOW_RANGE_LABEL,
  ];
  const buckets = new Map(labels.map((label) => [label, { label, count: 0, samples: [] }]));
  for (const pair of pairs) {
    const bucket = buckets.get(bucketLabel(pair.similarity));
    bucket.count += 1;
    if (bucket.samples.length < samplesPerBucket) bucket.samples.push(pair);
  }
  return [...buckets.values()];
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (rank - lo);
}

// Summary statistics over the nearest-neighbor similarities.
export function summarizeDistribution(similarities) {
  const finite = similarities.filter((s) => typeof s === "number" && Number.isFinite(s));
  const sorted = [...finite].sort((a, b) => a - b);
  const count = sorted.length;
  if (count === 0) {
    return { count: 0, min: null, max: null, mean: null, p50: null, p90: null, p95: null, p99: null };
  }
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count,
    min: sorted[0],
    max: sorted[count - 1],
    mean: sum / count,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

// Propose a skip/reconcile band from the distribution SHAPE. This is a
// PROVISIONAL proposal the owner confirms or overrides from the sample pairs —
// never auto-adopted (PRD story 7). Deterministic and explainable: skip is the
// smallest measurement edge above which at most `skipFraction` of NN pairs sit
// (the near-identical top tail); reconcile is the same for `reconcileFraction`.
export function recommendBand(similarities, { skipFraction = 0.01, reconcileFraction = 0.05 } = {}) {
  const finite = similarities.filter((s) => typeof s === "number" && Number.isFinite(s));
  const total = finite.length;
  const edges = MEASUREMENT_BUCKET_EDGES.filter((e) => e < 1.0); // 0.70..0.95
  const fractionAtOrAbove = (edge) =>
    total === 0 ? 0 : finite.filter((s) => s >= edge).length / total;

  // Smallest edge whose tail fraction is <= target; fall back to the top edge.
  const edgeForFraction = (target) => {
    for (const edge of edges) {
      if (fractionAtOrAbove(edge) <= target) return edge;
    }
    return edges[edges.length - 1];
  };

  let skip = edgeForFraction(skipFraction);
  let reconcile = edgeForFraction(reconcileFraction);
  if (reconcile > skip) reconcile = skip; // reconcile band sits below skip
  return {
    skip,
    reconcile,
    provisional: true,
    basis: {
      skipFraction,
      reconcileFraction,
      pairsAtOrAboveSkip: total === 0 ? 0 : Math.round(fractionAtOrAbove(skip) * total),
      pairsAtOrAboveReconcile: total === 0 ? 0 : Math.round(fractionAtOrAbove(reconcile) * total),
      total,
    },
    note:
      "PROVISIONAL — confirm or override from the sample pairs below. No threshold is auto-adopted.",
  };
}

// Assemble the full report object (JSON-serializable). Pure: no I/O.
export function buildReport({ brainId, sampleSize, k, pairs, samplesPerBucket = 5, band }) {
  const similarities = pairs.map((p) => p.similarity);
  return {
    brainId,
    sampleSize,
    k,
    pairCount: pairs.length,
    distribution: summarizeDistribution(similarities),
    buckets: bucketize(pairs, { samplesPerBucket }),
    recommendedBand: band ?? recommendBand(similarities),
  };
}

function fmt(n) {
  return n === null || n === undefined ? "n/a" : Number(n).toFixed(4);
}

// Render a report object as human-readable text for the terminal.
export function renderReport(report) {
  const lines = [];
  lines.push(`Similarity probe — brain ${report.brainId}`);
  lines.push(
    `  sampled ${report.sampleSize} rows, top-${report.k} nearest neighbors each → ${report.pairCount} pairs`,
  );
  const d = report.distribution;
  lines.push(
    `  distribution: n=${d.count} min=${fmt(d.min)} p50=${fmt(d.p50)} p90=${fmt(d.p90)} p95=${fmt(d.p95)} p99=${fmt(d.p99)} max=${fmt(d.max)} mean=${fmt(d.mean)}`,
  );
  lines.push("  measurement buckets (NOT decision thresholds):");
  for (const b of report.buckets) {
    lines.push(`    ${b.label.padEnd(11)} ${String(b.count).padStart(7)}`);
  }
  const band = report.recommendedBand;
  lines.push("  recommended band (PROVISIONAL — confirm from samples):");
  lines.push(`    skip      >= ${fmt(band.skip)}`);
  lines.push(`    reconcile >= ${fmt(band.reconcile)}`);
  lines.push(`    ${band.note}`);
  lines.push("  sample pairs per bucket:");
  for (const b of report.buckets) {
    if (b.samples.length === 0) continue;
    lines.push(`    [${b.label}]`);
    for (const s of b.samples) {
      lines.push(`      ${fmt(s.similarity)}  ${s.sourcePreview ?? s.sourceId} :: ${s.neighborPreview ?? s.neighborId}`);
    }
  }
  return lines.join("\n");
}

// --- DB-driven probe (injected query) --------------------------------------

// runQuery(text, values) -> { rows }. For each sampled row, ask the existing
// HNSW index for its top-k nearest neighbors (k·N indexed lookups, NOT O(n^2)).
export async function runProbe({
  runQuery,
  brainId,
  sampleSize = 1000,
  k = 5,
  samplesPerBucket = 5,
  band,
} = {}) {
  if (typeof runQuery !== "function") throw new Error("runProbe: runQuery is required");
  if (!brainId) throw new Error("runProbe: brainId is required");

  const sample = await runQuery(
    `select id, embedding::text as embedding, left(content, 120) as preview
       from thoughts
      where ${SCOPE_PREDICATE}
      order by created_at desc
      limit $2`,
    [brainId, sampleSize],
  );

  const pairs = [];
  for (const row of sample.rows) {
    const neighbors = await runQuery(
      `select id, left(content, 120) as preview, 1 - (embedding <=> $2::vector) as similarity
         from thoughts
        where ${SCOPE_PREDICATE}
          and id <> $3::uuid
        order by embedding <=> $2::vector
        limit $4`,
      [brainId, row.embedding, row.id, k],
    );
    for (const n of neighbors.rows) {
      pairs.push({
        sourceId: row.id,
        sourcePreview: row.preview,
        neighborId: n.id,
        neighborPreview: n.preview,
        similarity: Number(n.similarity),
      });
    }
  }

  return buildReport({ brainId, sampleSize: sample.rows.length, k, pairs, samplesPerBucket, band });
}

// --- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const args = { brainId: null, brainSlug: null, sampleSize: 1000, k: 5, samplesPerBucket: 5, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--brain-id") args.brainId = argv[++i];
    else if (a === "--brain-slug") args.brainSlug = argv[++i];
    else if (a === "--sample-size") args.sampleSize = Number(argv[++i]);
    else if (a === "--k") args.k = Number(argv[++i]);
    else if (a === "--samples-per-bucket") args.samplesPerBucket = Number(argv[++i]);
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.brainId && !args.brainSlug)) {
    process.stderr.write(
      "Usage: node src/similarity-probe.mjs (--brain-id <uuid> | --brain-slug <slug>)\n" +
        "       [--sample-size N] [--k K] [--samples-per-bucket M] [--json]\n",
    );
    process.exit(args.help ? 0 : 2);
  }

  const { pool } = await import("./db.mjs");
  const client = await pool.connect();
  try {
    // Read-only by ENFORCEMENT: any write inside this block errors.
    await client.query("begin transaction read only");
    const runQuery = (text, values) => client.query(text, values);

    let brainId = args.brainId;
    if (!brainId) {
      const r = await runQuery("select id from brains where slug = $1", [args.brainSlug]);
      if (r.rowCount === 0) throw new Error(`no brain with slug '${args.brainSlug}'`);
      brainId = r.rows[0].id;
    }

    const report = await runProbe({
      runQuery,
      brainId,
      sampleSize: args.sampleSize,
      k: args.k,
      samplesPerBucket: args.samplesPerBucket,
    });
    await client.query("commit");

    process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderReport(report)}\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`similarity-probe failed: ${error.message}\n`);
    process.exit(1);
  });
}
