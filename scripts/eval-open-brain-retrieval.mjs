import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectThoughts, closeGraph } from "../local/open-brain-mcp/src/graph.mjs";
import { retrieveEvidenceRows } from "../local/open-brain-mcp/src/retrieval.mjs";
import { closePool, query } from "../local/open-brain-mcp/src/db.mjs";
import { graphRetrievalPolicyPath, loadGraphRetrievalPolicy } from "../local/open-brain-mcp/src/graph-retrieval-policy.mjs";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..");

function usage() {
  console.log(`Usage: node scripts/eval-open-brain-retrieval.mjs [options]

Options:
  --cases PATH        JSON case file (default: local/open-brain-mcp/evals/graph-retrieval-eval-cases.json)
  --database NAME     Graph database to evaluate against (default: OPEN_BRAIN_GRAPH_DATABASE or ob1-graph-stage)
  --schema-variant N  Projection schema variant (default: OPEN_BRAIN_GRAPH_SCHEMA_VARIANT or provenance-v1)
  --output PATH       Optional JSON report path
  --no-project        Skip projection of case-specific thought ids before evaluation
  --include-chat-sources  Also project raw/source chat export rows linked to the case thought ids
  --verbose           Print per-case details
  --help              Show this message
`);
}

function parseArgs(argv) {
  const args = {
    casesPath: path.join(repoRoot, "local/open-brain-mcp/evals/graph-retrieval-eval-cases.json"),
    database: process.env.OPEN_BRAIN_GRAPH_DATABASE ?? "ob1-graph-stage",
    schemaVariant: process.env.OPEN_BRAIN_GRAPH_SCHEMA_VARIANT ?? "provenance-v1",
    outputPath: null,
    ensureProjection: true,
    includeChatSources: false,
    verbose: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cases") {
      args.casesPath = path.resolve(argv[++index]);
    } else if (arg === "--database") {
      args.database = argv[++index];
    } else if (arg === "--schema-variant") {
      args.schemaVariant = argv[++index];
    } else if (arg === "--output") {
      args.outputPath = path.resolve(argv[++index]);
    } else if (arg === "--no-project") {
      args.ensureProjection = false;
    } else if (arg === "--include-chat-sources") {
      args.includeChatSources = true;
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
  return [...new Set(values.filter(Boolean))];
}

async function deriveChatProjectionDedupeKeys(thoughtIds) {
  if (!Array.isArray(thoughtIds) || thoughtIds.length === 0) {
    return [];
  }

  const result = await query(
    `
      select
        nullif(metadata->'user_metadata'->>'chatgpt_conversation_hash', '') as chatgpt_hash,
        nullif(metadata->'user_metadata'->>'claude_conversation_hash', '') as claude_hash
      from thoughts
      where id = any($1::uuid[])
    `,
    [thoughtIds],
  );

  const dedupeKeys = [];
  for (const row of result.rows) {
    if (row.chatgpt_hash) {
      dedupeKeys.push(`chatgpt:conversation_record:${row.chatgpt_hash}`);
      dedupeKeys.push(`chatgpt:conversation_source:${row.chatgpt_hash}`);
    }
    if (row.claude_hash) {
      dedupeKeys.push(`claude:conversation_record:${row.claude_hash}`);
      dedupeKeys.push(`claude:conversation_source:${row.claude_hash}`);
    }
  }

  return unique(dedupeKeys);
}

function intersectionCount(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item)).length;
}

function scoreCase(testCase, vectorRows, graphRows, graphExpansion) {
  const vectorIds = vectorRows.map((row) => row.id);
  const graphIds = graphRows.map((row) => row.id);
  const graphAddedIds = graphExpansion?.added_ids ?? [];
  const notes = [];
  let score = 100;

  const expectedVectorIds = testCase.expected_vector_ids ?? [];
  const minVectorHits = testCase.min_expected_vector_hits ?? expectedVectorIds.length;
  const vectorHits = intersectionCount(vectorIds, expectedVectorIds);
  if (expectedVectorIds.length > 0 && vectorHits < minVectorHits) {
    score -= 25;
    notes.push(`vector retrieval found ${vectorHits}/${minVectorHits} required baseline ids`);
  }

  const expectedGraphIds = testCase.expected_graph_result_ids ?? [];
  const minGraphHits = testCase.min_expected_graph_hits ?? expectedGraphIds.length;
  const graphHits = intersectionCount(graphIds, expectedGraphIds);
  if (expectedGraphIds.length > 0 && graphHits < minGraphHits) {
    score -= 40;
    notes.push(`graph retrieval found ${graphHits}/${minGraphHits} required ids`);
  }

  const expectedAddedIds = testCase.expected_graph_added_ids ?? [];
  const minAddedHits = testCase.min_expected_graph_added_hits ?? expectedAddedIds.length;
  const addedHits = intersectionCount(graphAddedIds, expectedAddedIds);
  if (expectedAddedIds.length > 0 && addedHits < minAddedHits) {
    score -= 30;
    notes.push(`graph expansion added ${addedHits}/${minAddedHits} expected new ids`);
  }

  const allowedAddedIds = new Set([...expectedGraphIds, ...expectedAddedIds]);
  const unexpectedAddedIds = graphAddedIds.filter((id) => !allowedAddedIds.has(id));
  if (typeof testCase.max_unexpected_graph_added === "number" && unexpectedAddedIds.length > testCase.max_unexpected_graph_added) {
    score -= Math.min(25, 10 * (unexpectedAddedIds.length - testCase.max_unexpected_graph_added));
    notes.push(`graph expansion added ${unexpectedAddedIds.length} unexpected ids`);
  }

  if (graphAddedIds.length === 0 && expectedAddedIds.length > 0) {
    score -= 10;
    notes.push("graph expansion added no new rows");
  }

  score = Math.max(0, Math.min(100, score));
  const decision = score >= 85 ? "accept" : "reject";
  if (notes.length === 0) {
    notes.push("retrieval behavior matched the fixed expectations");
  }

  return {
    total_score: score,
    decision,
    notes: notes.slice(0, 4),
    vector_ids: vectorIds,
    graph_ids: graphIds,
    graph_added_ids: graphAddedIds,
    unexpected_graph_added_ids: unexpectedAddedIds,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cases = JSON.parse(fs.readFileSync(args.casesPath, "utf8"));
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error(`No cases found in ${args.casesPath}`);
  }

  if (args.ensureProjection) {
    const projectionIds = unique(cases.flatMap((testCase) => testCase.projection_ids ?? []));
    const explicitDedupeKeys = unique(cases.flatMap((testCase) => testCase.projection_dedupe_keys ?? []));
    const derivedChatKeys = args.includeChatSources
      ? await deriveChatProjectionDedupeKeys(projectionIds)
      : [];
    const projectionDedupeKeys = unique([...explicitDedupeKeys, ...derivedChatKeys]);
    if (projectionIds.length > 0 || projectionDedupeKeys.length > 0) {
      await projectThoughts({
        database: args.database,
        schemaVariant: args.schemaVariant,
        thoughtIds: projectionIds,
        dedupeKeys: projectionDedupeKeys,
        forceAll: true,
        limit: projectionIds.length + projectionDedupeKeys.length,
      });
    }
  }

  const results = [];
  for (const testCase of cases) {
    const vector = await retrieveEvidenceRows({
      queryText: testCase.question,
      threshold: testCase.match_threshold ?? 0.4,
      count: testCase.match_count ?? 6,
      filter: testCase.filter ?? {},
      graphAssisted: false,
      graphDatabase: args.database,
    });

    const graph = await retrieveEvidenceRows({
      queryText: testCase.question,
      threshold: testCase.match_threshold ?? 0.4,
      count: testCase.match_count ?? 6,
      filter: testCase.filter ?? {},
      graphAssisted: true,
      graphMaxHops: testCase.graph_max_hops,
      graphNeighborLimit: testCase.graph_neighbor_limit,
      graphDatabase: args.database,
    });

    const judgment = scoreCase(testCase, vector.evidenceRows, graph.evidenceRows, graph.graphExpansion);
    const entry = {
      case: testCase,
      vector_only: {
        ids: vector.evidenceRows.map((row) => row.id),
        titles: vector.evidenceRows.map((row) => row.metadata?.summary ?? "").slice(0, 6),
      },
      graph_assisted: {
        ids: graph.evidenceRows.map((row) => row.id),
        added_ids: graph.graphExpansion.added_ids ?? [],
        expansion: graph.graphExpansion,
      },
      thoughts: graph.evidenceRows.map((row) => row.content),
      judgment,
    };
    results.push(entry);

    if (args.verbose) {
      console.log(`${testCase.id}: score=${judgment.total_score} decision=${judgment.decision} added=${judgment.graph_added_ids.length}`);
    }
  }

  const meanScore = results.reduce((sum, item) => sum + item.judgment.total_score, 0) / results.length;
  const accepted = results.filter((item) => item.judgment.decision === "accept").length;
  const report = {
    generated_at: new Date().toISOString(),
    database: args.database,
    schema_variant: args.schemaVariant,
    policy_path: graphRetrievalPolicyPath(),
    policy: loadGraphRetrievalPolicy(),
    case_count: results.length,
    mean_score: Number(meanScore.toFixed(2)),
    accepted,
    results,
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
