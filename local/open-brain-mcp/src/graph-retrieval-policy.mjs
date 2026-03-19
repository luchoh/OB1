import fs from "node:fs";
import path from "node:path";
import { serviceDir } from "./config.mjs";

const defaultPolicy = Object.freeze({
  version: 1,
  defaultMaxHops: 2,
  defaultAddedRows: 6,
  perSeedTraversalLimit: 64,
  allowedNodeLabels: ["Thought"],
  allowedRetrievalRoles: ["distilled"],
  ranking: {
    similarityWeight: 1000,
    seedBonus: 40,
    vectorRankPenalty: 55,
    hopPenalty: 110,
    retrievalRolePenalties: {
      distilled: 0,
      source: 120,
      unknown: 180,
    },
    anchorTypeBonuses: {
      conversation: 70,
      email: 45,
      dictation: 40,
      attachment: 10,
      document: 0,
      unknown: 0,
    },
    sameTitleBonus: 30,
    sameSourceBonus: 10,
    sameTypeBonus: 8,
    differentTypePenalty: 25,
  },
});

let cachedPath = null;
let cachedPolicy = null;

function readJson(filepath) {
  return JSON.parse(fs.readFileSync(filepath, "utf8"));
}

function normalizeStringArray(values, fallback) {
  if (!Array.isArray(values)) {
    return [...fallback];
  }

  const normalized = values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);

  return normalized.length > 0 ? normalized : [...fallback];
}

function normalizeRoleWeights(values) {
  const fallback = defaultPolicy.ranking.retrievalRolePenalties;
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return { ...fallback };
  }

  const normalized = { ...fallback };
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      normalized[key] = value;
    }
  }

  return normalized;
}

function normalizeAnchorBonuses(values) {
  const fallback = defaultPolicy.ranking.anchorTypeBonuses;
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return { ...fallback };
  }

  const normalized = { ...fallback };
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      normalized[key] = value;
    }
  }

  return normalized;
}

function normalizePolicy(raw) {
  const ranking = raw?.ranking ?? {};

  return {
    version: Number(raw?.version) || defaultPolicy.version,
    defaultMaxHops: Number(raw?.default_max_hops) || defaultPolicy.defaultMaxHops,
    defaultAddedRows: Number(raw?.default_added_rows) || defaultPolicy.defaultAddedRows,
    perSeedTraversalLimit: Number(raw?.per_seed_traversal_limit) || defaultPolicy.perSeedTraversalLimit,
    allowedNodeLabels: normalizeStringArray(raw?.allowed_node_labels, defaultPolicy.allowedNodeLabels),
    allowedRetrievalRoles: normalizeStringArray(raw?.allowed_retrieval_roles, defaultPolicy.allowedRetrievalRoles),
    ranking: {
      similarityWeight: Number(ranking.similarity_weight) || defaultPolicy.ranking.similarityWeight,
      seedBonus: Number(ranking.seed_bonus) || defaultPolicy.ranking.seedBonus,
      vectorRankPenalty: Number(ranking.vector_rank_penalty) || defaultPolicy.ranking.vectorRankPenalty,
      hopPenalty: Number(ranking.hop_penalty) || defaultPolicy.ranking.hopPenalty,
      retrievalRolePenalties: normalizeRoleWeights(ranking.retrieval_role_penalties),
      anchorTypeBonuses: normalizeAnchorBonuses(ranking.anchor_type_bonuses),
      sameTitleBonus: Number(ranking.same_title_bonus) || defaultPolicy.ranking.sameTitleBonus,
      sameSourceBonus: Number(ranking.same_source_bonus) || defaultPolicy.ranking.sameSourceBonus,
      sameTypeBonus: Number(ranking.same_type_bonus) || defaultPolicy.ranking.sameTypeBonus,
      differentTypePenalty: Number(ranking.different_type_penalty) || defaultPolicy.ranking.differentTypePenalty,
    },
  };
}

export function graphRetrievalPolicyPath() {
  return process.env.OPEN_BRAIN_GRAPH_RETRIEVAL_POLICY_PATH
    ?? path.join(serviceDir, "config", "graph-retrieval-policy.json");
}

export function loadGraphRetrievalPolicy() {
  const filepath = graphRetrievalPolicyPath();
  if (cachedPath === filepath && cachedPolicy) {
    return cachedPolicy;
  }

  let raw = {};
  if (fs.existsSync(filepath)) {
    raw = readJson(filepath);
  }

  cachedPath = filepath;
  cachedPolicy = normalizePolicy(raw);
  return cachedPolicy;
}

export function resetGraphRetrievalPolicyCache() {
  cachedPath = null;
  cachedPolicy = null;
}
