import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import * as z from "zod/v3";
import { config } from "./config.mjs";
import { closePool, formatVector, healthcheckDatabase, query } from "./db.mjs";
import {
  graphNeighbors,
  graphProjectionStats,
  healthcheckGraph,
  sourceLineage,
} from "./graph.mjs";
import {
  answerFromEvidence,
  createEmbedding,
  extractMetadata,
  healthcheckUpstreams,
  normalizeMetadata,
} from "./models.mjs";
import {
  retrieveThoughts as retrieveThoughtRows,
  retrieveEvidenceRows,
} from "./retrieval.mjs";

const captureThoughtSchema = {
  content: z.string().min(1).describe("The thought or note to store."),
  metadata: z.record(z.any()).optional().describe("Optional caller-provided metadata as JSON."),
  source: z.string().optional().describe("Optional source label for the thought."),
  type: z.string().optional().describe("Optional type override for the thought."),
  tags: z.array(z.string()).optional().describe("Optional tags to merge into the thought metadata."),
  occurred_at: z.string().optional().describe("Optional source timestamp in ISO 8601 format."),
  dedupe_key: z.string().min(1).optional().describe("Optional stable key for idempotent imports."),
  extract_metadata: z.boolean().optional().describe("Whether to run LLM metadata extraction before storing."),
};
const captureThoughtInput = z.object(captureThoughtSchema);

const searchThoughtsSchema = {
  query: z.string().min(1).describe("Natural-language search query."),
  match_threshold: z.number().min(0).max(1).optional().describe("Minimum similarity threshold."),
  match_count: z.number().int().min(1).max(50).optional().describe("Maximum number of matches."),
  filter: z.record(z.any()).optional().describe("Optional JSONB containment filter. If omitted, search prefers distilled thoughts before falling back to raw source records."),
};

const listThoughtsSchema = {
  limit: z.number().int().min(1).max(100).optional().describe("Number of recent thoughts to return."),
  filter: z.record(z.any()).optional().describe("Optional JSONB containment filter."),
};

const askBrainSchema = {
  question: z.string().min(1).describe("Natural-language question to answer from the local brain."),
  match_threshold: z.number().min(0).max(1).optional().describe("Minimum similarity threshold for retrieval."),
  match_count: z.number().int().min(1).max(12).optional().describe("Maximum number of evidence items to consider."),
  filter: z.record(z.any()).optional().describe("Optional JSONB containment filter for retrieval."),
  graph_assisted: z.boolean().optional().describe("Whether to expand the retrieved evidence set with related thought rows from the Neo4j graph."),
  graph_max_hops: z.number().int().min(1).max(3).optional().describe("Maximum graph hop count when graph-assisted retrieval is enabled."),
  graph_neighbor_limit: z.number().int().min(1).max(24).optional().describe("Maximum number of additional graph-related thought rows to add when graph-assisted retrieval is enabled."),
};
const askBrainInput = z.object(askBrainSchema);

const graphNeighborsSchema = {
  thought_id: z.string().uuid().optional().describe("Canonical OB1 thought UUID."),
  canonical_id: z.string().optional().describe("Optional graph canonical_id such as thought:<uuid>."),
  max_hops: z.number().int().min(1).max(3).optional().describe("Maximum graph hop count."),
  limit: z.number().int().min(1).max(50).optional().describe("Maximum neighbors to return."),
};

const sourceLineageSchema = {
  thought_id: z.string().uuid().optional().describe("Canonical OB1 thought UUID."),
  canonical_id: z.string().optional().describe("Optional graph canonical_id such as thought:<uuid>."),
  max_depth: z.number().int().min(1).max(6).optional().describe("Maximum source-lineage depth."),
  limit: z.number().int().min(1).max(50).optional().describe("Maximum lineage paths to return."),
};

function authKey(c) {
  return c.req.query("key")
    || c.req.header("x-access-key")
    || c.req.header("x-brain-key");
}

function jsonToolResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorToolResult(error) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

function truncateText(text, limit = 280) {
  if (typeof text !== "string") {
    return "";
  }

  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit - 1)}…`;
}

function nestedUserMetadata(row) {
  const userMetadata = row?.metadata?.user_metadata;
  return userMetadata && typeof userMetadata === "object" && !Array.isArray(userMetadata)
    ? userMetadata
    : {};
}

function evidenceCitation(row) {
  const metadata = row.metadata ?? {};
  const userMetadata = nestedUserMetadata(row);

  return {
    id: row.id,
    similarity: typeof row.similarity === "number" ? Number(row.similarity.toFixed(4)) : null,
    type: metadata.type ?? userMetadata.type ?? null,
    source: metadata.source ?? userMetadata.source ?? null,
    retrieval_role: metadata.retrieval_role ?? null,
    occurred_at: metadata.occurred_at ?? userMetadata.occurred_at ?? null,
    summary: metadata.summary ?? userMetadata.summary ?? truncateText(row.content, 240),
    excerpt: truncateText(row.content, 420),
    email_sender: userMetadata.email_sender ?? userMetadata.sender ?? null,
    email_subject: userMetadata.email_subject ?? userMetadata.subject ?? null,
    document_path: userMetadata.document_path ?? null,
    attachment_filename: userMetadata.attachment_filename ?? null,
    created_at: row.created_at ?? null,
  };
}

function hasExplicitSearchRole(filter) {
  return filter
    && typeof filter === "object"
    && (Object.prototype.hasOwnProperty.call(filter, "type")
      || Object.prototype.hasOwnProperty.call(filter, "retrieval_role"));
}

async function matchThoughtRows({ embedding, threshold, count, filter }) {
  return query(
    "select * from match_thoughts($1::vector, $2, $3, $4::jsonb)",
    [
      formatVector(embedding),
      threshold,
      count,
      JSON.stringify(filter),
    ],
  );
}

async function retrieveThoughts({ queryText, threshold, count, filter }) {
  const embedding = await createEmbedding(queryText.trim());

  let results;
  let retrievalStrategy = "direct";
  let fallbackUsed = false;

  if (hasExplicitSearchRole(filter)) {
    const direct = await matchThoughtRows({
      embedding,
      threshold,
      count,
      filter,
    });
    results = direct.rows;
  } else {
    retrievalStrategy = "distilled-first";

    const preferred = await matchThoughtRows({
      embedding,
      threshold,
      count,
      filter: { ...filter, retrieval_role: "distilled" },
    });

    results = preferred.rows;

    if (results.length < count) {
      const fallback = await matchThoughtRows({
        embedding,
        threshold,
        count: Math.min(count * 3, 50),
        filter,
      });

      results = mergeUniqueThoughtRows(preferred.rows, fallback.rows).slice(0, count);
      fallbackUsed = true;
    }
  }

  return {
    query: queryText,
    retrieval_strategy: retrievalStrategy,
    fallback_used: fallbackUsed,
    results,
  };
}

function thoughtIdFromCanonicalId(canonicalId) {
  if (typeof canonicalId !== "string" || !canonicalId.startsWith("thought:")) {
    return null;
  }

  const thoughtId = canonicalId.slice("thought:".length).trim();
  return thoughtId || null;
}

function graphThoughtSortValue(row, metadata) {
  const retrievalRole = row?.metadata?.retrieval_role ?? null;
  return [
    metadata?.hopCount ?? 99,
    retrievalRole === "distilled" ? 0 : 1,
    row?.created_at ? -Date.parse(row.created_at) : 0,
  ];
}

function compareGraphThoughtRows(a, b, metadataById) {
  const aSort = graphThoughtSortValue(a, metadataById.get(a.id));
  const bSort = graphThoughtSortValue(b, metadataById.get(b.id));

  for (let index = 0; index < aSort.length; index += 1) {
    if (aSort[index] < bSort[index]) {
      return -1;
    }
    if (aSort[index] > bSort[index]) {
      return 1;
    }
  }

  return a.id.localeCompare(b.id);
}

async function fetchThoughtRowsByIds({ ids, filter }) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return [];
  }

  const result = await query(
    `
      select
        t.id,
        t.content,
        t.embedding_model,
        t.embedding_dimension,
        t.metadata,
        null::float as similarity,
        t.created_at,
        t.updated_at
      from thoughts t
      where t.id = any($1::uuid[])
        and ($2::jsonb = '{}'::jsonb or t.metadata @> $2::jsonb)
    `,
    [ids, JSON.stringify(filter ?? {})],
  );

  const byId = new Map(result.rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

async function expandThoughtsWithGraph({
  seedRows,
  filter,
  maxHops = 2,
  limit = 6,
}) {
  if (!config.graph.enabled) {
    throw new Error("Graph-assisted retrieval requested but graph integration is disabled");
  }

  if (!Array.isArray(seedRows) || seedRows.length === 0 || limit <= 0) {
    return {
      rows: [],
      expansion: {
        enabled: true,
        seed_count: Array.isArray(seedRows) ? seedRows.length : 0,
        candidate_count: 0,
        added_count: 0,
        max_hops: maxHops,
        limit,
      },
    };
  }

  const seedIds = new Set(seedRows.map((row) => row.id));
  const candidateIds = [];
  const metadataById = new Map();
  const perSeedTraversalLimit = Math.min(Math.max(limit, 6), 24);

  for (const row of seedRows) {
    const neighborResult = await graphNeighbors({
      thoughtId: row.id,
      maxHops,
      limit: perSeedTraversalLimit,
    });

    for (const neighbor of neighborResult.neighbors ?? []) {
      if (!Array.isArray(neighbor.labels) || !neighbor.labels.includes("Thought")) {
        continue;
      }

      const graphThoughtId = thoughtIdFromCanonicalId(neighbor.node?.canonical_id);
      if (!graphThoughtId || seedIds.has(graphThoughtId) || metadataById.has(graphThoughtId)) {
        continue;
      }

      metadataById.set(graphThoughtId, {
        hopCount: neighbor.hop_count ?? 99,
      });
      candidateIds.push(graphThoughtId);
    }
  }

  const fetchedRows = await fetchThoughtRowsByIds({
    ids: candidateIds,
    filter,
  });

  const sortedRows = [...fetchedRows].sort((a, b) => compareGraphThoughtRows(a, b, metadataById));
  const limitedRows = sortedRows.slice(0, limit);

  return {
    rows: limitedRows,
    expansion: {
      enabled: true,
      seed_count: seedRows.length,
      candidate_count: candidateIds.length,
      added_count: limitedRows.length,
      max_hops: maxHops,
      limit,
    },
  };
}

function mergeUniqueThoughtRows(...groups) {
  const seen = new Set();
  const merged = [];

  for (const group of groups) {
    for (const row of group) {
      if (!row?.id || seen.has(row.id)) {
        continue;
      }
      seen.add(row.id);
      merged.push(row);
    }
  }

  return merged;
}

async function upsertThought({ content, embedding, metadata, dedupeKey }) {
  const result = await query(
    `
      insert into thoughts (
        content,
        embedding,
        embedding_model,
        embedding_dimension,
        dedupe_key,
        metadata
      )
      values (
        $1,
        $2::vector,
        $3,
        $4,
        coalesce($5, encode(digest($1, 'sha256'), 'hex')),
        $6::jsonb
      )
      on conflict (dedupe_key)
      do update set
        content = excluded.content,
        embedding = excluded.embedding,
        embedding_model = excluded.embedding_model,
        embedding_dimension = excluded.embedding_dimension,
        metadata = thoughts.metadata || excluded.metadata,
        updated_at = now()
      returning
        id,
        content,
        dedupe_key,
        content_hash,
        embedding_model,
        embedding_dimension,
        metadata,
        created_at,
        updated_at
    `,
    [
      content,
      formatVector(embedding),
      config.embeddingModel,
      embedding.length,
      dedupeKey ?? null,
      JSON.stringify(metadata),
    ],
  );

  return result.rows[0];
}

async function handleCaptureThought(args) {
  const content = args.content.trim();
  const metadata = args.metadata ?? {};
  const shouldExtractMetadata = args.extract_metadata ?? true;
  const extractionPromise = shouldExtractMetadata
    ? extractMetadata(content, args.source)
    : Promise.resolve({});

  const [embeddingResult, extractionResult] = await Promise.allSettled([
    createEmbedding(content),
    extractionPromise,
  ]);

  if (embeddingResult.status !== "fulfilled") {
    throw embeddingResult.reason;
  }

  const normalizedMetadata = normalizeMetadata({
    content,
    extracted: extractionResult.status === "fulfilled" ? extractionResult.value : {},
    metadata,
    source: args.source,
    type: args.type,
    tags: args.tags,
    occurredAt: args.occurred_at,
    extractionError: extractionResult.status === "rejected"
      ? (extractionResult.reason instanceof Error
        ? extractionResult.reason.message
        : String(extractionResult.reason))
      : null,
  });

  const thought = await upsertThought({
    content,
    embedding: embeddingResult.value,
    metadata: normalizedMetadata,
    dedupeKey: args.dedupe_key,
  });

  return {
    success: true,
    message: "Thought captured",
    metadata_extraction_enabled: shouldExtractMetadata,
    thought,
  };
}

async function handleSearchThoughts(args) {
  const threshold = args.match_threshold ?? 0.4;
  const matchCount = args.match_count ?? 10;
  const filter = args.filter ?? {};
  const retrieval = await retrieveThoughtRows({
    queryText: args.query,
    threshold,
    count: matchCount,
    filter,
  });

  return {
    success: true,
    query: args.query,
    retrieval_strategy: retrieval.retrieval_strategy,
    fallback_used: retrieval.fallback_used,
    count: retrieval.results.length,
    results: retrieval.results,
  };
}

async function handleAskBrain(args) {
  const threshold = args.match_threshold ?? 0.4;
  const matchCount = args.match_count ?? 6;
  const filter = args.filter ?? {};
  const { retrieval, graphExpansion, evidenceRows } = await retrieveEvidenceRows({
    queryText: args.question,
    threshold,
    count: matchCount,
    filter,
    graphAssisted: args.graph_assisted ?? false,
    graphMaxHops: args.graph_max_hops ?? 2,
    graphNeighborLimit: args.graph_neighbor_limit ?? matchCount,
  });
  const evidence = evidenceRows.map(evidenceCitation);

  if (evidence.length === 0) {
    return {
      success: true,
      question: args.question,
      answer: "I do not have enough evidence in memory to answer that reliably.",
      grounded: false,
      insufficient_evidence: true,
      retrieval_strategy: retrieval.retrieval_strategy,
      fallback_used: retrieval.fallback_used,
      graph_assisted: args.graph_assisted ?? false,
      graph_expansion: graphExpansion,
      evidence_count: 0,
      citations: [],
    };
  }

  const grounded = await answerFromEvidence(args.question, evidence);
  const citations = evidence.filter((item) => grounded.citations.includes(item.id));

  return {
    success: true,
    question: args.question,
    answer: grounded.answer,
    grounded: grounded.grounded,
    insufficient_evidence: grounded.insufficient_evidence,
    retrieval_strategy: retrieval.retrieval_strategy,
    fallback_used: retrieval.fallback_used,
    graph_assisted: args.graph_assisted ?? false,
    graph_expansion: graphExpansion,
    evidence_count: evidence.length,
    citations,
  };
}

async function handleListThoughts(args) {
  const result = await query(
    "select * from list_recent_thoughts($1, $2::jsonb)",
    [args.limit ?? 20, JSON.stringify(args.filter ?? {})],
  );

  return {
    success: true,
    count: result.rows.length,
    thoughts: result.rows,
  };
}

async function handleStats() {
  const [overviewResult, sourceCounts, typeCounts, peopleCounts] = await Promise.all([
    query("select * from thoughts_stats()"),
    query(`
      select
        coalesce(metadata->>'source', 'unknown') as source,
        count(*)::bigint as count
      from thoughts
      group by 1
      order by count desc, source asc
      limit 10
    `),
    query(`
      select
        coalesce(metadata->>'type', 'unknown') as type,
        count(*)::bigint as count
      from thoughts
      group by 1
      order by count desc, type asc
      limit 10
    `),
    query(`
      select
        person,
        count(*)::bigint as count
      from (
        select jsonb_array_elements_text(coalesce(metadata->'people', '[]'::jsonb)) as person
        from thoughts
      ) people
      group by person
      order by count desc, person asc
      limit 10
    `),
  ]);

  const stats = {
    success: true,
    overview: overviewResult.rows[0] ?? null,
    top_sources: sourceCounts.rows,
    top_types: typeCounts.rows,
    top_people: peopleCounts.rows,
  };

  const graphStats = await graphProjectionStats(config.graph.database).catch(() => null);
  if (graphStats) {
    stats.graph = {
      enabled: config.graph.enabled,
      database: config.graph.database,
      projection: graphStats,
    };
  } else if (config.graph.enabled) {
    stats.graph = {
      enabled: true,
      database: config.graph.database,
      projection: null,
    };
  }

  return stats;
}

async function handleGraphNeighbors(args) {
  if (!args.thought_id && !args.canonical_id) {
    throw new Error("Either thought_id or canonical_id is required");
  }
  return graphNeighbors({
    thoughtId: args.thought_id,
    canonicalId: args.canonical_id,
    maxHops: args.max_hops ?? 2,
    limit: args.limit ?? 10,
  });
}

async function handleSourceLineage(args) {
  if (!args.thought_id && !args.canonical_id) {
    throw new Error("Either thought_id or canonical_id is required");
  }
  return sourceLineage({
    thoughtId: args.thought_id,
    canonicalId: args.canonical_id,
    maxDepth: args.max_depth ?? 4,
    limit: args.limit ?? 12,
  });
}

function buildMcpServer() {
  const server = new McpServer({
    name: config.serviceName,
    version: "0.1.0",
  });

  server.tool(
    "capture_thought",
    "Store a thought in the local Open Brain with embeddings and extracted metadata.",
    captureThoughtSchema,
    async (args) => {
      try {
        return jsonToolResult(await handleCaptureThought(args));
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  server.tool(
    "search_thoughts",
    "Search the local Open Brain semantically.",
    searchThoughtsSchema,
    async (args) => {
      try {
        return jsonToolResult(await handleSearchThoughts(args));
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  server.tool(
    "list_thoughts",
    "List recent thoughts from the local Open Brain.",
    listThoughtsSchema,
    async (args) => {
      try {
        return jsonToolResult(await handleListThoughts(args));
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  server.tool(
    "stats",
    "Summarize the local Open Brain database.",
    {},
    async () => {
      try {
        return jsonToolResult(await handleStats());
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  server.tool(
    "ask_brain",
    "Answer a question from the local Open Brain using grounded retrieved evidence.",
    askBrainSchema,
    async (args) => {
      try {
        return jsonToolResult(await handleAskBrain(args));
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  server.tool(
    "graph_neighbors",
    "Inspect directly connected graph neighbors for a thought or graph node.",
    graphNeighborsSchema,
    async (args) => {
      try {
        return jsonToolResult(await handleGraphNeighbors(args));
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  server.tool(
    "source_lineage",
    "Trace source and provenance lineage for a thought through the Neo4j graph.",
    sourceLineageSchema,
    async (args) => {
      try {
        return jsonToolResult(await handleSourceLineage(args));
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  return server;
}

export const app = new Hono();

app.get("/", (c) => {
  return c.json({
    status: "ok",
    service: config.serviceName,
    version: "0.1.0",
    transport: "streamable-http",
    endpoint: "/mcp",
  });
});

app.get("/health", async (c) => {
  try {
    const [upstreams, database, graph] = await Promise.all([
      healthcheckUpstreams(),
      healthcheckDatabase(),
      healthcheckGraph().catch((error) => {
        if (!config.graph.enabled) {
          return { enabled: false };
        }
        throw error;
      }),
    ]);

    return c.json({
      status: "healthy",
      service: config.serviceName,
      llm_model: config.llmModel,
      embedding_model: config.embeddingModel,
      embedding_dimensions: config.expectedEmbeddingDimension,
      upstreams,
      database,
      graph,
    });
  } catch (error) {
    return c.json(
      {
        status: "unhealthy",
        service: config.serviceName,
        error: error instanceof Error ? error.message : String(error),
      },
      503,
    );
  }
});

app.post("/ingest/thought", async (c) => {
  const key = authKey(c);
  if (!key || key !== config.accessKey) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const payload = captureThoughtInput.parse(await c.req.json());
    const result = await handleCaptureThought(payload);
    return c.json(result, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof z.ZodError ? 400 : 500;
    return c.json({ success: false, error: message }, status);
  }
});

app.post("/ask", async (c) => {
  const key = authKey(c);
  if (!key || key !== config.accessKey) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const payload = askBrainInput.parse(await c.req.json());
    const result = await handleAskBrain(payload);
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof z.ZodError ? 400 : 500;
    return c.json({ success: false, error: message }, status);
  }
});

app.post("/graph/neighbors", async (c) => {
  const key = authKey(c);
  if (!key || key !== config.accessKey) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const payload = await c.req.json();
    const result = await handleGraphNeighbors(payload);
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ success: false, error: message }, 500);
  }
});

app.post("/graph/source-lineage", async (c) => {
  const key = authKey(c);
  if (!key || key !== config.accessKey) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const payload = await c.req.json();
    const result = await handleSourceLineage(payload);
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ success: false, error: message }, 500);
  }
});

app.post("/mcp", async (c) => {
  const key = authKey(c);
  if (!key || key !== config.accessKey) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const server = buildMcpServer();
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

export async function shutdown() {
  await closePool();
}
