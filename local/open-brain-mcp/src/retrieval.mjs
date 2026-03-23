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

function normalizeQuestion(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const QUESTION_STOPWORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "did",
  "do",
  "does",
  "for",
  "have",
  "how",
  "i",
  "in",
  "is",
  "it",
  "learn",
  "made",
  "my",
  "of",
  "on",
  "out",
  "the",
  "to",
  "what",
  "which",
  "with",
  "work",
  "worked",
]);

function questionTerms(questionText) {
  const normalized = normalizeQuestion(questionText);
  if (!normalized) {
    return [];
  }

  return [...new Set(
    normalized
      .split(/[^a-z0-9.+-]+/i)
      .map((value) => value.trim())
      .filter((value) => value.length >= 4 || /\d/.test(value))
      .filter((value) => !QUESTION_STOPWORDS.has(value)),
  )];
}

function textTerms(value, minLength = 3) {
  const normalized = normalizeKey(value);
  if (!normalized) {
    return [];
  }

  return [...new Set(
    normalized
      .split(/[^a-z0-9.+-]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= minLength || /\d/.test(term)),
  )];
}

function questionSignal(questionText) {
  return {
    normalized: normalizeQuestion(questionText),
    terms: questionTerms(questionText),
  };
}

export function detectQuestionIntent(questionText) {
  const normalized = normalizeQuestion(questionText);
  if (!normalized) {
    return "default";
  }

  if (
    /\b(unresolved|still considering|still exploring|open question|open questions|undecided|not sure|uncertain|pending)\b/.test(normalized)
  ) {
    return "unresolved_status";
  }

  if (
    /\b(compare|comparison|comparing|options|option|alternatives|alternative|tradeoffs|trade-offs)\b/.test(normalized)
  ) {
    return "comparison_options";
  }

  if (
    /\b(best|prefer|preferred|preference|choose|chose|chosen|decide|decided|settle on|settled on|picked|pick|selected|selection|went with)\b/.test(normalized)
  ) {
    return "decision_preference";
  }

  return "default";
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

async function matchThoughtRows({ brainId, embedding, threshold, count, filter }) {
  return query(
    "select * from match_thoughts($1::uuid, $2::vector, $3, $4, $5::jsonb)",
    [
      brainId,
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
  brainId,
  queryText,
  threshold,
  count,
  filter,
  embedding = null,
}) {
  if (!brainId) {
    throw new Error("brainId is required for retrieval");
  }
  const queryVector = embedding ?? await queryEmbeddingVector(queryText);

  let results;
  let retrievalStrategy = "direct";
  let fallbackUsed = false;

  if (hasExplicitSearchRole(filter)) {
    const direct = await matchThoughtRows({
      brainId,
      embedding: queryVector,
      threshold,
      count,
      filter,
    });
    results = direct.rows;
  } else {
    retrievalStrategy = "distilled-first";

    const preferred = await matchThoughtRows({
      brainId,
      embedding: queryVector,
      threshold,
      count,
      filter: { ...filter, retrieval_role: "distilled" },
    });

    results = preferred.rows;

    if (results.length < count) {
      const fallback = await matchThoughtRows({
        brainId,
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

function resolveThoughtIdInput({ thoughtId, canonicalId }) {
  if (typeof thoughtId === "string" && thoughtId.trim()) {
    return thoughtId.trim();
  }

  const resolvedFromCanonical = thoughtIdFromCanonicalId(canonicalId);
  if (resolvedFromCanonical) {
    return resolvedFromCanonical;
  }

  throw new Error("expand_context requires thought_id or a thought:<uuid> canonical_id");
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

export async function fetchThoughtRowsByIds({ brainId, ids, filter, embedding }) {
  if (!brainId) {
    throw new Error("brainId is required for fetchThoughtRowsByIds");
  }
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
          and t.brain_id = $2::uuid
          and ($4::jsonb = '{}'::jsonb or t.metadata @> $4::jsonb)
      `,
      [ids, brainId, formatVector(embedding), filterJson],
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
          and t.brain_id = $2::uuid
          and ($3::jsonb = '{}'::jsonb or t.metadata @> $3::jsonb)
      `,
      [ids, brainId, filterJson],
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
    bundleKeys: new Set(seedRows.map((row) => bundleKeyForRow(row)).filter(Boolean)),
  };
}

function bundleKeyForRow(row) {
  const userMetadata = nestedUserMetadata(row);
  const chatHash = normalizeKey(userMetadata.chatgpt_conversation_hash);
  if (chatHash) {
    return `chat:${chatHash}`;
  }

  const claudeHash = normalizeKey(userMetadata.claude_conversation_hash);
  if (claudeHash) {
    return `claude:${claudeHash}`;
  }

  const titleKey = normalizeKey(preferredRowTitle(row));
  if (titleKey) {
    return `title:${titleKey}`;
  }

  const sourceKey = normalizeKey(row?.metadata?.source);
  const typeKey = normalizeKey(row?.metadata?.type);
  if (sourceKey && typeKey) {
    return `source:${typeKey}:${sourceKey}`;
  }
  if (sourceKey) {
    return `source:${sourceKey}`;
  }

  return row?.id ? `id:${row.id}` : "";
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

function claimMetadata(row) {
  const userMetadata = nestedUserMetadata(row);
  return {
    claimKind: normalizeKey(userMetadata.claim_kind),
    epistemicStatus: normalizeKey(userMetadata.epistemic_status),
    claimStrength: normalizeKey(userMetadata.claim_strength),
    claimSubject: normalizeKey(userMetadata.claim_subject),
    claimObject: normalizeKey(userMetadata.claim_object),
  };
}

function claimIntentBonus(row, questionIntent) {
  if (!questionIntent || questionIntent === "default") {
    return 0;
  }

  const claim = claimMetadata(row);
  let bonus = 0;

  if (questionIntent === "decision_preference") {
    if (claim.claimKind === "decision") {
      bonus += 0.28;
    } else if (claim.claimKind === "preference") {
      bonus += 0.24;
    } else if (claim.claimKind === "implementation_detail") {
      bonus += 0.06;
    }

    if (claim.epistemicStatus === "decided") {
      bonus += 0.22;
    } else if (claim.epistemicStatus === "preferred") {
      bonus += 0.2;
    } else if (claim.epistemicStatus === "implemented") {
      bonus += 0.16;
    } else if (claim.epistemicStatus === "considering" || claim.epistemicStatus === "unresolved") {
      bonus -= 0.08;
    }
  } else if (questionIntent === "comparison_options") {
    if (claim.claimKind === "comparison") {
      bonus += 0.24;
    } else if (claim.claimKind === "option") {
      bonus += 0.22;
    } else if (claim.claimKind === "open_question") {
      bonus += 0.08;
    } else if (claim.claimKind === "decision" || claim.claimKind === "preference") {
      bonus -= 0.04;
    }

    if (claim.epistemicStatus === "considering") {
      bonus += 0.08;
    }
  } else if (questionIntent === "unresolved_status") {
    if (claim.epistemicStatus === "considering") {
      bonus += 0.24;
    } else if (claim.epistemicStatus === "unresolved") {
      bonus += 0.22;
    } else if (claim.epistemicStatus === "observed") {
      bonus += 0.08;
    } else if (
      claim.epistemicStatus === "decided"
      || claim.epistemicStatus === "preferred"
      || claim.epistemicStatus === "implemented"
    ) {
      bonus -= 0.1;
    }

    if (claim.claimKind === "open_question") {
      bonus += 0.16;
    } else if (claim.claimKind === "option") {
      bonus += 0.08;
    }
  }

  if (claim.claimStrength === "strong") {
    bonus += 0.03;
  } else if (claim.claimStrength === "weak") {
    bonus -= 0.01;
  }

  return bonus;
}

function anchorEntityLabelBonus(labels, policy) {
  const bonuses = policy.ranking.entityAnchorLabelBonuses ?? {};
  const fallback = bonuses.unknown ?? 0;
  if (!Array.isArray(labels) || labels.length === 0) {
    return fallback;
  }

  return labels.reduce((best, label) => {
    const current = bonuses[label] ?? fallback;
    return current > best ? current : best;
  }, fallback);
}

function anchorEntityMatchBonus(metadata, signal, policy) {
  const normalizedQuestion = signal?.normalized ?? "";
  const terms = signal?.terms ?? [];
  if (!normalizedQuestion || terms.length === 0) {
    return 0;
  }

  const anchors = Array.isArray(metadata?.anchorEntities) ? metadata.anchorEntities : [];
  if (anchors.length === 0) {
    return 0;
  }

  const exactBonus = policy.ranking.entityAnchorExactBonus ?? 0;
  const partialBonus = policy.ranking.entityAnchorPartialBonus ?? 0;
  const exactBaseBonus = policy.ranking.entityAnchorExactBaseBonus ?? exactBonus;
  const exactPerMatchedTermBonus = policy.ranking.entityAnchorExactPerMatchedTermBonus ?? 0;
  const residualQuestionPenalty = policy.ranking.entityAnchorResidualQuestionPenalty ?? 0;
  let best = 0;

  for (const anchor of anchors) {
    const normalizedName = normalizeKey(anchor?.normalizedName ?? anchor?.canonicalName);
    if (!normalizedName || normalizedName.length < 4) {
      continue;
    }

    const anchorTerms = textTerms(normalizedName);
    const matchedTerms = anchorTerms.filter((term) => (
      terms.includes(term)
      || normalizedQuestion.includes(term)
    ));
    const matchedCount = matchedTerms.length;
    const unmatchedQuestionCount = Math.max(0, terms.length - matchedCount);
    let matchBonus = 0;
    if (normalizedQuestion.includes(normalizedName)) {
      matchBonus = exactBaseBonus
        + (matchedCount * exactPerMatchedTermBonus)
        - (unmatchedQuestionCount * residualQuestionPenalty);
    } else if (terms.some((term) => normalizedName.includes(term) || term.includes(normalizedName))) {
      matchBonus = partialBonus;
    }

    if (matchBonus <= 0) {
      continue;
    }

    matchBonus += anchorEntityLabelBonus(anchor?.labels, policy);
    if (matchBonus > best) {
      best = matchBonus;
    }
  }

  return best;
}

function graphCandidateScore(row, metadata, policy, seeds, questionIntent, signal) {
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

  score += claimIntentBonus(row, questionIntent);
  score += anchorEntityMatchBonus(metadata, signal, policy);

  return score;
}

function vectorSeedScore(row, index, policy, questionIntent) {
  const ranking = policy.ranking;
  const similarity = typeof row?.similarity === "number" ? row.similarity : 0;
  const role = row?.metadata?.retrieval_role ?? "unknown";

  let score = similarity * ranking.similarityWeight;
  score += ranking.seedBonus;
  score -= index * ranking.vectorRankPenalty;
  score -= ranking.retrievalRolePenalties[role] ?? ranking.retrievalRolePenalties.unknown ?? 0;
  score += claimIntentBonus(row, questionIntent);
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

function buildBundleStats(scored, policy, seedBundleKeys) {
  const bundleMap = new Map();

  for (const item of scored) {
    const bundleKey = bundleKeyForRow(item.row);
    item.bundleKey = bundleKey;
    if (!bundleKey) {
      continue;
    }

    let stats = bundleMap.get(bundleKey);
    if (!stats) {
      stats = {
        key: bundleKey,
        itemCount: 0,
        graphCount: 0,
        seedCount: 0,
        maxScore: Number.NEGATIVE_INFINITY,
        scoreTotal: 0,
      };
      bundleMap.set(bundleKey, stats);
    }

    stats.itemCount += 1;
    stats.scoreTotal += item.score;
    if (item.origin === "graph") {
      stats.graphCount += 1;
    } else {
      stats.seedCount += 1;
    }
    if (item.score > stats.maxScore) {
      stats.maxScore = item.score;
    }
  }

  const ranking = policy.ranking;
  for (const stats of bundleMap.values()) {
    let priority = stats.maxScore;
    priority += Math.max(0, stats.itemCount - 1) * ranking.bundleCountBonus;
    if (stats.graphCount > 0) {
      priority += ranking.bundleGraphSupportBonus;
    }
    if (stats.seedCount > 0 && stats.graphCount > 0) {
      priority += ranking.bundleSeedGraphBridgeBonus;
    }
    if (seedBundleKeys.has(stats.key)) {
      priority += ranking.bundleSeedGraphBridgeBonus;
    }
    stats.priority = priority;
  }

  return bundleMap;
}

function choosePrimaryBundle(bundleMap, policy) {
  const minItems = Math.max(2, Number(policy.ranking.primaryBundleMinItems) || 2);
  let best = null;

  for (const stats of bundleMap.values()) {
    if (stats.itemCount < minItems) {
      continue;
    }
    if (!best || stats.priority > best.priority) {
      best = stats;
    }
  }

  return best?.key ?? null;
}

function shouldPrefillPrimaryBundle({
  primaryBundleStats,
  count,
  policy,
  questionIntent,
}) {
  if (!primaryBundleStats) {
    return false;
  }
  if (!questionIntent || questionIntent === "default") {
    return false;
  }

  const minItems = Math.max(2, Number(policy.ranking.primaryBundleMinItems) || 2);
  return primaryBundleStats.itemCount >= minItems && primaryBundleStats.itemCount <= count;
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

function anchorEntitiesForNeighbor(neighbor) {
  if (!Array.isArray(neighbor?.anchors)) {
    return [];
  }

  const seen = new Set();
  const entities = [];
  for (const anchor of neighbor.anchors) {
    const canonicalId = typeof anchor?.canonical_id === "string" ? anchor.canonical_id : "";
    if (!canonicalId || seen.has(canonicalId)) {
      continue;
    }
    seen.add(canonicalId);
    entities.push({
      canonicalId,
      canonicalName: typeof anchor?.canonical_name === "string" ? anchor.canonical_name : "",
      normalizedName: typeof anchor?.normalized_name === "string" ? anchor.normalized_name : "",
      labels: Array.isArray(anchor?.labels) ? anchor.labels.filter((value) => typeof value === "string") : [],
    });
  }
  return entities;
}

function selectEvidenceRows({
  seedRows,
  graphRows,
  count,
  policy,
  seeds,
  graphMetadataById,
  questionIntent,
  signal,
}) {
  const scored = [];
  const graphRowIds = new Set(graphRows.map((row) => row.id));

  seedRows.forEach((row, index) => {
    scored.push({
      origin: "seed",
      row,
      score: vectorSeedScore(row, index, policy, questionIntent),
    });
  });

  graphRows.forEach((row) => {
    scored.push({
      origin: "graph",
      row,
      score: graphCandidateScore(row, graphMetadataById.get(row.id), policy, seeds, questionIntent, signal),
    });
  });

  const bundleMap = buildBundleStats(scored, policy, seeds.bundleKeys);
  const primaryBundleKey = choosePrimaryBundle(bundleMap, policy);
  const primaryBundleStats = primaryBundleKey ? bundleMap.get(primaryBundleKey) : null;
  if (primaryBundleKey) {
    for (const item of scored) {
      if (item.bundleKey === primaryBundleKey) {
        item.score += policy.ranking.primaryBundleRowBonus;
      }
    }
  }

  scored.sort(compareScoredRows);

  const selected = [];
  const selectedGraphIds = [];
  const seen = new Set();

  if (shouldPrefillPrimaryBundle({
    primaryBundleStats,
    count,
    policy,
    questionIntent,
  })) {
    for (const item of scored) {
      if (item.bundleKey !== primaryBundleKey || !item.row?.id || seen.has(item.row.id)) {
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
  }

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
  brainId,
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
        anchorEntities: anchorEntitiesForNeighbor(neighbor),
      });
      candidateIds.push(graphThoughtId);
    }
  }

  const fetchedRows = await fetchThoughtRowsByIds({
    brainId,
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
  brainId,
  queryText,
  threshold,
  count,
  filter,
  graphAssisted = false,
  graphMaxHops,
  graphNeighborLimit,
  graphDatabase = config.graph.database,
} = {}) {
  if (!brainId) {
    throw new Error("brainId is required for retrieveEvidenceRows");
  }
  const questionIntent = detectQuestionIntent(queryText);
  const signal = questionSignal(queryText);
  const retrieval = await retrieveThoughts({
    brainId,
    queryText,
    threshold,
    count,
    filter,
  });

  const graphExpansion = graphAssisted
    ? await expandThoughtsWithGraph({
      brainId,
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
      questionIntent,
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
    questionIntent,
    signal,
  });

  return {
    retrieval,
    questionIntent,
    graphExpansion: {
      ...graphExpansion.expansion,
      added_count: selected.selectedGraphIds.length,
      added_ids: selected.selectedGraphIds,
    },
    evidenceRows: selected.evidenceRows,
  };
}

export async function expandContextRows({
  brainId,
  thoughtId,
  canonicalId,
  questionText = "",
  filter,
  maxHops,
  limit,
  graphDatabase = config.graph.database,
} = {}) {
  if (!brainId) {
    throw new Error("brainId is required for expandContextRows");
  }
  const policy = loadGraphRetrievalPolicy();
  const resolvedLimit = Math.max(1, Math.min(24, Number(limit) || policy.defaultAddedRows));
  const resolvedThoughtId = resolveThoughtIdInput({ thoughtId, canonicalId });
  const seedRows = await fetchThoughtRowsByIds({
    brainId,
    ids: [resolvedThoughtId],
    filter: {},
  });

  if (seedRows.length === 0) {
    throw new Error(`Thought not found: ${resolvedThoughtId}`);
  }

  const questionIntent = detectQuestionIntent(questionText);
  const signal = questionSignal(questionText);
  const graphExpansion = await expandThoughtsWithGraph({
    brainId,
    seedRows,
    filter,
    embedding: null,
    maxHops,
    limit: resolvedLimit,
    database: graphDatabase,
  });

  const seeds = seedContext(seedRows);
  const selected = selectEvidenceRows({
    seedRows,
    graphRows: graphExpansion.rows,
    count: seedRows.length + resolvedLimit,
    policy,
    seeds,
    graphMetadataById: graphExpansion.metadataById,
    questionIntent,
    signal,
  });

  const relatedRows = selected.evidenceRows
    .filter((row) => row.id !== resolvedThoughtId)
    .slice(0, resolvedLimit);

  return {
    seedRow: seedRows[0],
    questionIntent,
    graphExpansion: {
      ...graphExpansion.expansion,
      added_count: relatedRows.length,
      added_ids: relatedRows.map((row) => row.id),
    },
    relatedRows,
    metadataById: graphExpansion.metadataById,
  };
}
