import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import * as z from "zod/v3";
import { HttpError, authorizeWrite, authorizeDestructive, authorizePurge, resolveAccessContext, resolveRequestBrain, resolveReadBrains } from "./auth.mjs";
import { deriveCaptureStamp } from "./access-policy.mjs";
import { config } from "./config.mjs";
import { closePool, healthcheckDatabase, query } from "./db.mjs";
import {
  captureThought,
  peekCaptureConflictTier,
  patchThoughtMetadata,
  softDeleteThought,
  restoreThought,
  purgeThought,
  brainStats,
  ThoughtStoreError,
  STORE_ERROR,
} from "./thought-store.mjs";
import {
  graphNeighbors,
  graphProjectionStats,
  healthcheckGraph,
  purgeThoughtNode,
  reconcileGraphOrphans,
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
import { appendRetrievalTelemetry } from "./observability.mjs";
import {
  expandContextRows,
  retrieveThoughts as retrieveThoughtRows,
  retrieveEvidenceRows,
} from "./retrieval.mjs";

const captureThoughtSchema = {
  content: z.string().min(1).describe("The thought or note to store."),
  brain: z.string().optional().describe("Optional target brain (slug or UUID). Defaults to the principal's default brain."),
  metadata: z.record(z.any()).optional().describe("Optional caller-provided metadata as JSON."),
  source: z.string().optional().describe("Optional source label for the thought."),
  type: z.string().optional().describe("Optional type override for the thought."),
  tags: z.array(z.string()).optional().describe("Optional tags to merge into the thought metadata."),
  occurred_at: z.string().optional().describe("Optional source timestamp in ISO 8601 format."),
  dedupe_key: z.string().min(1).optional().describe("Optional stable key for idempotent imports."),
  extract_metadata: z.boolean().optional().describe("Whether to run LLM metadata extraction before storing."),
  sensitivity_tier: z.enum(["standard", "restricted"]).optional().describe("Egress tier at creation (docs/45 §6.8). Defaults to 'standard'. 'restricted' is local-on-box-only and may only be captured into a private_local/quarantine_review brain."),
};
const captureThoughtInput = z.object(captureThoughtSchema);

const searchThoughtsSchema = {
  query: z.string().min(1).describe("Natural-language search query."),
  brain: z.string().optional().describe("Optional brain to scope to (slug or UUID). Defaults to the caller's effective brain."),
  match_threshold: z.number().min(0).max(1).optional().describe("Minimum similarity threshold."),
  match_count: z.number().int().min(1).max(50).optional().describe("Maximum number of matches."),
  filter: z.record(z.any()).optional().describe("Optional JSONB containment filter. If omitted, search prefers distilled thoughts before falling back to raw source records."),
  recency_weight: z.number().min(0).max(1).optional().describe("Blend with exponential time-decay in [0,1]. 0 (default) = pure similarity (same as match_thoughts). 0.2 = gentle nudge toward recent, 0.5 = even blend, 1.0 = pure recency. Threshold still gates raw cosine similarity before the blend."),
  half_life_days: z.number().positive().optional().describe("Half-life for recency decay in days. Only consulted when recency_weight > 0. Defaults to 90."),
};

const listThoughtsSchema = {
  limit: z.number().int().min(1).max(100).optional().describe("Number of recent thoughts to return."),
  brain: z.string().optional().describe("Optional brain to scope to (slug or UUID). Defaults to the caller's effective brain."),
  filter: z.record(z.any()).optional().describe("Optional JSONB containment filter."),
};

const askBrainSchema = {
  question: z.string().min(1).describe("Natural-language question to answer from the local brain."),
  brain: z.string().optional().describe("Optional brain to scope to (slug or UUID). Defaults to the caller's effective brain."),
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
  brain: z.string().optional().describe("Optional brain the thought lives in (slug or UUID). Defaults to the principal's default brain."),
  metadata_patch: z.record(z.any()).optional().describe("Metadata patch merged into the thought metadata without changing content or embeddings."),
  type: z.string().min(1).max(64).optional().describe("Structured type column. Free-form; consumers may constrain to a known taxonomy."),
  source_type: z.string().min(1).max(64).optional().describe("Structured source_type column."),
  // sensitivity_tier is intentionally NOT patchable here (docs/45 §6.7): this
  // generic route must not be a declassification path. Tier transitions go
  // through a dedicated local-trusted capability (a later slice).
  importance: z.number().int().min(0).max(100).optional().describe("Structured importance column (0-100)."),
  quality_score: z.number().min(0).max(100).optional().describe("Structured quality_score column (0-100)."),
  enriched: z.boolean().optional().describe("Mark the thought as enriched (or not)."),
  status: z.string().min(1).max(64).optional().describe("Structured status column for kanban-style task/idea workflow."),
};
const updateThoughtMetadataInput = z
  .object(updateThoughtMetadataSchema)
  .refine(
    (v) =>
      v.metadata_patch !== undefined
      || v.type !== undefined
      || v.source_type !== undefined
      || v.importance !== undefined
      || v.quality_score !== undefined
      || v.enriched !== undefined
      || v.status !== undefined,
    { message: "at least one of metadata_patch or a structured column is required" },
  );

// M3 D7: soft-delete / restore are HTTP-only (never MCP tools — see D9). A single
// thought_id + optional brain; no bulk / delete-by-query.
const deleteThoughtSchema = {
  thought_id: z.string().uuid().describe("Canonical OB1 thought UUID to soft-delete."),
  brain: z.string().optional().describe("Optional brain the thought lives in (slug or UUID). Defaults to the principal's default brain."),
};
const deleteThoughtInput = z.object(deleteThoughtSchema);

const restoreThoughtSchema = {
  thought_id: z.string().uuid().describe("Canonical OB1 thought UUID to restore."),
  brain: z.string().optional().describe("Optional brain the thought lives in (slug or UUID). Defaults to the principal's default brain."),
};
const restoreThoughtInput = z.object(restoreThoughtSchema);

// M5 D7/D9: purge (hard erasure) is HTTP-only, admin-only, single thought_id, and
// requires a confirmation arg (expected content_hash and/or dedupe_key) so a wrong
// id fails closed. The refine enforces "at least one confirmation present".
const purgeThoughtSchema = {
  thought_id: z.string().uuid().describe("Canonical OB1 thought UUID to purge (hard erase)."),
  brain: z.string().optional().describe("Optional brain the thought lives in (slug or UUID). Defaults to the principal's default brain."),
  expected_content_hash: z.string().optional().describe("D9 confirmation: the thought's current content_hash. Must match or the purge aborts. At least one of expected_content_hash / expected_dedupe_key is required."),
  expected_dedupe_key: z.string().optional().describe("D9 confirmation: the thought's current dedupe_key. Must match or the purge aborts. At least one of expected_content_hash / expected_dedupe_key is required."),
};
const purgeThoughtInput = z
  .object(purgeThoughtSchema)
  .refine(
    (v) => v.expected_content_hash !== undefined || v.expected_dedupe_key !== undefined,
    { message: "at least one of expected_content_hash or expected_dedupe_key is required" },
  );

const reconcileOrphansInput = z.object({
  batch_size: z.number().int().min(1).max(10000).optional().describe("Per-round page size for the Neo4j scan. The sweep always covers the WHOLE graph (paginated); this only tunes the batch size, it does not cap coverage."),
});

const similarThoughtLookupSchema = {
  queries: z.array(z.string().min(1)).min(1).max(10).describe("Candidate strings to compare against the existing brain."),
  brain: z.string().optional().describe("Optional brain to scope to (slug or UUID). Defaults to the caller's effective brain."),
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

// Thought-store refusals are data with a `kind`; the transport owns the mapping.
const STORE_ERROR_STATUS = {
  not_found: 404,
  confirmation_mismatch: 409,
  audit_invariant: 500,
};

function errorStatus(error) {
  if (error instanceof HttpError) {
    return error.status;
  }
  if (error instanceof ThoughtStoreError) {
    return STORE_ERROR_STATUS[error.kind] ?? 500;
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

async function handleCaptureThought(args, accessContext) {
  const { brainId } = await resolveRequestBrain(accessContext, args.brain);
  // ADR-0002 write ladder: capture is a WRITE. Authorize before doing any work.
  // (Pre-ADR-0002 the runtime had no write gate — any reachable brain was
  // writable; this is the call site that enforcement was missing.)
  await authorizeWrite(accessContext, brainId);
  const callerReadEgressClass = accessContext._policy.caller.readEgressClass;

  // §6.10/§6.5 PREFLIGHT (before any processor call): a cloud_bound caller may
  // not upsert OVER an existing restricted row. Deny here so the content never
  // reaches the embedding/LLM processors. The captureThought ON CONFLICT guard
  // is the atomic backstop; this is the egress-safe early exit.
  if (args.dedupe_key) {
    const existingTier = await peekCaptureConflictTier({ brainId, dedupeKey: args.dedupe_key });
    if (existingTier !== undefined && existingTier !== "standard" && callerReadEgressClass !== "local_trusted") {
      throw new ThoughtStoreError(STORE_ERROR.NOT_FOUND, `Thought not found: ${args.dedupe_key}`);
    }
  }

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

  // Stamp the egress-boundary columns from the caller's egress class (docs/45
  // §6.8/§6.11). A cloud-bound (or unknown) writer is cloud_origin; a cloud_origin
  // restricted capture is quarantined (unreviewed) at creation.
  const stamp = deriveCaptureStamp({
    caller: accessContext._policy?.caller,
    sensitivityTier: args.sensitivity_tier,
  });

  const thought = await captureThought({
    brainId,
    content,
    embedding: embeddingResult.value,
    embeddingModel: config.embeddingModel,
    metadata: normalizedMetadata,
    dedupeKey: args.dedupe_key,
    sensitivityTier: args.sensitivity_tier,
    originEgressClass: stamp.originEgressClass,
    sourceTrustClass: stamp.sourceTrustClass,
    reviewState: stamp.reviewState,
    callerReadEgressClass,
  });

  return {
    success: true,
    message: "Thought captured",
    metadata_extraction_enabled: shouldExtractMetadata,
    thought,
  };
}

export async function handleSearchThoughts(args, accessContext) {
  const brains = await resolveReadBrains(accessContext, args.brain);
  const startedAt = Date.now();
  const threshold = args.match_threshold ?? 0.4;
  const matchCount = args.match_count ?? 10;
  const filter = args.filter ?? {};
  const recencyWeight = args.recency_weight ?? 0;
  const halfLifeDays = args.half_life_days ?? 90;
  try {
    // v24 D4/D6: fan out across every brain in scope, tag each row with its
    // origin, then merge and re-rank by similarity (single-brain stays identical
    // plus the two new origin fields).
    const perBrain = await Promise.all(
      brains.map(async (b) => ({
        brain: b,
        retrieval: await retrieveThoughtRows({
          brainId: b.brainId,
          queryText: args.query,
          threshold,
          count: matchCount,
          filter,
          recencyWeight,
          halfLifeDays,
        }),
      })),
    );

    const results = perBrain
      .flatMap(({ brain, retrieval }) =>
        retrieval.results.map((row) => ({ ...row, brain_id: brain.brainId, brain_slug: brain.brainSlug })))
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
      .slice(0, matchCount);

    const multi = brains.length > 1;
    const response = {
      success: true,
      query: args.query,
      brains_searched: brains.length,
      retrieval_strategy: multi ? "multi-brain-merge" : perBrain[0].retrieval.retrieval_strategy,
      fallback_used: perBrain.some((p) => p.retrieval.fallback_used),
      recency_weight: recencyWeight,
      half_life_days: recencyWeight > 0 ? halfLifeDays : null,
      count: results.length,
      results,
    };

    appendRetrievalTelemetry({
      eventType: "search_thoughts_retrieval",
      accessContext,
      queryText: args.query,
      threshold,
      requestedCount: matchCount,
      retrievalStrategy: response.retrieval_strategy,
      fallbackUsed: response.fallback_used,
      resultRows: results,
      elapsedMs: Date.now() - startedAt,
      success: true,
      extra: {
        recency_weight: recencyWeight,
        half_life_days: recencyWeight > 0 ? halfLifeDays : null,
        accessible_brain_count: accessContext.accessibleBrains?.length ?? null,
        searched_brain_count: brains.length,
      },
    });

    return response;
  } catch (error) {
    appendRetrievalTelemetry({
      eventType: "search_thoughts_retrieval",
      accessContext,
      queryText: args.query,
      threshold,
      requestedCount: matchCount,
      elapsedMs: Date.now() - startedAt,
      success: false,
      error,
      extra: {
        recency_weight: recencyWeight,
        half_life_days: recencyWeight > 0 ? halfLifeDays : null,
      },
    });
    throw error;
  }
}

async function handleAskBrain(args, accessContext) {
  const { brainId } = await resolveRequestBrain(accessContext, args.brain);
  if ((args.graph_assisted ?? false) && !accessContext.isAdmin) {
    throw new HttpError(400, "graph_assisted is disabled for non-admin multitenant requests");
  }

  const startedAt = Date.now();
  const threshold = args.match_threshold ?? 0.4;
  const matchCount = args.match_count ?? 6;
  const filter = args.filter ?? {};
  let retrieval = null;
  let graphExpansion = {
    enabled: Boolean(args.graph_assisted ?? false),
    reason: "not_started",
  };
  let evidenceRows = [];
  let questionIntent = null;

  try {
    ({
      retrieval,
      graphExpansion,
      evidenceRows,
      questionIntent,
    } = await retrieveEvidenceRows({
      brainId,
      queryText: args.question,
      threshold,
      count: matchCount,
      filter,
      graphAssisted: args.graph_assisted ?? false,
      graphMaxHops: args.graph_max_hops ?? 2,
      graphNeighborLimit: args.graph_neighbor_limit ?? matchCount,
    }));
    const evidence = evidenceRows.map(evidenceCitation);

    if (evidence.length === 0) {
      const response = {
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

      appendRetrievalTelemetry({
        eventType: "ask_brain_retrieval",
        accessContext,
        queryText: args.question,
        threshold,
        requestedCount: matchCount,
        retrievalStrategy: retrieval.retrieval_strategy,
        fallbackUsed: retrieval.fallback_used,
        resultRows: evidenceRows,
        graphAssisted: args.graph_assisted ?? false,
        graphExpansion,
        elapsedMs: Date.now() - startedAt,
        success: true,
        extra: {
          question_intent: questionIntent,
          grounded: false,
          insufficient_evidence: true,
          citation_ids: [],
        },
      });

      return response;
    }

    const grounded = await answerFromEvidence(args.question, evidence, {
      questionIntent,
    });
    const citations = evidence.filter((item) => grounded.citations.includes(item.id));

    const response = {
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

    appendRetrievalTelemetry({
      eventType: "ask_brain_retrieval",
      accessContext,
      queryText: args.question,
      threshold,
      requestedCount: matchCount,
      retrievalStrategy: retrieval.retrieval_strategy,
      fallbackUsed: retrieval.fallback_used,
      resultRows: evidenceRows,
      graphAssisted: args.graph_assisted ?? false,
      graphExpansion,
      elapsedMs: Date.now() - startedAt,
      success: true,
      extra: {
        question_intent: questionIntent,
        grounded: grounded.grounded,
        insufficient_evidence: grounded.insufficient_evidence,
        citation_ids: citations.map((item) => item.id),
      },
    });

    return response;
  } catch (error) {
    appendRetrievalTelemetry({
      eventType: "ask_brain_retrieval",
      accessContext,
      queryText: args.question,
      threshold,
      requestedCount: matchCount,
      retrievalStrategy: retrieval?.retrieval_strategy,
      fallbackUsed: retrieval?.fallback_used,
      resultRows: evidenceRows,
      graphAssisted: args.graph_assisted ?? false,
      graphExpansion,
      elapsedMs: Date.now() - startedAt,
      success: false,
      error,
      extra: {
        question_intent: questionIntent,
      },
    });
    throw error;
  }
}

async function handleSimilarThoughtLookup(args, accessContext) {
  const brains = await resolveReadBrains(accessContext, args.brain);
  const matchThreshold = args.match_threshold ?? 0.78;
  const matchCount = args.match_count ?? 3;
  const filter = args.filter ?? {};
  const queries = [...new Set(args.queries.map((value) => value.trim()).filter(Boolean))];

  const results = [];
  for (const queryText of queries) {
    // v24 D4/D6: fan out per query, tag matches with origin, merge by similarity.
    const perBrain = await Promise.all(
      brains.map(async (b) => {
        const retrieval = await retrieveThoughtRows({
          brainId: b.brainId,
          queryText,
          threshold: matchThreshold,
          count: matchCount,
          filter,
        });
        return retrieval.results.map((row) => ({
          ...evidenceCitation(row),
          brain_id: b.brainId,
          brain_slug: b.brainSlug,
        }));
      }),
    );
    const matches = perBrain
      .flat()
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
      .slice(0, matchCount);
    results.push({
      query: queryText,
      brains_searched: brains.length,
      matches,
    });
  }

  return {
    success: true,
    count: results.length,
    results,
  };
}

export async function handleListThoughts(args, accessContext) {
  const brains = await resolveReadBrains(accessContext, args.brain);
  const limit = args.limit ?? 20;
  const filter = JSON.stringify(args.filter ?? {});

  // v24 D4/D6: fan out, tag rows with origin, merge newest-first, truncate.
  const perBrain = await Promise.all(
    brains.map(async (b) => {
      const result = await query(
        "select * from list_recent_thoughts($1::uuid, $2, $3::jsonb)",
        [b.brainId, limit, filter],
      );
      return result.rows.map((row) => ({ ...row, brain_id: b.brainId, brain_slug: b.brainSlug }));
    }),
  );

  const thoughts = perBrain
    .flat()
    .sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return tb - ta;
    })
    .slice(0, limit);

  return {
    success: true,
    brains_listed: brains.length,
    count: thoughts.length,
    thoughts,
  };
}

// v24 D6: aggregate the per-brain thoughts_stats overviews — sum the counts,
// min/max the capture timestamps.
function aggregateOverview(perBrain) {
  let total = 0;
  let embedded = 0;
  let first = null;
  let last = null;
  for (const pb of perBrain) {
    const ov = pb.overview;
    if (!ov) continue;
    total += Number(ov.total_thoughts ?? 0);
    embedded += Number(ov.embedded_thoughts ?? 0);
    // Compare via epoch so it is robust whether pg returns ISO strings or Dates.
    if (ov.first_capture && (first === null || new Date(ov.first_capture).getTime() < new Date(first).getTime())) {
      first = ov.first_capture;
    }
    if (ov.last_capture && (last === null || new Date(ov.last_capture).getTime() > new Date(last).getTime())) {
      last = ov.last_capture;
    }
  }
  return { total_thoughts: total, embedded_thoughts: embedded, first_capture: first, last_capture: last };
}

export async function handleStats(args, accessContext) {
  // v24 D6: always per_brain[] (even for one brain, so the shape never flips
  // when memberships change) plus an aggregate overview. An explicit/L1
  // selector narrows to a single brain.
  const brains = await resolveReadBrains(accessContext, args?.brain);
  const perBrain = await Promise.all(
    brains.map(async (b) => ({
      brain_id: b.brainId,
      brain_slug: b.brainSlug,
      ...(await brainStats(b.brainId)),
    })),
  );

  const stats = {
    success: true,
    brains: brains.length,
    overview: aggregateOverview(perBrain),
    per_brain: perBrain,
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

  const startedAt = Date.now();
  const requestedLimit = args.limit ?? 6;

  try {
    const result = await expandContextRows({
      brainId: accessContext.effectiveBrainId,
      thoughtId: args.thought_id,
      canonicalId: args.canonical_id,
      questionText: args.question ?? "",
      filter: args.filter ?? {},
      maxHops: args.max_hops ?? 2,
      limit: requestedLimit,
    });

    const response = {
      success: true,
      seed: evidenceCitation(result.seedRow),
      question: args.question ?? null,
      question_intent: result.questionIntent,
      graph_expansion: result.graphExpansion,
      count: result.relatedRows.length,
      results: result.relatedRows.map((row) => graphContextItem(row, result.metadataById.get(row.id))),
    };

    appendRetrievalTelemetry({
      eventType: "expand_context_retrieval",
      accessContext,
      queryText: args.question ?? "",
      requestedCount: requestedLimit,
      retrievalStrategy: "graph-context",
      fallbackUsed: false,
      resultRows: result.relatedRows,
      graphAssisted: true,
      graphExpansion: result.graphExpansion,
      elapsedMs: Date.now() - startedAt,
      success: true,
      extra: {
        seed_id: result.seedRow.id,
        question_intent: result.questionIntent,
      },
    });

    return response;
  } catch (error) {
    appendRetrievalTelemetry({
      eventType: "expand_context_retrieval",
      accessContext,
      queryText: args.question ?? "",
      requestedCount: requestedLimit,
      retrievalStrategy: "graph-context",
      fallbackUsed: false,
      graphAssisted: true,
      elapsedMs: Date.now() - startedAt,
      success: false,
      error,
    });
    throw error;
  }
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
    { brain: z.string().optional().describe("Optional brain to scope to (slug or UUID). Defaults to all accessible brains.") },
    async (args) => {
      try {
        return jsonToolResult(await handleStats(args, accessContext));
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

// Map a Thought-store lifecycle outcome to the wire response shape (docs/32 D9:
// wire shapes are law; the store returns transport-agnostic { thoughtId, outcome }).
function deleteResponse({ thoughtId, outcome }) {
  return outcome === "deleted"
    ? { success: true, thought_id: thoughtId, deleted: true }
    : { success: true, thought_id: thoughtId, already_deleted: true };
}
function restoreResponse({ thoughtId, outcome }) {
  return outcome === "restored"
    ? { success: true, thought_id: thoughtId, restored: true }
    : { success: true, thought_id: thoughtId, already_live: true };
}
function purgeResponse({ thoughtId, outcome }) {
  return outcome === "purged"
    ? { success: true, thought_id: thoughtId, purged: true, graph_purged: true }
    : { success: true, thought_id: thoughtId, purged: true, graph_only: true };
}

app.post("/admin/thought/metadata", async (c) => {
  try {
    const accessContext = await resolveAccessContext(c);
    const payload = updateThoughtMetadataInput.parse(await c.req.json());
    const { brainId } = await resolveRequestBrain(accessContext, payload.brain);
    // ADR-0002 write ladder: a metadata patch mutates a Thought -> WRITE. Gate
    // it like capture so the ladder has no inconsistent seam (a viewer must not
    // mutate via the metadata path). Runs before the thought lookup, so an
    // unauthorized caller gets 403, not a 404 leak.
    await authorizeWrite(accessContext, brainId);
    const row = await patchThoughtMetadata({
      brainId,
      thoughtId: payload.thought_id,
      metadataPatch: payload.metadata_patch,
      type: payload.type,
      sourceType: payload.source_type,
      importance: payload.importance,
      qualityScore: payload.quality_score,
      enriched: payload.enriched,
      status: payload.status,
      // §6.10: a cloud_bound caller cannot mutate a restricted row.
      callerReadEgressClass: accessContext._policy.caller.readEgressClass,
    });
    return c.json({
      success: true,
      thought_id: row.id,
      metadata: row.metadata,
      type: row.type,
      source_type: row.source_type,
      sensitivity_tier: row.sensitivity_tier,
      importance: row.importance,
      quality_score: row.quality_score,
      enriched: row.enriched,
      status: row.status,
      updated_at: row.updated_at,
    });
  } catch (error) {
    return c.json({ success: false, error: errorMessage(error) }, errorStatus(error));
  }
});

// M3 D9: delete/restore are HTTP-only and NOT registered as MCP tools (agents
// must not receive destructive tools). authorizeDestructive runs AFTER brain
// resolution so 404-vs-403 ordering follows the resolved brain, and the actor it
// returns is recorded in the audit row.
app.post("/admin/thought/delete", async (c) => {
  try {
    const accessContext = await resolveAccessContext(c);
    const payload = deleteThoughtInput.parse(await c.req.json());
    const { brainId } = await resolveRequestBrain(accessContext, payload.brain);
    const actor = await authorizeDestructive(accessContext, brainId, { action: "delete" });
    const result = await softDeleteThought({
      brainId,
      thoughtId: payload.thought_id,
      actor,
      callerReadEgressClass: accessContext._policy.caller.readEgressClass,
    });
    return c.json(deleteResponse(result));
  } catch (error) {
    return c.json({ success: false, error: errorMessage(error) }, errorStatus(error));
  }
});

app.post("/admin/thought/restore", async (c) => {
  try {
    const accessContext = await resolveAccessContext(c);
    const payload = restoreThoughtInput.parse(await c.req.json());
    const { brainId } = await resolveRequestBrain(accessContext, payload.brain);
    const actor = await authorizeDestructive(accessContext, brainId, { action: "restore" });
    const result = await restoreThought({
      brainId,
      thoughtId: payload.thought_id,
      actor,
      callerReadEgressClass: accessContext._policy.caller.readEgressClass,
    });
    return c.json(restoreResponse(result));
  } catch (error) {
    return c.json({ success: false, error: errorMessage(error) }, errorStatus(error));
  }
});

// M5 D7/D9: purge is HTTP-only and NOT an MCP tool. authorizePurge is STRICTER
// than authorizeDestructive — admin-only AND forbids the bare legacy key — and
// runs AFTER brain resolution so the actor it returns matches the resolved brain.
app.post("/admin/thought/purge", async (c) => {
  try {
    const accessContext = await resolveAccessContext(c);
    const payload = purgeThoughtInput.parse(await c.req.json());
    const { brainId } = await resolveRequestBrain(accessContext, payload.brain);
    const actor = authorizePurge(accessContext, brainId);
    const result = await purgeThought({
      brainId,
      thoughtId: payload.thought_id,
      expectedContentHash: payload.expected_content_hash,
      expectedDedupeKey: payload.expected_dedupe_key,
      actor,
      // docs/32 D7: the store owns the Neo4j-first ordering; the handler supplies
      // the graph DETACH-DELETE (driver + graph database name live here).
      purgeGraphNode: (canonicalId) => purgeThoughtNode(canonicalId, config.graph.database),
    });
    return c.json(purgeResponse(result));
  } catch (error) {
    return c.json({ success: false, error: errorMessage(error) }, errorStatus(error));
  }
});

// M5 D8: graph orphan reconcile. Admin-only, non-legacy (authorizePurge-level).
// The recurring drift sweep AND the one-time past-debris cleanup. Not an MCP tool.
app.post("/admin/graph/reconcile-orphans", async (c) => {
  try {
    const accessContext = await resolveAccessContext(c);
    const payload = reconcileOrphansInput.parse(await c.req.json());
    authorizePurge(accessContext, accessContext.effectiveBrainId);
    const result = await reconcileGraphOrphans({ batchSize: payload.batch_size });
    return c.json({ success: true, ...result });
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
