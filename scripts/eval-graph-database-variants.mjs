import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { projectThoughts, graphNeighbors, closeGraph } from "../local/open-brain-mcp/src/graph.mjs";
import { closePool, query } from "../local/open-brain-mcp/src/db.mjs";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..");
const defaultRetrievalCases = path.join(repoRoot, "local/open-brain-mcp/evals/graph-retrieval-eval-cases.json");
const defaultStructureCases = path.join(repoRoot, "local/open-brain-mcp/evals/graph-structure-eval-cases.json");
const retrievalScript = path.join(repoRoot, "scripts/eval-open-brain-retrieval.mjs");

function usage() {
  console.log(`Usage: node scripts/eval-graph-database-variants.mjs [options]

Options:
  --baseline-database NAME       Baseline graph database (default: ob1-graph)
  --baseline-variant NAME        Baseline projection schema variant (default: provenance-v1)
  --candidate-database NAME      Candidate graph database (default: ob1-graph-source-first)
  --candidate-variant NAME       Candidate projection schema variant (default: source-first-chat-v1)
  --retrieval-cases PATH         Retrieval eval case file
  --structure-cases PATH         Structure eval case file
  --output PATH                  Optional JSON report path
  --verbose                      Print per-case progress
  --help                         Show this message
`);
}

function parseArgs(argv) {
  const args = {
    baselineDatabase: process.env.OPEN_BRAIN_GRAPH_DATABASE ?? "ob1-graph",
    baselineVariant: "provenance-v1",
    candidateDatabase: "ob1-graph-source-first",
    candidateVariant: "source-first-chat-v1",
    retrievalCasesPath: defaultRetrievalCases,
    structureCasesPath: defaultStructureCases,
    outputPath: null,
    verbose: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--baseline-database") {
      args.baselineDatabase = argv[++index];
    } else if (arg === "--baseline-variant") {
      args.baselineVariant = argv[++index];
    } else if (arg === "--candidate-database") {
      args.candidateDatabase = argv[++index];
    } else if (arg === "--candidate-variant") {
      args.candidateVariant = argv[++index];
    } else if (arg === "--retrieval-cases") {
      args.retrievalCasesPath = path.resolve(argv[++index]);
    } else if (arg === "--structure-cases") {
      args.structureCasesPath = path.resolve(argv[++index]);
    } else if (arg === "--output") {
      args.outputPath = path.resolve(argv[++index]);
    } else if (arg === "--verbose") {
      args.verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean))];
}

function scoreStructureCase(testCase, labelCounts) {
  let score = 100;
  const notes = [];
  for (const [label, minimum] of Object.entries(testCase.required_neighbor_labels ?? {})) {
    const actual = labelCounts[label] ?? 0;
    if (actual < minimum) {
      score -= 25;
      notes.push(`${label} count ${actual}/${minimum}`);
    }
  }
  score = Math.max(0, score);
  return {
    total_score: score,
    decision: score >= 85 ? "accept" : "reject",
    notes: notes.length > 0 ? notes : ["graph neighborhood matched the fixed structure requirements"],
  };
}

async function thoughtIdForDedupeKey(dedupeKey) {
  const result = await query(
    `
      select id
      from thoughts
      where dedupe_key = $1
      limit 1
    `,
    [dedupeKey],
  );
  return result.rows[0]?.id ?? null;
}

async function evaluateStructureCases({ casesPath, database, schemaVariant, verbose = false }) {
  const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  const projectionDedupeKeys = unique(cases.flatMap((testCase) => testCase.projection_dedupe_keys ?? []));
  if (projectionDedupeKeys.length > 0) {
    await projectThoughts({
      database,
      schemaVariant,
      dedupeKeys: projectionDedupeKeys,
      forceAll: true,
      limit: projectionDedupeKeys.length,
    });
  }

  const results = [];
  for (const testCase of cases) {
    const thoughtId = await thoughtIdForDedupeKey(testCase.seed_dedupe_key);
    if (!thoughtId) {
      results.push({
        case: testCase,
        label_counts: {},
        judgment: {
          total_score: 0,
          decision: "reject",
          notes: [`missing seed row for ${testCase.seed_dedupe_key}`],
        },
      });
      continue;
    }

    const neighbors = await graphNeighbors({
      thoughtId,
      maxHops: testCase.max_hops ?? 2,
      limit: testCase.limit ?? 100,
      database,
    });

    const labelCounts = {};
    for (const neighbor of neighbors.neighbors ?? []) {
      for (const label of neighbor.labels ?? []) {
        labelCounts[label] = (labelCounts[label] ?? 0) + 1;
      }
    }

    const judgment = scoreStructureCase(testCase, labelCounts);
    results.push({
      case: testCase,
      label_counts: labelCounts,
      center: neighbors.center,
      judgment,
    });

    if (verbose) {
      console.log(
        `${database}:${testCase.id} score=${judgment.total_score} labels=${JSON.stringify(labelCounts)}`,
      );
    }
  }

  const meanScore = results.reduce((sum, item) => sum + item.judgment.total_score, 0) / results.length;
  const accepted = results.filter((item) => item.judgment.decision === "accept").length;
  return {
    case_count: results.length,
    mean_score: Number(meanScore.toFixed(2)),
    accepted,
    results,
  };
}

function runRetrievalEval({ database, schemaVariant, casesPath, verbose = false }) {
  const outputPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "ob1-graph-variant-")),
    "retrieval-report.json",
  );
  const command = [
    "node",
    retrievalScript,
    "--cases",
    casesPath,
    "--database",
    database,
    "--schema-variant",
    schemaVariant,
    "--include-chat-sources",
    "--output",
    outputPath,
  ];
  if (verbose) {
    command.push("--verbose");
  }

  const proc = spawnSync(command[0], command.slice(1), {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPEN_BRAIN_RUNTIME_ROLE: "service",
    },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (proc.status !== 0) {
    throw new Error(
      `Retrieval eval failed for ${database}\nSTDOUT:\n${proc.stdout}\n\nSTDERR:\n${proc.stderr}`,
    );
  }

  return JSON.parse(fs.readFileSync(outputPath, "utf8"));
}

async function evaluateDatabase({ database, schemaVariant, retrievalCasesPath, structureCasesPath, verbose }) {
  const retrieval = runRetrievalEval({
    database,
    schemaVariant,
    casesPath: retrievalCasesPath,
    verbose,
  });

  const structure = await evaluateStructureCases({
    casesPath: structureCasesPath,
    database,
    schemaVariant,
    verbose,
  });

  return {
    database,
    schema_variant: schemaVariant,
    retrieval: {
      mean_score: retrieval.mean_score,
      accepted: retrieval.accepted,
      case_count: retrieval.case_count,
      results: retrieval.results,
    },
    structure,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const baseline = await evaluateDatabase({
    database: args.baselineDatabase,
    schemaVariant: args.baselineVariant,
    retrievalCasesPath: args.retrievalCasesPath,
    structureCasesPath: args.structureCasesPath,
    verbose: args.verbose,
  });

  const candidate = await evaluateDatabase({
    database: args.candidateDatabase,
    schemaVariant: args.candidateVariant,
    retrievalCasesPath: args.retrievalCasesPath,
    structureCasesPath: args.structureCasesPath,
    verbose: args.verbose,
  });

  const report = {
    generated_at: new Date().toISOString(),
    baseline,
    candidate,
    delta: {
      retrieval_mean_score: Number((candidate.retrieval.mean_score - baseline.retrieval.mean_score).toFixed(2)),
      retrieval_accepted: candidate.retrieval.accepted - baseline.retrieval.accepted,
      structure_mean_score: Number((candidate.structure.mean_score - baseline.structure.mean_score).toFixed(2)),
      structure_accepted: candidate.structure.accepted - baseline.structure.accepted,
    },
  };

  const serialized = JSON.stringify(report, null, 2);
  if (args.outputPath) {
    fs.writeFileSync(args.outputPath, serialized);
  }
  console.log(serialized);
}

try {
  await main();
} finally {
  await closeGraph();
  await closePool();
}
