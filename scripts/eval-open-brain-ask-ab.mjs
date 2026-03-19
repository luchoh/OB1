import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..");

function parseDotenv(filepath) {
  try {
    const text = fs.readFileSync(filepath, "utf8");
    const entries = [];
    for (const rawLine of text.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const equals = line.indexOf("=");
      if (equals === -1) {
        continue;
      }
      const key = line.slice(0, equals).trim();
      const value = line.slice(equals + 1).trim();
      entries.push([key, value]);
    }
    return entries;
  } catch {
    return [];
  }
}

function loadRepoEnv() {
  for (const [key, value] of parseDotenv(path.join(repoRoot, ".env"))) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  for (const [key, value] of parseDotenv(path.join(repoRoot, ".env.open-brain-local"))) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function usage() {
  console.log(`Usage: node scripts/eval-open-brain-ask-ab.mjs [options]

Options:
  --base-url URL          Running open-brain-local base URL (default: OPEN_BRAIN_BASE_URL or http://localhost:8787)
  --cases PATH            JSON case file (default: local/open-brain-mcp/evals/ask-brain-graph-ab-cases.json)
  --output PATH           Optional path to write the full JSON report
  --match-count N         Default match_count for cases that do not set one (default: 6)
  --match-threshold N     Default similarity threshold (default: 0.4)
  --graph-max-hops N      Graph max hops for graph-assisted requests (default: 2)
  --graph-neighbor-limit N
                          Max additional thought rows to add in graph-assisted mode (default: match_count)
  --help                  Show this message
`);
}

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.OPEN_BRAIN_BASE_URL ?? "http://localhost:8787",
    casesPath: path.join(repoRoot, "local/open-brain-mcp/evals/ask-brain-graph-ab-cases.json"),
    outputPath: null,
    matchCount: 6,
    matchThreshold: 0.4,
    graphMaxHops: 2,
    graphNeighborLimit: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-url") {
      args.baseUrl = argv[++index];
    } else if (arg === "--cases") {
      args.casesPath = path.resolve(argv[++index]);
    } else if (arg === "--output") {
      args.outputPath = path.resolve(argv[++index]);
    } else if (arg === "--match-count") {
      args.matchCount = Number(argv[++index]);
    } else if (arg === "--match-threshold") {
      args.matchThreshold = Number(argv[++index]);
    } else if (arg === "--graph-max-hops") {
      args.graphMaxHops = Number(argv[++index]);
    } else if (arg === "--graph-neighbor-limit") {
      args.graphNeighborLimit = Number(argv[++index]);
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.matchCount) || args.matchCount < 1) {
    throw new Error("--match-count must be a positive number");
  }
  if (!Number.isFinite(args.matchThreshold) || args.matchThreshold < 0 || args.matchThreshold > 1) {
    throw new Error("--match-threshold must be between 0 and 1");
  }
  if (!Number.isFinite(args.graphMaxHops) || args.graphMaxHops < 1 || args.graphMaxHops > 3) {
    throw new Error("--graph-max-hops must be between 1 and 3");
  }
  if (args.graphNeighborLimit !== null && (!Number.isFinite(args.graphNeighborLimit) || args.graphNeighborLimit < 1)) {
    throw new Error("--graph-neighbor-limit must be a positive number");
  }

  return args;
}

async function postJson(url, accessKey, payload) {
  const startedAt = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-access-key": accessKey,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}: ${JSON.stringify(parsed)}`);
  }

  return {
    latency_ms: Date.now() - startedAt,
    payload: parsed,
  };
}

function summarizeRun(result) {
  const payload = result.payload;
  return {
    answer: payload.answer,
    grounded: payload.grounded,
    insufficient_evidence: payload.insufficient_evidence,
    citations: Array.isArray(payload.citations) ? payload.citations.map((item) => item.id) : [],
    citation_count: Array.isArray(payload.citations) ? payload.citations.length : 0,
    evidence_count: payload.evidence_count ?? null,
    retrieval_strategy: payload.retrieval_strategy ?? null,
    fallback_used: payload.fallback_used ?? null,
    graph_assisted: payload.graph_assisted ?? false,
    graph_expansion: payload.graph_expansion ?? null,
    latency_ms: result.latency_ms,
  };
}

function countChangedCases(results) {
  return results.filter((entry) => {
    const vector = entry.vector_only;
    const graph = entry.graph_assisted;
    return vector.answer !== graph.answer
      || vector.citation_count !== graph.citation_count
      || vector.evidence_count !== graph.evidence_count
      || JSON.stringify(vector.citations) !== JSON.stringify(graph.citations);
  }).length;
}

loadRepoEnv();
const args = parseArgs(process.argv.slice(2));
const accessKey = process.env.MCP_ACCESS_KEY;
if (!accessKey) {
  throw new Error("MCP_ACCESS_KEY is required");
}

const cases = JSON.parse(fs.readFileSync(args.casesPath, "utf8"));
if (!Array.isArray(cases) || cases.length === 0) {
  throw new Error(`No cases found in ${args.casesPath}`);
}

const report = {
  generated_at: new Date().toISOString(),
  base_url: args.baseUrl.replace(/\/$/, ""),
  cases_path: args.casesPath,
  defaults: {
    match_count: args.matchCount,
    match_threshold: args.matchThreshold,
    graph_max_hops: args.graphMaxHops,
    graph_neighbor_limit: args.graphNeighborLimit ?? args.matchCount,
  },
  results: [],
};

for (const testCase of cases) {
  const payloadBase = {
    question: testCase.question,
    match_count: testCase.match_count ?? args.matchCount,
    match_threshold: testCase.match_threshold ?? args.matchThreshold,
    filter: testCase.filter ?? {},
  };

  const vectorResult = await postJson(
    `${report.base_url}/ask`,
    accessKey,
    {
      ...payloadBase,
      graph_assisted: false,
    },
  );

  const graphResult = await postJson(
    `${report.base_url}/ask`,
    accessKey,
    {
      ...payloadBase,
      graph_assisted: true,
      graph_max_hops: testCase.graph_max_hops ?? args.graphMaxHops,
      graph_neighbor_limit: testCase.graph_neighbor_limit ?? args.graphNeighborLimit ?? payloadBase.match_count,
    },
  );

  const entry = {
    id: testCase.id ?? `case-${report.results.length + 1}`,
    question: testCase.question,
    expect_graph_helpful: Boolean(testCase.expect_graph_helpful),
    note: testCase.note ?? null,
    vector_only: summarizeRun(vectorResult),
    graph_assisted: summarizeRun(graphResult),
  };

  report.results.push(entry);

  const graphAdded = entry.graph_assisted.graph_expansion?.added_count ?? 0;
  console.log(
    [
      `${entry.id}:`,
      `vector grounded=${entry.vector_only.grounded}`,
      `graph grounded=${entry.graph_assisted.grounded}`,
      `vector citations=${entry.vector_only.citation_count}`,
      `graph citations=${entry.graph_assisted.citation_count}`,
      `graph_added=${graphAdded}`,
      `answer_changed=${entry.vector_only.answer !== entry.graph_assisted.answer}`,
    ].join(" | "),
  );
}

report.summary = {
  case_count: report.results.length,
  graph_helpful_cases: report.results.filter((entry) => entry.expect_graph_helpful).length,
  changed_cases: countChangedCases(report.results),
  graph_added_cases: report.results.filter((entry) => (entry.graph_assisted.graph_expansion?.added_count ?? 0) > 0).length,
};

const serialized = JSON.stringify(report, null, 2);
if (args.outputPath) {
  fs.writeFileSync(args.outputPath, serialized);
}

console.log();
console.log(serialized);
