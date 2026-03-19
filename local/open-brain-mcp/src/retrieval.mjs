import { config } from "./config.mjs";
import { query, formatVector } from "./db.mjs";
import { graphThoughtNeighbors } from "./graph.mjs";
import { loadGraphRetrievalPolicy } from "./graph-retrieval-policy.mjs";
import { createEmbedding } from "./models.mjs";

function nestedUserMetadata(row) {
  const userMetadata = row?.metadata?.user_metadata;
  return userMetadata && typeof userMetadata === "object" && !Array.isArray(userMetadata)
    ? userMetadata
    : {};
}

function preferredRowTitle(row) {
  const metadata = row?.metadata ?? {};
  const userMetadata = nestedUserMetadata(row);
  return (
    userMetadata.chatgpt_title
    ?? userMetadata.claude_title
    ?? metadata.summary
    ?? userMetadata.subject
    ?? metadata.subject
    ?? ""
  ).trim();
}

function normalizeKey(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function hasExplicitSearchRole(filter) {
  return filter
    && typeof filter === "object"
    && (Object.prototype.hasOwnProperty.call(filter, "type")
      || Object.prototype.hasOwnProperty.call(filter, "retrieval_role"));
}

function queryEmbeddingVector(queryText) {
  const normalized = queryText?.trim();
  if (!normalized) {
    throw new Error("queryText is required for retrieval");
  }
  return createEmbedding(normalized);
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

export function mergeUniqueThoughtRows(...groups) {
  const seen = new Set();
  const merged = [];

  for (const group of groups) {
    for (const row of group ?? []) {
      if (!row?.id || seen.has(row.id)) {
        continue;
      }
      seen.add(row.id);
      merged.push(row);
    }
  }

  return merged;
}

export async function retrieveThoughts({
  queryText,
  threshold,
  count,
  filter,
  embedding = null,
}) {
  const queryVector = embedding ?? await queryEmbeddingVector(queryText);

  let results;
  let retrievalStrategy = "direct";
  let fallbackUsed = false;

  if (hasExplicitSearchRole(filter)) {
    const direct = await matchThoughtRows({
      embedding: queryVector,
      threshold,
      count,
      filter,
    });
    results = direct.rows;
  } else {
    retrievalStrategy = "distilled-first";

    const preferred = await matchThoughtRows({
      embedding: queryVector,
      threshold,
      count,
      filter: { ...filter, retrieval_role: "distilled" },
    });

    results = preferred.rows;

    if (results.length < count) {
      const fallback = await matchThoughtRows({
        embedding: queryVector,
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
    embedding: queryVector,
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

function canonicalKind(canonicalId) {
  if (typeof canonicalId !== "string") {
    return "unknown";
  }
  if (canonicalId.startsWith("thought:")) {
    return "thought";
  }
  if (canonicalId.startsWith("conversation:")) {
    return "conversation";
  }
  if (canonicalId.startsWith("email:")) {
    return "email";
  }
  if (canonicalId.startsWith("attachment:")) {
    return "attachment";
  }
  if (canonicalId.startsWith("document:") || canonicalId.startsWith("document_path:")) {
    return "document";
  }
  if (canonicalId.startsWith("dictation:") || canonicalId.startsWith("dictation_audio:")) {
    return "dictation";
  }
  return "unknown";
}

export async function fetchThoughtRowsByIds({ ids, filter, embedding }) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return [];
  }

  const filterJson = JSON.stringify(filter ?? {});
  let result;
  if (Array.isArray(embedding) && embedding.length > 0) {
    result = await query(
      `
        select
          t.id,
          t.content,
          t.embedding_model,
          t.embedding_dimension,
          t.metadata,
          (1 - (t.embedding <=> $2::vector))::float as similarity,
          t.created_at,
          t.updated_at
        from thoughts t
        where t.id = any($1::uuid[])
          and ($3::jsonb = '{}'::jsonb or t.metadata @> $3::jsonb)
      `,
      [ids, formatVector(embedding), filterJson],
    );
  } else {
    result = await query(
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
      [ids, filterJson],
    );
  }

  const byId = new Map(result.rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function seedContext(seedRows) {
  return {
    titles: new Set(seedRows.map((row) => normalizeKey(preferredRowTitle(row))).filter(Boolean)),
    sources: new Set(seedRows.map((row) => normalizeKey(row?.metadata?.source)).filter(Boolean)),
    types: new Set(seedRows.map((row) => normalizeKey(row?.metadata?.type)).filter(Boolean)),
  };
}

function maxAnchorBonus(anchorTypes, policy) {
  const bonuses = policy.ranking.anchorTypeBonuses ?? {};
  const fallback = bonuses.unknown ?? 0;
  if (!Array.isArray(anchorTypes) || anchorTypes.length === 0) {
    return fallback;
  }

  return anchorTypes.reduce((best, anchorType) => {
    const current = bonuses[anchorType] ?? fallback;
    return current > best ? current : best;
  }, fallback);
}

function graphCandidateScore(row, metadata, policy, seeds) {
  const ranking = policy.ranking;
  const similarity = typeof row?.similarity === "number" ? row.similarity : 0;
  const role = row?.metadata?.retrieval_role ?? "unknown";
  const titleKey = normalizeKey(preferredRowTitle(row));
  const sourceKey = normalizeKey(row?.metadata?.source);
  const typeKey = normalizeKey(row?.metadata?.type);

  let score = similarity * ranking.similarityWeight;
  score -= (metadata?.hopCount ?? 99) * ranking.hopPenalty;
  score -= ranking.retrievalRolePenalties[role] ?? ranking.retrievalRolePenalties.unknown ?? 0;
  score += maxAnchorBonus(metadata?.anchorTypes ?? [], policy);

  if (titleKey && seeds.titles.has(titleKey)) {
    score += ranking.sameTitleBonus;
  }
  if (sourceKey && seeds.sources.has(sourceKey)) {
    score += ranking.sameSourceBonus;
  }
  if (typeKey && seeds.types.has(typeKey)) {
    score += ranking.sameTypeBonus;
  } else if (typeKey && seeds.types.size > 0) {
    score -= ranking.differentTypePenalty;
  }

  return score;
}

function vectorSeedScore(row, index, policy) {
  const ranking = policy.ranking;
  const similarity = typeof row?.similarity === "number" ? row.similarity : 0;
  const role = row?.metadata?.retrieval_role ?? "unknown";

  let score = similarity * ranking.similarityWeight;
  score += ranking.seedBonus;
  score -= index * ranking.vectorRankPenalty;
  score -= ranking.retrievalRolePenalties[role] ?? ranking.retrievalRolePenalties.unknown ?? 0;
  return score;
}

function compareScoredRows(a, b) {
  if (a.score !== b.score) {
    return b.score - a.score;
  }

  const aSeed = a.origin === "seed" ? 1 : 0;
  const bSeed = b.origin === "seed" ? 1 : 0;
  if (aSeed !== bSeed) {
    return bSeed - aSeed;
  }

  const aTime = a.row?.created_at ? Date.parse(a.row.created_at) : 0;
  const bTime = b.row?.created_at ? Date.parse(b.row.created_at) : 0;
  if (aTime !== bTime) {
    return bTime - aTime;
  }

  return a.row.id.localeCompare(b.row.id);
}

function anchorTypesForNeighbor(neighbor) {
  const anchorTypes = new Set();
  for (const relationship of neighbor?.relationships ?? []) {
    for (const canonicalId of [relationship?.from, relationship?.to]) {
      const kind = canonicalKind(canonicalId);
      if (kind !== "thought" && kind !== "unknown") {
        anchorTypes.add(kind);
      }
    }
  }
  return [...anchorTypes];
}

function selectEvidenceRows({ seedRows, graphRows, count, policy, seeds, graphMetadataById }) {
  const scored = [];
  const graphRowIds = new Set(graphRows.map((row) => row.id));

  seedRows.forEach((row, index) => {
    scored.push({
      origin: "seed",
      row,
      score: vectorSeedScore(row, index, policy),
    });
  });

  graphRows.forEach((row) => {
    scored.push({
      origin: "graph",
      row,
      score: graphCandidateScore(row, graphMetadataById.get(row.id), policy, seeds),
    });
  });

  scored.sort(compareScoredRows);

  const selected = [];
  const selectedGraphIds = [];
  const seen = new Set();

  for (const item of scored) {
    if (!item.row?.id || seen.has(item.row.id)) {
      continue;
    }
    seen.add(item.row.id);
    selected.push(item.row);
    if (graphRowIds.has(item.row.id)) {
      selectedGraphIds.push(item.row.id);
    }
    if (selected.length >= count) {
      break;
    }
  }

  return {
    evidenceRows: selected,
    selectedGraphIds,
  };
}

export async function expandThoughtsWithGraph({
  seedRows,
  filter,
  embedding,
  maxHops,
  limit,
  database = config.graph.database,
} = {}) {
  if (!config.graph.enabled) {
    throw new Error("Graph-assisted retrieval requested but graph integration is disabled");
  }

  const policy = loadGraphRetrievalPolicy();
  const resolvedHops = Math.max(1, Math.min(3, Number(maxHops) || policy.defaultMaxHops));
  const resolvedLimit = Math.max(1, Math.min(48, Number(limit) || policy.defaultAddedRows));

  if (!Array.isArray(seedRows) || seedRows.length === 0) {
    return {
      rows: [],
      expansion: {
        enabled: true,
        seed_count: 0,
        candidate_count: 0,
        added_count: 0,
        added_ids: [],
        max_hops: resolvedHops,
        limit: resolvedLimit,
      },
      metadataById: new Map(),
    };
  }

  const seedIds = new Set(seedRows.map((row) => row.id));
  const candidateIds = [];
  const metadataById = new Map();
  const perSeedLimit = Math.max(8, Math.min(200, policy.perSeedTraversalLimit));

  for (const row of seedRows) {
    const neighborResult = await graphThoughtNeighbors({
      thoughtId: row.id,
      maxHops: resolvedHops,
      limit: perSeedLimit,
      allowedRetrievalRoles: policy.allowedRetrievalRoles,
      database,
    });

    for (const neighbor of neighborResult.neighbors ?? []) {
      const graphThoughtId = thoughtIdFromCanonicalId(neighbor.node?.canonical_id);
      if (!graphThoughtId || seedIds.has(graphThoughtId) || metadataById.has(graphThoughtId)) {
        continue;
      }

      metadataById.set(graphThoughtId, {
        hopCount: neighbor.hop_count ?? 99,
        anchorTypes: anchorTypesForNeighbor(neighbor),
      });
      candidateIds.push(graphThoughtId);
    }
  }

  const fetchedRows = await fetchThoughtRowsByIds({
    ids: candidateIds,
    filter,
    embedding,
  });

  return {
    rows: fetchedRows.slice(0, resolvedLimit),
    expansion: {
      enabled: true,
      seed_count: seedRows.length,
      candidate_count: fetchedRows.length,
      candidate_ids: fetchedRows.map((row) => row.id),
      added_count: 0,
      added_ids: [],
      max_hops: resolvedHops,
      limit: resolvedLimit,
      policy_version: policy.version,
    },
    metadataById,
  };
}

export async function retrieveEvidenceRows({
  queryText,
  threshold,
  count,
  filter,
  graphAssisted = false,
  graphMaxHops,
  graphNeighborLimit,
  graphDatabase = config.graph.database,
} = {}) {
  const retrieval = await retrieveThoughts({
    queryText,
    threshold,
    count,
    filter,
  });

  const graphExpansion = graphAssisted
    ? await expandThoughtsWithGraph({
      seedRows: retrieval.results,
      filter,
      embedding: retrieval.embedding,
      maxHops: graphMaxHops,
      limit: graphNeighborLimit,
      database: graphDatabase,
    })
    : {
      rows: [],
      expansion: {
        enabled: false,
        reason: "not_requested",
      },
      metadataById: new Map(),
    };

  if (!graphAssisted) {
    return {
      retrieval,
      graphExpansion: graphExpansion.expansion,
      evidenceRows: retrieval.results,
    };
  }

  const policy = loadGraphRetrievalPolicy();
  const seeds = seedContext(retrieval.results);
  const selected = selectEvidenceRows({
    seedRows: retrieval.results,
    graphRows: graphExpansion.rows,
    count,
    policy,
    seeds,
    graphMetadataById: graphExpansion.metadataById,
  });

  return {
    retrieval,
    graphExpansion: {
      ...graphExpansion.expansion,
      added_count: selected.selectedGraphIds.length,
      added_ids: selected.selectedGraphIds,
    },
    evidenceRows: selected.evidenceRows,
  };
}
