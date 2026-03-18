import { config } from "./config.mjs";
import { closePool } from "./db.mjs";
import {
  ensureGraphDatabaseExists,
  ensureGraphSchema,
  projectThoughts,
  closeGraph,
} from "./graph.mjs";

function parseArgs(argv) {
  const args = {
    database: config.graph.database,
    limit: config.graph.projectorBatchSize,
    forceAll: false,
    thoughtIds: [],
    dedupeKeys: [],
    ensureDatabase: true,
    ensureSchema: true,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--database") {
      args.database = argv[++i];
    } else if (arg === "--limit") {
      args.limit = Number(argv[++i]);
    } else if (arg === "--all") {
      args.forceAll = true;
    } else if (arg === "--thought-id") {
      args.thoughtIds.push(argv[++i]);
    } else if (arg === "--dedupe-key") {
      args.dedupeKeys.push(argv[++i]);
    } else if (arg === "--no-ensure-database") {
      args.ensureDatabase = false;
    } else if (arg === "--no-ensure-schema") {
      args.ensureSchema = false;
    } else if (arg === "--verbose") {
      args.verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node src/graph-projector.mjs [options]

Options:
  --database NAME          Graph database to project into
  --limit N                Max thought rows to process
  --all                    Force reproject all eligible rows
  --thought-id UUID        Reproject one thought row (repeatable)
  --dedupe-key KEY         Reproject one dedupe key (repeatable)
  --no-ensure-database     Skip CREATE DATABASE IF NOT EXISTS
  --no-ensure-schema       Skip graph constraint setup
  --verbose                Print per-row projection progress
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

async function main() {
  if (!config.graph.enabled) {
    throw new Error("Graph integration is disabled. Set OPEN_BRAIN_GRAPH_ENABLED=true first.");
  }

  const args = parseArgs(process.argv.slice(2));

  if (args.ensureDatabase) {
    await ensureGraphDatabaseExists(args.database);
  }

  if (args.ensureSchema) {
    await ensureGraphSchema(args.database);
  }

  const result = await projectThoughts(args);
  console.log(JSON.stringify(result, null, 2));

  if (result.failed > 0) {
    process.exitCode = 1;
  }
}

try {
  await main();
} finally {
  await closeGraph();
  await closePool();
}
