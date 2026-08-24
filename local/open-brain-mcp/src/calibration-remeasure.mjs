// calibration-remeasure.mjs — PRD docs/39 Package 3, eval-harness re-measure.
//
// Tests the "fix the embedding content" hypothesis WITHOUT touching ingest or
// re-embedding prod: take the already-judge-labeled pairs, STRIP the chat-export
// wrapper boilerplate, re-embed the stripped text on the live embedding service
// (compute-only, no writes), recompute cosine, and re-score the decision core
// against the SAME judge labels. If stripping makes cosine discriminative,
// wrong-merge drops and accuracy rises vs the boilerplate-polluted baseline.

import { score, tune, split } from "./calibration-score.mjs";
import { LABEL_TO_DECISION } from "./reconciliation-decision.mjs";

// Strip the leading bracket tag ("[ChatGPT Export Record: title | date]",
// "[Claude: title | date]", etc.) and the content-free pointer boilerplate
// ("Canonical raw export record for conversation <uuid>."). Leaves real content.
export function stripWrapper(text) {
  if (typeof text !== "string") return "";
  let t = text.replace(/^\s*\[[^\]]*\]\s*/, "");
  t = t.replace(/^Canonical raw export record for conversation [0-9a-f-]+\.?\s*/i, "");
  return t.trim();
}

// A stripped text shorter than this is treated as a content-free pointer record
// (no real conversation content) and excluded from reconciliation scoring.
const MIN_CONTENT_CHARS = 20;

function cosine(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d; // service returns unit-norm vectors -> dot product == cosine
}

async function embedBatch(texts, { embeddingBaseUrl, model }) {
  const out = [];
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    const resp = await fetch(`${embeddingBaseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: batch, dimensions: 1536 }),
    });
    if (!resp.ok) throw new Error(`embed HTTP ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
    const data = (await resp.json()).data;
    for (const d of data) out.push(d.embedding);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const get = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
  const inPath = get("--in", "/Users/luchoh/ob1-backups/prd39-eval-pairs-labeled.jsonl");

  const { config } = await import("./config.mjs");
  const { readFile } = await import("node:fs/promises");
  const embeddingBaseUrl = config.embeddingBaseUrl;
  const model = config.embeddingModel;

  const pairs = (await readFile(inPath, "utf8")).trim().split("\n").map(JSON.parse)
    .filter((p) => LABEL_TO_DECISION[p.label]);

  // Strip + partition.
  for (const p of pairs) {
    p.src_stripped = stripWrapper(p.source_content);
    p.nbr_stripped = stripWrapper(p.neighbor_content);
    p.contentFree = p.src_stripped.length < MIN_CONTENT_CHARS || p.nbr_stripped.length < MIN_CONTENT_CHARS;
  }
  const bearing = pairs.filter((p) => !p.contentFree);
  const free = pairs.filter((p) => p.contentFree);

  // Re-embed the stripped texts of content-bearing pairs (dedup identical texts).
  const uniq = [...new Set(bearing.flatMap((p) => [p.src_stripped, p.nbr_stripped]))];
  process.stderr.write(`embedding ${uniq.length} unique stripped texts...\n`);
  const vecs = await embedBatch(uniq, { embeddingBaseUrl, model });
  const vmap = new Map(uniq.map((t, i) => [t, vecs[i]]));

  // Recompute cosine on stripped embeddings; keep the old (polluted) similarity too.
  for (const p of bearing) {
    p.similarity_polluted = p.similarity;
    p.similarity = cosine(vmap.get(p.src_stripped), vmap.get(p.nbr_stripped));
  }

  // Report content-free pollution.
  process.stdout.write(`scorable pairs: ${pairs.length}\n`);
  process.stdout.write(`content-free pointer-record pairs (excluded; should not be embedded at all): ${free.length} (${(free.length/pairs.length*100).toFixed(0)}%)\n`);
  process.stdout.write(`content-bearing pairs re-embedded: ${bearing.length}\n\n`);

  // Distribution shift on content-bearing distinct pairs (the wrong-merge source).
  const distinct = bearing.filter((p) => LABEL_TO_DECISION[p.label] === "add");
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  process.stdout.write(`distinct content-bearing pairs (n=${distinct.length}): mean cosine polluted=${avg(distinct.map(p=>p.similarity_polluted)).toFixed(3)} -> stripped=${avg(distinct.map(p=>p.similarity)).toFixed(3)}\n`);
  const dupish = bearing.filter((p) => LABEL_TO_DECISION[p.label] !== "add");
  process.stdout.write(`true dup/same-fact content-bearing pairs (n=${dupish.length}): mean cosine polluted=${avg(dupish.map(p=>p.similarity_polluted)).toFixed(3)} -> stripped=${avg(dupish.map(p=>p.similarity)).toFixed(3)}\n\n`);

  // Re-tune on stripped embeddings (content-bearing only).
  const { train, test } = split(bearing);
  const ranked = tune(train);
  const best = ranked[0];
  const bestTest = score(test, best);
  // Polluted-embedding scoring on the SAME content-bearing test set, for contrast.
  const pollutedTest = score(test.map((p) => ({ ...p, similarity: p.similarity_polluted })), { skip: 0.95, reconcile: 0.9, richness: "rawLength" });
  process.stdout.write(`=== content-bearing held-out test (n=${test.length}) ===\n`);
  process.stdout.write(`polluted embeddings, baseline band: acc=${(pollutedTest.accuracy*100).toFixed(0)}% wrongMerge=${(pollutedTest.wrongMergeRate*100).toFixed(0)}% missedDedup=${(pollutedTest.missedDedupRate*100).toFixed(0)}%\n`);
  process.stdout.write(`STRIPPED embeddings, tuned skip>=${best.skip} reconcile>=${best.reconcile} ${best.richness}: acc=${(bestTest.accuracy*100).toFixed(0)}% wrongMerge=${(bestTest.wrongMergeRate*100).toFixed(0)}% missedDedup=${(bestTest.missedDedupRate*100).toFixed(0)}%\n`);
  process.stdout.write(`\ntop 4 stripped configs (train n=${train.length}):\n`);
  for (const c of ranked.slice(0,4)) process.stdout.write(`  skip>=${c.skip} reconcile>=${c.reconcile} ${c.richness.padEnd(18)} acc=${(c.accuracy*100).toFixed(0)}% wrongMerge=${(c.wrongMergeRate*100).toFixed(0)}% missedDedup=${(c.missedDedupRate*100).toFixed(0)}%\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { process.stderr.write(`calibration-remeasure failed: ${e.message}\n`); process.exit(1); });
}
