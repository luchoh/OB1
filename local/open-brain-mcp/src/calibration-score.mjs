// calibration-score.mjs — PRD docs/39 Package 3, eval-harness steps 4-5.
//
// Scores the pure decision core against LLM-judge labels, and grid-searches
// thresholds + richness heuristics to find a tuned config. The safety-critical
// metric is the WRONG-MERGE rate: a pair the judge called `distinct` that the
// core would skip / append_evidence / create_revision — that is information
// loss (a distinct note dropped or merged). We minimize that FIRST, then
// maximize overall agreement. A "missed dedup" (judge says dup, core says add)
// is mere clutter — far less costly, consistent with the PRD's fail-open ethos.

import { decideReconciliation, DECISION, LABEL_TO_DECISION } from "./reconciliation-decision.mjs";

const MERGE_DECISIONS = new Set([DECISION.SKIP, DECISION.APPEND_EVIDENCE, DECISION.CREATE_REVISION]);

// --- richness heuristic variants (the tunable the smoke flagged) ----------
export const RICHNESS = {
  rawLength: (t) => (typeof t === "string" ? t.length : 0),
  wordCount: (t) => (t ? t.trim().split(/\s+/).filter(Boolean).length : 0),
  // The corpus stores raw conversation exports AND distilled notes; the raw
  // export is LONGER but the distilled note is the richer/keep-worthy one.
  // Demote raw-export markers so the distilled side wins.
  distilledPreferred: (t) => {
    const len = typeof t === "string" ? t.length : 0;
    return /Canonical raw export record|Export Record\]/.test(t || "") ? len * 0.1 : len;
  },
};

// Score one config over a labeled set. Pairs are oriented existing=source,
// incoming=neighbor (matching the sampler + labeler).
export function score(pairs, { skip, reconcile, tie = DECISION.APPEND_EVIDENCE, richness }) {
  const richnessFn = typeof richness === "function" ? richness : RICHNESS[richness] ?? RICHNESS.rawLength;
  const thresholds = { skip, reconcile, tie };
  let n = 0, exact = 0, wrongMerge = 0, missedDedup = 0;
  let distinct = 0, dup = 0;
  for (const p of pairs) {
    const expected = LABEL_TO_DECISION[p.label];
    if (!expected) continue; // skip error/unparsed/unknown labels
    n += 1;
    if (expected === DECISION.ADD) distinct += 1; else dup += 1;
    const { decision } = decideReconciliation({
      match: { similarity: p.similarity, existingContent: p.source_content },
      incomingContent: p.neighbor_content,
      thresholds,
      richness: richnessFn,
    });
    if (decision === expected) exact += 1;
    if (expected === DECISION.ADD && MERGE_DECISIONS.has(decision)) wrongMerge += 1;
    if (MERGE_DECISIONS.has(expected) && decision === DECISION.ADD) missedDedup += 1;
  }
  return {
    n,
    accuracy: n ? exact / n : 0,
    wrongMergeRate: distinct ? wrongMerge / distinct : 0, // of judge-distinct pairs, fraction the core would merge
    missedDedupRate: dup ? missedDedup / dup : 0,
    wrongMerge, missedDedup, distinct, dup,
  };
}

// Deterministic stratified train/test split (no RNG): within each band, every
// index where i%10 < 7 -> train, else test.
export function split(pairs) {
  const byBand = new Map();
  for (const p of pairs) { const a = byBand.get(p.band) || []; a.push(p); byBand.set(p.band, a); }
  const train = [], test = [];
  for (const arr of byBand.values()) {
    arr.forEach((p, i) => ((i % 10 < 7 ? train : test).push(p)));
  }
  return { train, test };
}

export function tune(trainPairs, {
  skips = [0.93, 0.95, 0.97, 0.99],
  reconciles = [0.85, 0.88, 0.9, 0.92, 0.95],
  richnesses = ["rawLength", "wordCount", "distilledPreferred"],
} = {}) {
  const configs = [];
  for (const skip of skips) {
    for (const reconcile of reconciles) {
      if (reconcile > skip) continue;
      for (const richness of richnesses) {
        const m = score(trainPairs, { skip, reconcile, richness });
        configs.push({ skip, reconcile, richness, ...m });
      }
    }
  }
  // Lexicographic: lowest wrong-merge rate first, then highest accuracy.
  configs.sort((a, b) => a.wrongMergeRate - b.wrongMergeRate || b.accuracy - a.accuracy);
  return configs;
}

async function main() {
  const args = process.argv.slice(2);
  const get = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
  const inPath = get("--in", "/Users/luchoh/ob1-backups/prd39-eval-pairs-labeled.jsonl");
  const { readFile } = await import("node:fs/promises");
  const pairs = (await readFile(inPath, "utf8")).trim().split("\n").map(JSON.parse);

  const labeled = pairs.filter((p) => LABEL_TO_DECISION[p.label]);
  const distLabels = {};
  for (const p of pairs) distLabels[p.label] = (distLabels[p.label] || 0) + 1;
  process.stdout.write(`pairs=${pairs.length} scorable=${labeled.length} labels=${JSON.stringify(distLabels)}\n\n`);

  const { train, test } = split(labeled);
  const ranked = tune(train);

  process.stdout.write(`=== top 6 configs (train n=${train.length}; sorted by lowest wrong-merge, then accuracy) ===\n`);
  for (const c of ranked.slice(0, 6)) {
    process.stdout.write(
      `skip>=${c.skip} reconcile>=${c.reconcile} richness=${c.richness.padEnd(18)} ` +
      `acc=${(c.accuracy * 100).toFixed(0)}% wrongMerge=${(c.wrongMergeRate * 100).toFixed(0)}% missedDedup=${(c.missedDedupRate * 100).toFixed(0)}%\n`,
    );
  }
  // Baseline = the current measured band, for comparison.
  const base = score(test, { skip: 0.95, reconcile: 0.9, richness: "rawLength" });
  const best = ranked[0];
  const bestTest = score(test, { skip: best.skip, reconcile: best.reconcile, richness: best.richness });
  process.stdout.write(`\n=== held-out test (n=${test.length}) ===\n`);
  process.stdout.write(`baseline  skip>=0.95 reconcile>=0.90 rawLength: acc=${(base.accuracy*100).toFixed(0)}% wrongMerge=${(base.wrongMergeRate*100).toFixed(0)}% missedDedup=${(base.missedDedupRate*100).toFixed(0)}%\n`);
  process.stdout.write(`tuned     skip>=${best.skip} reconcile>=${best.reconcile} ${best.richness}: acc=${(bestTest.accuracy*100).toFixed(0)}% wrongMerge=${(bestTest.wrongMergeRate*100).toFixed(0)}% missedDedup=${(bestTest.missedDedupRate*100).toFixed(0)}%\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { process.stderr.write(`calibration-score failed: ${e.message}\n`); process.exit(1); });
}
