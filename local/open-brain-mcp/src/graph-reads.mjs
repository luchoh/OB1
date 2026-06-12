// Graph reads — the four read tools and the ONE soft-delete scrub seam.
//
// One of the three modules graph.mjs split into (PRD docs/34, module 3). Every
// graph read (graph_neighbors, thought-neighbors, why_connected, source_lineage)
// is defined through `scrubbedRead`, so its result — whatever shape — passes
// `scrubSoftDeletedThoughts` exactly once before reaching a caller. That is the
// "scrubbed by construction" property the PRD asks for: the only way to export a
// read here is through the wrapper; a new read cannot forget the tombstone rule
// without going around the module's single export idiom.
//
// Why the scrub exists (docs/32 D3b, "model C"): the projector caches truncated
// Thought content (summary, preview, title) onto Neo4j nodes, and these tools
// return that cache straight from Neo4j with no deleted_at awareness. So a
// soft-deleted Thought keeps leaking via the graph reads until the projector
// removes the node (eventual). The scrub re-validates returned Thought ids
// against Postgres (the source of truth) and drops the soft-deleted ones,
// closing the convergence-window leak. Only Thought nodes are scrubbed; shared
// entity nodes (Concept/Person/Project/...) have no deleted_at.

import { config } from "./config.mjs";
import { query } from "./db.mjs";
import { graphEnabled, runGraph, serializeRecord } from "./graph-driver.mjs";
import { thoughtUuidFromCanonicalId } from "./projection-planner.mjs";

function thoughtCanonicalIdFromInput({ thoughtId, canonicalId }) {
  if (canonicalId) {
    return canonicalId;
  }
  if (thoughtId) {
    return `thought:${thoughtId}`;
  }
  throw new Error("Either thought_id or canonical_id is required");
}

function dedupeGraphItems(items) {
  const seen = new Set();
  const deduped = [];

  for (const item of items ?? []) {
    const canonicalId = item?.node?.canonical_id;
    if (!canonicalId || seen.has(canonicalId)) {
      continue;
    }
    seen.add(canonicalId);
    deduped.push(item);
  }

  return deduped;
}

// ---------------------------------------------------------------------------
// The soft-delete scrub seam (docs/32 D3b model C). `thoughtUuidFromCanonicalId`
// is the STRICT canonical-id parse imported from the planner: it returns a uuid
// only for a well-formed `thought:<uuid>` id, so an unparseable Thought id fails
// closed (treated as dead) and cannot leak. This is deliberately distinct from
// retrieval.mjs's lax `thoughtIdFromCanonicalId` (which accepts any non-empty
// suffix because `expand_context` takes raw thought ids); the two parses serve
// different callers and are kept as two named functions on purpose.
// ---------------------------------------------------------------------------

function nodeIsThought(labels, canonicalId) {
  if (Array.isArray(labels) && labels.includes("Thought")) {
    return true;
  }
  // Fall back to the canonical_id shape: relationship endpoints and path nodes
  // do not always carry labels, but a 'thought:<uuid>' id is unambiguous.
  return thoughtUuidFromCanonicalId(canonicalId) !== null;
}

// Collect every Thought uuid appearing ANYWHERE in a graph result so we can
// resolve the live set in a single Postgres round-trip.
function collectThoughtUuids(result, uuids) {
  const consider = (canonicalId, labels) => {
    if (!nodeIsThought(labels, canonicalId)) {
      return;
    }
    const uuid = thoughtUuidFromCanonicalId(canonicalId);
    if (uuid) {
      uuids.add(uuid);
    }
  };

  // center / from / to anchor nodes
  consider(result?.center?.canonical_id, result?.center_labels);
  consider(result?.from?.canonical_id, result?.from_labels);
  consider(result?.to?.canonical_id, result?.to_labels);

  // neighbors[] / lineage[] items
  for (const key of ["neighbors", "lineage"]) {
    for (const item of result?.[key] ?? []) {
      consider(item?.node?.canonical_id, item?.labels);
      for (const anchor of item?.anchors ?? []) {
        consider(anchor?.canonical_id, anchor?.labels);
      }
      for (const rel of item?.relationships ?? []) {
        consider(rel?.from, null);
        consider(rel?.to, null);
      }
    }
  }

  // why_connected paths[]
  for (const path of result?.paths ?? []) {
    for (const node of path?.nodes ?? []) {
      consider(node?.canonical_id, node?.labels);
    }
    for (const rel of path?.relationships ?? []) {
      consider(rel?.from, null);
      consider(rel?.to, null);
    }
  }
}

// Resolve which of the given Thought uuids are LIVE in Postgres (present and not
// soft-deleted). Exported because the projector's orphan reconcile (D8) resolves
// the same live set when scanning Neo4j for residue.
export async function fetchLiveThoughtUuids(uuids) {
  if (uuids.size === 0) {
    return new Set();
  }
  const { rows } = await query(
    "select id from thoughts where id = any($1::uuid[]) and deleted_at is null",
    [[...uuids]],
  );
  return new Set(rows.map((row) => String(row.id).toLowerCase()));
}

// Returns true when the given canonical_id is a Thought that is NOT live (i.e.
// soft-deleted or absent from Postgres). Non-Thought nodes are always kept.
function thoughtIsDead(canonicalId, labels, liveUuids) {
  if (!nodeIsThought(labels, canonicalId)) {
    return false;
  }
  const uuid = thoughtUuidFromCanonicalId(canonicalId);
  if (!uuid) {
    // A Thought-labeled node without a parseable uuid cannot be validated against
    // Postgres; fail closed and treat it as dead so unparseable ids cannot leak.
    return true;
  }
  return !liveUuids.has(uuid);
}

function relationshipRoutesThroughDeadThought(relationships, liveUuids) {
  for (const rel of relationships ?? []) {
    if (
      thoughtIsDead(rel?.from, null, liveUuids) ||
      thoughtIsDead(rel?.to, null, liveUuids)
    ) {
      return true;
    }
  }
  return false;
}

// Re-validate Thought nodes in a graph result against Postgres deleted_at and
// remove the dead ones. Mutates and returns a (new) sanitized result object.
async function scrubSoftDeletedThoughts(result) {
  if (!result || typeof result !== "object") {
    return result;
  }

  const uuids = new Set();
  collectThoughtUuids(result, uuids);
  if (uuids.size === 0) {
    return result;
  }

  const liveUuids = await fetchLiveThoughtUuids(uuids);

  // 1. If the queried/center thought itself is soft-deleted, the whole result is
  //    not-found. Covers graph_neighbors / source_lineage (center) and
  //    why_connected (from or to endpoint).
  if (thoughtIsDead(result.center?.canonical_id, result.center_labels, liveUuids)) {
    return { success: true, center: null, neighbors: [], lineage: [] };
  }
  if (
    thoughtIsDead(result.from?.canonical_id, result.from_labels, liveUuids) ||
    thoughtIsDead(result.to?.canonical_id, result.to_labels, liveUuids)
  ) {
    return {
      success: true,
      connected: false,
      from: thoughtIsDead(result.from?.canonical_id, result.from_labels, liveUuids)
        ? null
        : result.from,
      from_labels: result.from_labels,
      to: thoughtIsDead(result.to?.canonical_id, result.to_labels, liveUuids)
        ? null
        : result.to,
      to_labels: result.to_labels,
      paths: [],
    };
  }

  // 2. neighbors[] / lineage[]: drop items whose node is a dead Thought, or that
  //    route THROUGH a dead Thought (anchor or relationship endpoint), and trim
  //    dead-Thought anchors off the items we keep.
  for (const key of ["neighbors", "lineage"]) {
    if (!Array.isArray(result[key])) {
      continue;
    }
    result[key] = result[key].filter((item) => {
      if (thoughtIsDead(item?.node?.canonical_id, item?.labels, liveUuids)) {
        return false;
      }
      if (relationshipRoutesThroughDeadThought(item?.relationships, liveUuids)) {
        return false;
      }
      if (
        (item?.anchors ?? []).some((anchor) =>
          thoughtIsDead(anchor?.canonical_id, anchor?.labels, liveUuids),
        )
      ) {
        return false;
      }
      return true;
    });
  }

  // 3. why_connected paths[]: drop any path containing a dead Thought node or a
  //    relationship routed through one.
  if (Array.isArray(result.paths)) {
    result.paths = result.paths.filter((path) => {
      for (const node of path?.nodes ?? []) {
        if (thoughtIsDead(node?.canonical_id, node?.labels, liveUuids)) {
          return false;
        }
      }
      if (relationshipRoutesThroughDeadThought(path?.relationships, liveUuids)) {
        return false;
      }
      return true;
    });
    if (typeof result.connected === "boolean") {
      result.connected = result.paths.length > 0;
    }
  }

  return result;
}

// THE seam. Wrap a raw read producer so its resolved result passes the scrub
// exactly once. `scrubSoftDeletedThoughts` is invoked at this single call site —
// every exported read below is built with it, so reads are scrubbed by
// construction (an unscrubbed early-return inside a producer is still scrubbed
// here, harmlessly: a result with no Thought ids returns unchanged).
function scrubbedRead(produce) {
  return async (...args) => scrubSoftDeletedThoughts(await produce(...args));
}

async function fetchGraphNode(canonicalId, database = config.graph.database) {
  const result = await runGraph(
    `
      OPTIONAL MATCH (node {canonical_id: $canonicalId})
      RETURN
        CASE
          WHEN node IS NULL THEN null
          ELSE node { .* }
        END AS node,
        CASE
          WHEN node IS NULL THEN []
          ELSE labels(node)
        END AS labels
    `,
    { canonicalId },
    { database, mode: "READ" },
  );

  const row = result.records[0] ? serializeRecord(result.records[0]) : null;
  return {
    node: row?.node ?? null,
    labels: Array.isArray(row?.labels) ? row.labels : [],
  };
}

export const graphNeighbors = scrubbedRead(async function graphNeighbors({
  thoughtId,
  canonicalId,
  maxHops = 2,
  limit = 10,
  database = config.graph.database,
} = {}) {
  if (!graphEnabled()) {
    throw new Error("Graph integration is disabled");
  }

  const resolvedHops = Math.max(1, Math.min(3, Number(maxHops) || 1));
  const resolvedLimit = Math.max(1, Math.min(200, Number(limit) || 10));
  const targetId = thoughtCanonicalIdFromInput({ thoughtId, canonicalId });

  const result = await runGraph(
    `
      MATCH (center {canonical_id: $canonicalId})
      OPTIONAL MATCH p=(center)-[*1..${resolvedHops}]-(neighbor)
      WHERE neighbor.canonical_id <> center.canonical_id
      WITH
        center,
        neighbor,
        p,
        CASE
          WHEN 'Message' IN labels(neighbor) THEN 1
          ELSE 0
        END AS message_rank,
        CASE
          WHEN 'Conversation' IN labels(neighbor) THEN 0
          WHEN 'Participant' IN labels(neighbor) THEN 1
          WHEN 'AttachmentRef' IN labels(neighbor) THEN 2
          WHEN 'Concept' IN labels(neighbor) THEN 3
          WHEN 'Project' IN labels(neighbor) THEN 4
          WHEN 'Device' IN labels(neighbor) THEN 5
          WHEN 'Organization' IN labels(neighbor) THEN 6
          WHEN 'Place' IN labels(neighbor) THEN 7
          WHEN 'Property' IN labels(neighbor) THEN 8
          WHEN 'Person' IN labels(neighbor) THEN 9
          WHEN 'Thought' IN labels(neighbor) THEN 10
          WHEN 'Email' IN labels(neighbor) THEN 11
          WHEN 'Attachment' IN labels(neighbor) THEN 12
          WHEN 'Document' IN labels(neighbor) THEN 13
          WHEN 'DictationArtifact' IN labels(neighbor) THEN 14
          WHEN 'Message' IN labels(neighbor) THEN 99
          ELSE 50
        END AS label_rank
      ORDER BY
        message_rank ASC,
        CASE WHEN p IS NULL THEN 999 ELSE length(p) END ASC,
        label_rank ASC,
        coalesce(neighbor.updated_at, neighbor.created_at) DESC
      WITH center, neighbor, label_rank, collect(p)[0] AS sample_path
      WITH
        center,
        neighbor,
        label_rank,
        sample_path,
        CASE
          WHEN sample_path IS NULL THEN null
          ELSE length(sample_path)
        END AS hop_count
      ORDER BY
        CASE WHEN label_rank = 99 THEN 1 ELSE 0 END ASC,
        hop_count ASC,
        label_rank ASC,
        coalesce(neighbor.updated_at, neighbor.created_at) DESC
      LIMIT ${resolvedLimit}
      RETURN
        center { .* } as center,
        labels(center) as center_labels,
        collect(
          CASE
            WHEN neighbor IS NULL THEN null
            ELSE {
              node: neighbor { .* },
              labels: labels(neighbor),
              hop_count: hop_count,
              anchors: [pathNode in nodes(sample_path)
                WHERE pathNode.canonical_id <> center.canonical_id
                  AND pathNode.canonical_id <> neighbor.canonical_id
                | {
                  canonical_id: pathNode.canonical_id,
                  labels: labels(pathNode),
                  canonical_name: coalesce(pathNode.canonical_name, pathNode.title, null),
                  normalized_name: coalesce(pathNode.normalized_name, toLower(coalesce(pathNode.canonical_name, pathNode.title, '')))
                }
              ],
              relationships: [rel in relationships(sample_path) | {
                type: type(rel),
                from: startNode(rel).canonical_id,
                to: endNode(rel).canonical_id,
                properties: properties(rel)
              }]
            }
          END
        ) as neighbors
    `,
    {
      canonicalId: targetId,
    },
    { database, mode: "READ" },
  );

  if (result.records.length === 0) {
    return {
      success: true,
      center: null,
      neighbors: [],
    };
  }

  const row = serializeRecord(result.records[0]);
  return {
    success: true,
    center: row.center,
    center_labels: row.center_labels,
    neighbors: dedupeGraphItems((row.neighbors ?? []).filter(Boolean)),
  };
});

export const graphThoughtNeighbors = scrubbedRead(async function graphThoughtNeighbors({
  thoughtId,
  canonicalId,
  maxHops = 2,
  limit = 25,
  allowedRetrievalRoles = [],
  database = config.graph.database,
} = {}) {
  if (!graphEnabled()) {
    throw new Error("Graph integration is disabled");
  }

  const resolvedHops = Math.max(1, Math.min(3, Number(maxHops) || 1));
  const resolvedLimit = Math.max(1, Math.min(200, Number(limit) || 25));
  const targetId = thoughtCanonicalIdFromInput({ thoughtId, canonicalId });
  const filteredRoles = Array.isArray(allowedRetrievalRoles)
    ? allowedRetrievalRoles.filter((value) => typeof value === "string" && value.trim())
    : [];
  const rolePredicate = filteredRoles.length > 0
    ? "AND coalesce(neighbor.retrieval_role, 'unknown') in $allowedRetrievalRoles"
    : "";

  const result = await runGraph(
    `
      MATCH (center:Thought {canonical_id: $canonicalId})
      OPTIONAL MATCH p=(center)-[*1..${resolvedHops}]-(neighbor:Thought)
      WHERE neighbor.canonical_id <> center.canonical_id
        ${rolePredicate}
      WITH center, neighbor, p
      ORDER BY
        CASE WHEN p IS NULL THEN 999 ELSE length(p) END ASC,
        coalesce(neighbor.updated_at, neighbor.created_at) DESC
      WITH center, neighbor, collect(p)[0] AS sample_path
      WITH
        center,
        neighbor,
        sample_path,
        CASE
          WHEN sample_path IS NULL THEN null
          ELSE length(sample_path)
        END AS hop_count
      ORDER BY hop_count ASC, coalesce(neighbor.updated_at, neighbor.created_at) DESC
      LIMIT ${resolvedLimit}
      RETURN
        center { .* } as center,
        labels(center) as center_labels,
        collect(
          CASE
            WHEN neighbor IS NULL THEN null
            ELSE {
              node: neighbor { .* },
              labels: labels(neighbor),
              hop_count: hop_count,
              anchors: [pathNode in nodes(sample_path)
                WHERE pathNode.canonical_id <> center.canonical_id
                  AND pathNode.canonical_id <> neighbor.canonical_id
                | {
                  canonical_id: pathNode.canonical_id,
                  labels: labels(pathNode),
                  canonical_name: coalesce(pathNode.canonical_name, pathNode.title, null),
                  normalized_name: coalesce(pathNode.normalized_name, toLower(coalesce(pathNode.canonical_name, pathNode.title, '')))
                }
              ],
              relationships: [rel in relationships(sample_path) | {
                type: type(rel),
                from: startNode(rel).canonical_id,
                to: endNode(rel).canonical_id,
                properties: properties(rel)
              }]
            }
          END
        ) as neighbors
    `,
    {
      canonicalId: targetId,
      allowedRetrievalRoles: filteredRoles,
    },
    { database, mode: "READ" },
  );

  if (result.records.length === 0) {
    return {
      success: true,
      center: null,
      neighbors: [],
    };
  }

  const row = serializeRecord(result.records[0]);
  return {
    success: true,
    center: row.center,
    center_labels: row.center_labels,
    neighbors: dedupeGraphItems((row.neighbors ?? []).filter(Boolean)),
  };
});

export const whyConnected = scrubbedRead(async function whyConnected({
  fromThoughtId,
  fromCanonicalId,
  toThoughtId,
  toCanonicalId,
  maxHops = 4,
  limit = 3,
  database = config.graph.database,
} = {}) {
  if (!graphEnabled()) {
    throw new Error("Graph integration is disabled");
  }

  const resolvedHops = Math.max(1, Math.min(6, Number(maxHops) || 4));
  const resolvedLimit = Math.max(1, Math.min(8, Number(limit) || 3));
  const fromId = thoughtCanonicalIdFromInput({ thoughtId: fromThoughtId, canonicalId: fromCanonicalId });
  const toId = thoughtCanonicalIdFromInput({ thoughtId: toThoughtId, canonicalId: toCanonicalId });

  const [fromNode, toNode] = await Promise.all([
    fetchGraphNode(fromId, database),
    fetchGraphNode(toId, database),
  ]);

  if (!fromNode.node || !toNode.node) {
    return {
      success: true,
      connected: false,
      from: fromNode.node,
      from_labels: fromNode.labels,
      to: toNode.node,
      to_labels: toNode.labels,
      paths: [],
    };
  }

  if (fromId === toId) {
    return {
      success: true,
      connected: true,
      from: fromNode.node,
      from_labels: fromNode.labels,
      to: toNode.node,
      to_labels: toNode.labels,
      paths: [
        {
          hop_count: 0,
          nodes: [
            {
              canonical_id: fromNode.node.canonical_id,
              labels: fromNode.labels,
              properties: fromNode.node,
            },
          ],
          relationships: [],
        },
      ],
    };
  }

  const result = await runGraph(
    `
      MATCH (from {canonical_id: $fromCanonicalId})
      MATCH (to {canonical_id: $toCanonicalId})
      OPTIONAL MATCH p = allShortestPaths((from)-[*..${resolvedHops}]-(to))
      WITH from, to, p
      ORDER BY CASE WHEN p IS NULL THEN 999 ELSE length(p) END ASC
      LIMIT ${resolvedLimit}
      RETURN
        from { .* } AS from_node,
        labels(from) AS from_labels,
        to { .* } AS to_node,
        labels(to) AS to_labels,
        collect(
          CASE
            WHEN p IS NULL THEN null
            ELSE {
              hop_count: length(p),
              nodes: [node in nodes(p) | {
                canonical_id: node.canonical_id,
                labels: labels(node),
                properties: properties(node)
              }],
              relationships: [rel in relationships(p) | {
                type: type(rel),
                from: startNode(rel).canonical_id,
                to: endNode(rel).canonical_id,
                properties: properties(rel)
              }]
            }
          END
        ) AS paths
    `,
    {
      fromCanonicalId: fromId,
      toCanonicalId: toId,
    },
    { database, mode: "READ" },
  );

  if (result.records.length === 0) {
    return {
      success: true,
      connected: false,
      from: fromNode.node,
      from_labels: fromNode.labels,
      to: toNode.node,
      to_labels: toNode.labels,
      paths: [],
    };
  }

  const row = serializeRecord(result.records[0]);
  const paths = (row.paths ?? []).filter(Boolean);
  return {
    success: true,
    connected: paths.length > 0,
    from: row.from_node,
    from_labels: row.from_labels,
    to: row.to_node,
    to_labels: row.to_labels,
    paths,
  };
});

export const sourceLineage = scrubbedRead(async function sourceLineage({
  thoughtId,
  canonicalId,
  maxDepth = 4,
  limit = 12,
  database = config.graph.database,
} = {}) {
  if (!graphEnabled()) {
    throw new Error("Graph integration is disabled");
  }

  const resolvedDepth = Math.max(1, Math.min(6, Number(maxDepth) || 4));
  const resolvedLimit = Math.max(1, Math.min(50, Number(limit) || 12));
  const targetId = thoughtCanonicalIdFromInput({ thoughtId, canonicalId });

  const result = await runGraph(
    `
      MATCH (center:Thought {canonical_id: $canonicalId})
      OPTIONAL MATCH p=(center)-[:DERIVED_FROM|PART_OF|REFERENCES_SOURCE*1..${resolvedDepth}]->(source)
      WHERE source:Conversation OR source:Email OR source:Attachment OR source:Document OR source:DictationArtifact
      WITH center, p, source
      ORDER BY length(p) ASC, coalesce(source.updated_at, source.created_at) DESC
      LIMIT ${resolvedLimit}
      RETURN
        center { .* } as center,
        labels(center) as center_labels,
        collect(
          CASE
            WHEN source IS NULL THEN null
            ELSE {
              node: source { .* },
              labels: labels(source),
              hop_count: length(p),
              relationships: [rel in relationships(p) | {
                type: type(rel),
                from: startNode(rel).canonical_id,
                to: endNode(rel).canonical_id,
                properties: properties(rel)
              }]
            }
          END
        ) as lineage
    `,
    {
      canonicalId: targetId,
    },
    { database, mode: "READ" },
  );

  if (result.records.length === 0) {
    return {
      success: true,
      center: null,
      lineage: [],
    };
  }

  const row = serializeRecord(result.records[0]);
  return {
    success: true,
    center: row.center,
    center_labels: row.center_labels,
    lineage: dedupeGraphItems((row.lineage ?? []).filter(Boolean)),
  };
});
