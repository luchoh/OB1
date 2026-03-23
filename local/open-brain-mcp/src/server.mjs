import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import * as z from "zod/v3";
import { HttpError, resolveAccessContext } from "./auth.mjs";
import { config } from "./config.mjs";
import { closePool, formatVector, healthcheckDatabase, query } from "./db.mjs";
import {
  graphNeighbors,
  graphProjectionStats,
  healthcheckGraph,
  sourceLineage,
  whyConnected,
} from "./graph.mjs";
import {
  answerFromEvidence,
  createEmbedding,
  extractMetadata,
  healthcheckUpstreams,
  normalizeMetadata,
} from "./models.mjs";
import {
  expandContextRows,
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

const updateThoughtMetadataSchema = {
  thought_id: z.string().uuid().describe("Canonical OB1 thought UUID."),
  metadata_patch: z.record(z.any()).describe("Metadata patch merged into the thought metadata without changing content or embeddings."),
};
const updateThoughtMetadataInput = z.object(updateThoughtMetadataSchema);

const similarThoughtLookupSchema = {
  queries: z.array(z.string().min(1)).min(1).max(10).describe("Candidate strings to compare against the existing brain."),
  match_threshold: z.number().min(0).max(1).optional().describe("Minimum similarity threshold."),
  match_count: z.number().int().min(1).max(10).optional().describe("Maximum number of similar matches per query."),
  filter: z.record(z.any()).optional().describe("Optional JSONB containment filter."),
};
const similarThoughtLookupInput = z.object(similarThoughtLookupSchema);

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

const whyConnectedSchema = {
  from_thought_id: z.string().uuid().optional().describe("Canonical OB1 thought UUID for the left-hand node."),
  from_canonical_id: z.string().optional().describe("Optional graph canonical_id for the left-hand node."),
  to_thought_id: z.string().uuid().optional().describe("Canonical OB1 thought UUID for the right-hand node."),
  to_canonical_id: z.string().optional().describe("Optional graph canonical_id for the right-hand node."),
  max_hops: z.number().int().min(1).max(6).optional().describe("Maximum path length to consider."),
  limit: z.number().int().min(1).max(8).optional().describe("Maximum number of shortest paths to return."),
};

const expandContextSchema = {
  thought_id: z.string().uuid().optional().describe("Canonical OB1 thought UUID used as the seed context row."),
  canonical_id: z.string().optional().describe("Optional graph canonical_id such as thought:<uuid>."),
  question: z.string().optional().describe("Optional natural-language question used to rank expanded context rows."),
  filter: z.record(z.any()).optional().describe("Optional JSONB containment filter applied to expanded thought rows."),
  max_hops: z.number().int().min(1).max(3).optional().describe("Maximum graph hop count."),
  limit: z.number().int().min(1).max(24).optional().describe("Maximum number of expanded thought rows to return."),
};

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

function routeBrainSlug(c) {
  try {
    const value = c.req.param("brainSlug");
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

function errorStatus(error) {
  if (error instanceof HttpError) {
    return error.status;
  }
  if (error instanceof z.ZodError) {
    return 400;
  }
  return 500;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
    claim_kind: userMetadata.claim_kind ?? null,
    epistemic_status: userMetadata.epistemic_status ?? null,
    claim_subject: userMetadata.claim_subject ?? null,
    claim_object: userMetadata.claim_object ?? null,
    claim_scope: userMetadata.claim_scope ?? null,
    claim_strength: userMetadata.claim_strength ?? null,
    claim_rationale: userMetadata.claim_rationale ?? null,
    created_at: row.created_at ?? null,
  };
}

function graphContextItem(row, graphMetadata) {
  return {
    ...evidenceCitation(row),
    graph: {
      hop_count: graphMetadata?.hopCount ?? null,
      anchor_types: Array.isArray(graphMetadata?.anchorTypes) ? graphMetadata.anchorTypes : [],
    },
  };
}

function hasExplicitSearchRole(filter) {
  return filter
    && typeof filter === "object"
    && (Object.prototype.hasOwnProperty.call(filter, "type")
      || Object.prototype.hasOwnProperty.call(filter, "retrieval_role"));
}

async function upsertThought({ brainId, content, embedding, metadata, dedupeKey }) {
  const result = await query(
    `
      insert into thoughts (
        brain_id,
        content,
        embedding,
        embedding_model,
        embedding_dimension,
        dedupe_key,
        metadata
      )
      values (
        $1::uuid,
        $2,
        $3::vector,
        $4,
        $5,
        coalesce($6, encode(digest($2, 'sha256'), 'hex')),
        $7::jsonb
      )
      on conflict (brain_id, dedupe_key)
      do update set
        content = excluded.content,
        embedding = excluded.embedding,
        embedding_model = excluded.embedding_model,
        embedding_dimension = excluded.embedding_dimension,
        metadata = thoughts.metadata || excluded.metadata,
        updated_at = now()
      returning
        id,
        brain_id,
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
      brainId,
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

async function handleCaptureThought(args, accessContext) {
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
    brainId: accessContext.effectiveBrainId,
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

async function handleSearchThoughts(args, accessContext) {
  const threshold = args.match_threshold ?? 0.4;
  const matchCount = args.match_count ?? 10;
  const filter = args.filter ?? {};
  const retrieval = await retrieveThoughtRows({
    brainId: accessContext.effectiveBrainId,
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

async function handleAskBrain(args, accessContext) {
  if ((args.graph_assisted ?? false) && !accessContext.isAdmin) {
    throw new HttpError(400, "graph_assisted is disabled for non-admin multitenant requests");
  }

  const threshold = args.match_threshold ?? 0.4;
  const matchCount = args.match_count ?? 6;
  const filter = args.filter ?? {};
  const { retrieval, graphExpansion, evidenceRows, questionIntent } = await retrieveEvidenceRows({
    brainId: accessContext.effectiveBrainId,
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
      question_intent: questionIntent,
      graph_assisted: args.graph_assisted ?? false,
      graph_expansion: graphExpansion,
      evidence_count: 0,
      citations: [],
    };
  }

  const grounded = await answerFromEvidence(args.question, evidence, {
    questionIntent,
  });
  const citations = evidence.filter((item) => grounded.citations.includes(item.id));

  return {
    success: true,
    question: args.question,
    answer: grounded.answer,
    grounded: grounded.grounded,
    insufficient_evidence: grounded.insufficient_evidence,
    retrieval_strategy: retrieval.retrieval_strategy,
    fallback_used: retrieval.fallback_used,
    question_intent: questionIntent,
    graph_assisted: args.graph_assisted ?? false,
    graph_expansion: graphExpansion,
    evidence_count: evidence.length,
    citations,
  };
}

async function updateThoughtMetadata({ brainId, thoughtId, metadataPatch }) {
  const result = await query(
    `
      update thoughts
      set
        metadata = (
          thoughts.metadata
          || ($3::jsonb - 'user_metadata')
          || case
            when $3::jsonb ? 'user_metadata' then jsonb_build_object(
              'user_metadata',
              coalesce(thoughts.metadata->'user_metadata', '{}'::jsonb)
              || coalesce($3::jsonb->'user_metadata', '{}'::jsonb)
            )
            else '{}'::jsonb
          end
        ),
        updated_at = now()
      where id = $1::uuid
        and brain_id = $2::uuid
      returning
        id,
        metadata,
        updated_at
    `,
    [thoughtId, brainId, JSON.stringify(metadataPatch)],
  );

  if (result.rowCount !== 1) {
    throw new Error(`Thought not found: ${thoughtId}`);
  }

  return {
    success: true,
    thought_id: result.rows[0].id,
    metadata: result.rows[0].metadata,
    updated_at: result.rows[0].updated_at,
  };
}

async function handleSimilarThoughtLookup(args, accessContext) {
  const matchThreshold = args.match_threshold ?? 0.78;
  const matchCount = args.match_count ?? 3;
  const filter = args.filter ?? {};
  const queries = [...new Set(args.queries.map((value) => value.trim()).filter(Boolean))];

  const results = [];
  for (const queryText of queries) {
    const retrieval = await retrieveThoughtRows({
      brainId: accessContext.effectiveBrainId,
      queryText,
      threshold: matchThreshold,
      count: matchCount,
      filter,
    });

    results.push({
      query: queryText,
      retrieval_strategy: retrieval.retrieval_strategy,
      fallback_used: retrieval.fallback_used,
      matches: retrieval.results.map((row) => evidenceCitation(row)),
    });
  }

  return {
    success: true,
    count: results.length,
    results,
  };
}

async function handleListThoughts(args, accessContext) {
  const result = await query(
    "select * from list_recent_thoughts($1::uuid, $2, $3::jsonb)",
    [accessContext.effectiveBrainId, args.limit ?? 20, JSON.stringify(args.filter ?? {})],
  );

  return {
    success: true,
    count: result.rows.length,
    thoughts: result.rows,
  };
}

async function handleStats(accessContext) {
  const [overviewResult, sourceCounts, typeCounts, peopleCounts] = await Promise.all([
    query("select * from thoughts_stats($1::uuid)", [accessContext.effectiveBrainId]),
    query(`
      select
        coalesce(metadata->>'source', 'unknown') as source,
        count(*)::bigint as count
      from thoughts
      where brain_id = $1::uuid
      group by 1
      order by count desc, source asc
      limit 10
    `, [accessContext.effectiveBrainId]),
    query(`
      select
        coalesce(metadata->>'type', 'unknown') as type,
        count(*)::bigint as count
      from thoughts
      where brain_id = $1::uuid
      group by 1
      order by count desc, type asc
      limit 10
    `, [accessContext.effectiveBrainId]),
    query(`
      select
        person,
        count(*)::bigint as count
      from (
        select jsonb_array_elements_text(coalesce(metadata->'people', '[]'::jsonb)) as person
        from thoughts
        where brain_id = $1::uuid
      ) people
      group by person
      order by count desc, person asc
      limit 10
    `, [accessContext.effectiveBrainId]),
  ]);

  const stats = {
    success: true,
    overview: overviewResult.rows[0] ?? null,
    top_sources: sourceCounts.rows,
    top_types: typeCounts.rows,
    top_people: peopleCounts.rows,
  };

  const graphStats = accessContext.isAdmin
    ? await graphProjectionStats(config.graph.database).catch(() => null)
    : null;
  if (graphStats) {
    stats.graph = {
      enabled: config.graph.enabled,
      database: config.graph.database,
      projection: graphStats,
    };
  } else if (config.graph.enabled && accessContext.isAdmin) {
    stats.graph = {
      enabled: true,
      database: config.graph.database,
      projection: null,
    };
  }

  return stats;
}

function ensureGraphAdmin(accessContext) {
  if (!accessContext.isAdmin) {
    throw new HttpError(403, "Graph endpoints are disabled for non-admin multitenant requests");
  }
}

async function handleGraphNeighbors(args, accessContext) {
  ensureGraphAdmin(accessContext);
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

async function handleSourceLineage(args, accessContext) {
  ensureGraphAdmin(accessContext);
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

async function handleWhyConnected(args, accessContext) {
  ensureGraphAdmin(accessContext);
  const hasFrom = Boolean(args.from_thought_id || args.from_canonical_id);
  const hasTo = Boolean(args.to_thought_id || args.to_canonical_id);
  if (!hasFrom || !hasTo) {
    throw new Error("Both a from-node and a to-node are required");
  }

  return whyConnected({
    fromThoughtId: args.from_thought_id,
    fromCanonicalId: args.from_canonical_id,
    toThoughtId: args.to_thought_id,
    toCanonicalId: args.to_canonical_id,
    maxHops: args.max_hops ?? 4,
    limit: args.limit ?? 3,
  });
}

async function handleExpandContext(args, accessContext) {
  ensureGraphAdmin(accessContext);
  if (!args.thought_id && !args.canonical_id) {
    throw new Error("Either thought_id or canonical_id is required");
  }

  const result = await expandContextRows({
    brainId: accessContext.effectiveBrainId,
    thoughtId: args.thought_id,
    canonicalId: args.canonical_id,
    questionText: args.question ?? "",
    filter: args.filter ?? {},
    maxHops: args.max_hops ?? 2,
    limit: args.limit ?? 6,
  });

  return {
    success: true,
    seed: evidenceCitation(result.seedRow),
    question: args.question ?? null,
    question_intent: result.questionIntent,
    graph_expansion: result.graphExpansion,
    count: result.relatedRows.length,
    results: result.relatedRows.map((row) => graphContextItem(row, result.metadataById.get(row.id))),
  };
}

function buildMcpServer(accessContext) {
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
        return jsonToolResult(await handleCaptureThought(args, accessContext));
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
        return jsonToolResult(await handleSearchThoughts(args, accessContext));
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
        return jsonToolResult(await handleListThoughts(args, accessContext));
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
        return jsonToolResult(await handleStats(accessContext));
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
        return jsonToolResult(await handleAskBrain(args, accessContext));
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
        return jsonToolResult(await handleGraphNeighbors(args, accessContext));
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
        return jsonToolResult(await handleSourceLineage(args, accessContext));
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  server.tool(
    "why_connected",
    "Explain the shortest graph path between two thoughts or graph nodes.",
    whyConnectedSchema,
    async (args) => {
      try {
        return jsonToolResult(await handleWhyConnected(args, accessContext));
      } catch (error) {
        return errorToolResult(error);
      }
    },
  );

  server.tool(
    "expand_context",
    "Expand graph-related thought context from a seed thought without invoking answer synthesis.",
    expandContextSchema,
    async (args) => {
      try {
        return jsonToolResult(await handleExpandContext(args, accessContext));
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
    brain_endpoint: "/mcp/brains/:brainSlug",
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
  try {
    const accessContext = await resolveAccessContext(c);
    const payload = captureThoughtInput.parse(await c.req.json());
    const result = await handleCaptureThought(payload, accessContext);
    return c.json(result, 201);
  } catch (error) {
    return c.json({ success: false, error: errorMessage(error) }, errorStatus(error));
  }
});

app.post("/ask", async (c) => {
  try {
    const accessContext = await resolveAccessContext(c);
    const payload = askBrainInput.parse(await c.req.json());
    const result = await handleAskBrain(payload, accessContext);
    return c.json(result);
  } catch (error) {
    return c.json({ success: false, error: errorMessage(error) }, errorStatus(error));
  }
});

app.post("/admin/thought/metadata", async (c) => {
  try {
    const accessContext = await resolveAccessContext(c);
    const payload = updateThoughtMetadataInput.parse(await c.req.json());
    const result = await updateThoughtMetadata({
      brainId: accessContext.effectiveBrainId,
      thoughtId: payload.thought_id,
      metadataPatch: payload.metadata_patch,
    });
    return c.json(result);
  } catch (error) {
    return c.json({ success: false, error: errorMessage(error) }, errorStatus(error));
  }
});

app.post("/admin/thought/similar", async (c) => {
  try {
    const accessContext = await resolveAccessContext(c);
    const payload = similarThoughtLookupInput.parse(await c.req.json());
    const result = await handleSimilarThoughtLookup(payload, accessContext);
    return c.json(result);
  } catch (error) {
    return c.json({ success: false, error: errorMessage(error) }, errorStatus(error));
  }
});

app.post("/graph/neighbors", async (c) => {
  try {
    const accessContext = await resolveAccessContext(c);
    const payload = await c.req.json();
    const result = await handleGraphNeighbors(payload, accessContext);
    return c.json(result);
  } catch (error) {
    return c.json({ success: false, error: errorMessage(error) }, errorStatus(error));
  }
});

app.post("/graph/source-lineage", async (c) => {
  try {
    const accessContext = await resolveAccessContext(c);
    const payload = await c.req.json();
    const result = await handleSourceLineage(payload, accessContext);
    return c.json(result);
  } catch (error) {
    return c.json({ success: false, error: errorMessage(error) }, errorStatus(error));
  }
});

app.post("/graph/why-connected", async (c) => {
  try {
    const accessContext = await resolveAccessContext(c);
    const payload = await c.req.json();
    const result = await handleWhyConnected(payload, accessContext);
    return c.json(result);
  } catch (error) {
    return c.json({ success: false, error: errorMessage(error) }, errorStatus(error));
  }
});

app.post("/graph/expand-context", async (c) => {
  try {
    const accessContext = await resolveAccessContext(c);
    const payload = await c.req.json();
    const result = await handleExpandContext(payload, accessContext);
    return c.json(result);
  } catch (error) {
    return c.json({ success: false, error: errorMessage(error) }, errorStatus(error));
  }
});

app.post("/mcp", async (c) => {
  try {
    const accessContext = await resolveAccessContext(c);
    const server = buildMcpServer(accessContext);
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    return transport.handleRequest(c);
  } catch (error) {
    return c.json({ error: errorMessage(error) }, errorStatus(error));
  }
});

app.post("/mcp/brains/:brainSlug", async (c) => {
  try {
    const accessContext = await resolveAccessContext(c, { routeBrainSlug: routeBrainSlug(c) });
    const server = buildMcpServer(accessContext);
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    return transport.handleRequest(c);
  } catch (error) {
    return c.json({ error: errorMessage(error) }, errorStatus(error));
  }
});

export async function shutdown() {
  await closePool();
}
