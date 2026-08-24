// calibration-label.mjs — PRD docs/39 Package 3, eval-harness step 3.
//
// LLM-judge labeler. For each unlabeled pair, asks the LOCAL model (DeepSeek
// via LLM_BASE_URL — free, on-prem) to classify the relationship of an
// INCOMING thought (B = neighbor) to an EXISTING thought (A = source), for
// reconciliation. The four labels map 1:1 to decision-core outputs:
//   duplicate                  -> skip
//   same_fact_richer_existing  -> append_evidence   (A richer)
//   same_fact_richer_incoming  -> create_revision   (B richer)
//   distinct                   -> add
//
// Output: the input JSONL plus { label, judge_reason } per pair. Cheap/on-prem;
// the owner spot-checks the ambiguous 0.85-0.95 band afterward.

const LABELS = ["duplicate", "same_fact_richer_existing", "same_fact_richer_incoming", "distinct"];

const submitLabelTool = {
  type: "function",
  function: {
    name: "submit_label",
    description: "Return the reconciliation relationship label for the pair.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        label: { type: "string", enum: LABELS },
        reason: { type: "string", description: "One short sentence justifying the label." },
      },
      required: ["label", "reason"],
    },
  },
};

const SYSTEM = [
  "You classify pairs of notes from a personal knowledge base for de-duplication.",
  "You are given an EXISTING note (A) and an INCOMING note (B).",
  "Decide their relationship and return it with the submit_label tool. Labels:",
  "- duplicate: A and B state the same information; B adds essentially nothing new (verbatim, a re-import, or a trivial rewording).",
  "- same_fact_richer_existing: same underlying fact/topic, but A is more complete/detailed/useful than B.",
  "- same_fact_richer_incoming: same underlying fact/topic, but B is more complete/detailed/useful than A.",
  "- distinct: different facts, or merely related/same-template but NOT the same fact. When unsure between a richness label and distinct, prefer distinct — merging distinct notes destroys information.",
  "Judge by MEANING, not surface length or shared boilerplate/headers. Two notes can share a template and still be distinct facts.",
  "Never include chain-of-thought; just call the tool.",
].join("\n");

function parseLabel(response) {
  const msg = response?.choices?.[0]?.message;
  const call = msg?.tool_calls?.[0]?.function?.arguments;
  let args = null;
  if (call) {
    try { args = typeof call === "string" ? JSON.parse(call) : call; } catch { /* fall through */ }
  }
  if (!args && typeof msg?.content === "string") {
    const m = msg.content.match(/\{[\s\S]*\}/);
    if (m) { try { args = JSON.parse(m[0]); } catch { /* ignore */ } }
  }
  const label = args && LABELS.includes(args.label) ? args.label : "unparsed";
  const reason = args && typeof args.reason === "string" ? args.reason : "";
  return { label, reason };
}

export async function labelPair({ llmBaseUrl, model, pair, fetchImpl = fetch }) {
  const body = {
    model,
    temperature: 0,
    max_tokens: 200,
    chat_template_kwargs: { enable_thinking: false },
    tools: [submitLabelTool],
    tool_choice: "required",
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `EXISTING note (A):\n${pair.source_content}\n\n---\n\nINCOMING note (B):\n${pair.neighbor_content}`,
      },
    ],
  };
  const resp = await fetchImpl(`${llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`judge HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return parseLabel(await resp.json());
}

async function main() {
  const args = process.argv.slice(2);
  const get = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
  const inPath = get("--in", "/Users/luchoh/ob1-backups/prd39-eval-pairs-unlabeled.jsonl");
  const outPath = get("--out", "/Users/luchoh/ob1-backups/prd39-eval-pairs-labeled.jsonl");
  const limit = Number(get("--limit", "0")) || 0;
  const concurrency = Number(get("--concurrency", "4"));

  const { config } = await import("./config.mjs");
  const { readFile, writeFile } = await import("node:fs/promises");
  const llmBaseUrl = config.llmBaseUrl;
  const model = config.llmModel;
  if (!llmBaseUrl) throw new Error("config.llmBaseUrl is empty");

  let pairs = (await readFile(inPath, "utf8")).trim().split("\n").map(JSON.parse);
  if (limit > 0) {
    // Spread the smoke sample across bands rather than taking the first N.
    const byBand = new Map();
    for (const p of pairs) { const a = byBand.get(p.band) || []; a.push(p); byBand.set(p.band, a); }
    pairs = [...byBand.values()].flatMap((a) => a.slice(0, Math.ceil(limit / byBand.size))).slice(0, limit);
  }

  const out = [];
  let done = 0;
  for (let i = 0; i < pairs.length; i += concurrency) {
    const batch = pairs.slice(i, i + concurrency);
    const labeled = await Promise.all(
      batch.map(async (p) => {
        try {
          const { label, reason } = await labelPair({ llmBaseUrl, model, pair: p });
          return { ...p, label, judge_reason: reason };
        } catch (e) {
          return { ...p, label: "error", judge_reason: String(e.message).slice(0, 200) };
        }
      }),
    );
    out.push(...labeled);
    done += labeled.length;
    process.stderr.write(`labeled ${done}/${pairs.length}\n`);
  }

  await writeFile(outPath, out.map((p) => JSON.stringify(p)).join("\n") + "\n");
  const dist = {};
  for (const p of out) dist[p.label] = (dist[p.label] || 0) + 1;
  process.stdout.write(`judge=${model} labeled=${out.length}\n`);
  process.stdout.write(`label distribution: ${JSON.stringify(dist)}\n`);
  process.stdout.write(`written: ${outPath}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { process.stderr.write(`calibration-label failed: ${e.message}\n`); process.exit(1); });
}
