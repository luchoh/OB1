// calibration-sampler.mjs — PRD docs/39 Package 3, eval-harness step 1.
//
// Produces a BALANCED, unlabeled eval set of thought pairs for LLM-judge
// labeling. Random pair sampling is useless for boundary calibration (it's
// dominated by low-similarity pairs); we stratify each source row's top-1
// nearest neighbor into similarity bands and cap per band, so the
// decision-relevant region (~0.85-0.97) is well represented.
//
// Strictly read-only against the corpus. Emits JSONL with full pair content
// (the judge needs it) — write to a LOCAL path, never into the repo: the
// pairs are the owner's personal thoughts.

// Band edges for stratification (decision-relevant bands first). A pair lands
// in the band [lo, hi) by its cosine similarity.
export const BANDS = [
  { key: "skip>=0.95", lo: 0.95, hi: 1.0001 },
  { key: "reconcile.90-.95", lo: 0.9, hi: 0.95 },
  { key: "edge.85-.90", lo: 0.85, hi: 0.9 },
  { key: "near.80-.85", lo: 0.8, hi: 0.85 },
  { key: "low<.80", lo: 0.0, hi: 0.8 },
];

export function bandOf(similarity) {
  for (const b of BANDS) if (similarity >= b.lo && similarity < b.hi) return b.key;
  return "low<.80";
}

// Stratify raw (deduped) pairs into bands and cap per band. Within a band,
// keep the highest-similarity pairs first (deterministic). Returns a flat list.
export function stratify(pairs, { perBand = 50 } = {}) {
  const byBand = new Map(BANDS.map((b) => [b.key, []]));
  for (const p of pairs) byBand.get(bandOf(p.similarity)).push(p);
  const out = [];
  const counts = {};
  for (const b of BANDS) {
    const sorted = byBand.get(b.key).sort((x, y) => y.similarity - x.similarity).slice(0, perBand);
    counts[b.key] = sorted.length;
    out.push(...sorted.map((p) => ({ ...p, band: b.key })));
  }
  return { pairs: out, counts };
}

// Dedupe undirected pairs (A->B and B->A are the same pair); keep the higher
// similarity record. Key on the sorted id tuple.
export function dedupePairs(rows) {
  const seen = new Map();
  for (const r of rows) {
    const key = [r.source_id, r.neighbor_id].sort().join("|");
    const prev = seen.get(key);
    if (!prev || r.similarity > prev.similarity) seen.set(key, r);
  }
  return [...seen.values()];
}

export async function sampleEvalPairs({ runQuery, brainId, poolSize = 2000, perBand = 50, maxContentChars = 2000 }) {
  const res = await runQuery(
    `with sample as (
       select id, content, embedding from thoughts
       where brain_id = $1 and deleted_at is null and embedding is not null and embedding_dimension = 1536
       order by created_at desc limit $2
     )
     select s.id as source_id, left(s.content, $3) as source_content,
            n.id as neighbor_id, left(n.content, $3) as neighbor_content,
            n.sim as similarity
     from sample s
     cross join lateral (
       select t.id, t.content, 1 - (t.embedding <=> s.embedding) as sim
       from thoughts t
       where t.brain_id = $1 and t.deleted_at is null and t.embedding is not null and t.embedding_dimension = 1536
         and t.id <> s.id
       order by t.embedding <=> s.embedding
       limit 1
     ) n`,
    [brainId, poolSize, maxContentChars],
  );
  const deduped = dedupePairs(res.rows.map((r) => ({ ...r, similarity: Number(r.similarity) })));
  return stratify(deduped, { perBand });
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag, def) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : def;
  };
  const brainSlug = get("--brain-slug", "luchoh");
  const poolSize = Number(get("--pool-size", "2000"));
  const perBand = Number(get("--per-band", "50"));
  const out = get("--out", `/Users/luchoh/ob1-backups/prd39-eval-pairs-unlabeled.jsonl`);

  const pg = (await import("pg")).default;
  const { config } = await import("./config.mjs");
  const { writeFile } = await import("node:fs/promises");
  const pool = new pg.Pool({ ...config.postgres, database: "ob1" });
  const client = await pool.connect();
  try {
    await client.query("begin transaction read only");
    const runQuery = (t, v) => client.query(t, v);
    const b = await runQuery("select id from brains where slug = $1", [brainSlug]);
    if (b.rowCount === 0) throw new Error(`no brain '${brainSlug}'`);
    const { pairs, counts } = await sampleEvalPairs({ runQuery, brainId: b.rows[0].id, poolSize, perBand });
    await client.query("commit");

    const stamped = pairs.map((p, i) => ({ pair_id: `p${String(i).padStart(4, "0")}`, ...p }));
    await writeFile(out, stamped.map((p) => JSON.stringify(p)).join("\n") + "\n");
    process.stdout.write(`brain=${brainSlug} pool=${poolSize} -> ${stamped.length} pairs\n`);
    process.stdout.write(`per-band counts: ${JSON.stringify(counts)}\n`);
    process.stdout.write(`written: ${out}\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`calibration-sampler failed: ${e.message}\n`);
    process.exit(1);
  });
}
