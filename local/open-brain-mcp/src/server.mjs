import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import * as z from "zod/v3";
import { config } from "./config.mjs";
import { closePool, formatVector, healthcheckDatabase, query } from "./db.mjs";
import {
  createEmbedding,
  extractMetadata,
  healthcheckUpstreams,
  normalizeMetadata,
} from "./models.mjs";

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
  const embedding = await createEmbedding(args.query.trim());
  const threshold = args.match_threshold ?? 0.4;
  const matchCount = args.match_count ?? 10;
  const filter = args.filter ?? {};

  let results;
  let retrievalStrategy = "direct";
  let fallbackUsed = false;

  if (hasExplicitSearchRole(filter)) {
    const direct = await matchThoughtRows({
      embedding,
      threshold,
      count: matchCount,
      filter,
    });
    results = direct.rows;
  } else {
    retrievalStrategy = "distilled-first";

    const preferred = await matchThoughtRows({
      embedding,
      threshold,
      count: matchCount,
      filter: { ...filter, retrieval_role: "distilled" },
    });

    results = preferred.rows;

    if (results.length < matchCount) {
      const fallback = await matchThoughtRows({
        embedding,
        threshold,
        count: Math.min(matchCount * 3, 50),
        filter,
      });

      results = mergeUniqueThoughtRows(preferred.rows, fallback.rows).slice(0, matchCount);
      fallbackUsed = true;
    }
  }

  return {
    success: true,
    query: args.query,
    retrieval_strategy: retrievalStrategy,
    fallback_used: fallbackUsed,
    count: results.length,
    results,
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

  return {
    success: true,
    overview: overviewResult.rows[0] ?? null,
    top_sources: sourceCounts.rows,
    top_types: typeCounts.rows,
    top_people: peopleCounts.rows,
  };
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
    const [upstreams] = await Promise.all([
      healthcheckUpstreams(),
      healthcheckDatabase(),
    ]);

    return c.json({
      status: "healthy",
      service: config.serviceName,
      llm_model: config.llmModel,
      embedding_model: config.embeddingModel,
      embedding_dimensions: config.expectedEmbeddingDimension,
      upstreams,
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
