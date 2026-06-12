// Graph projection — candidate scan, plan application, the projector loop, and
// graph-write maintenance (purge / orphan reconcile).
//
// One of the three modules graph.mjs split into (PRD docs/34, module 3). This is
// the only graph-side module that issues SQL against `thoughts` — a read-only
// candidate/stats join against `thought_graph_projection_state` (ratified
// Proposal 1: projection bookkeeping is graph-domain, so the candidate scan
// stays here rather than in the Thought store). It owns no plan-building logic:
// the row→nodes/edges transformation lives entirely in the pure
// projection-planner, which this module applies to Neo4j.

import neo4j from "neo4j-driver";
import { config } from "./config.mjs";
import { query } from "./db.mjs";
import {
  closeGraph,
  ensureGraphDatabaseExists,
  ensureGraphSchema,
  graphEnabled,
  runGraph,
  validateLabel,
  validateRelationship,
  writeGraph,
} from "./graph-driver.mjs";
import {
  canonicalThoughtId,
  normalizeGraphSchemaVariant,
  planProjection,
  PLAN_OPS,
  thoughtUuidFromCanonicalId,
} from "./projection-planner.mjs";
import { fetchLiveThoughtUuids } from "./graph-reads.mjs";

const GRAPH_PROJECTION_REVISION = "graph-projection-v4";

let projectorTimer = null;
let projectorRunning = false;

// D2.1: deleted_at is part of the revision digest so soft-delete AND restore are
// detected deterministically (not via the fragile updated_at trigger path). Adding
// this segment changes every existing thought's revision hash once -> a one-time,
// benign full re-MERGE of live nodes on the next pass. The re-MERGE is idempotent.
function projectionRevisionSql() {
  return `
    encode(
      digest(
        coalesce(t.id::text, '') || '|' ||
        coalesce(t.dedupe_key, '') || '|' ||
        coalesce(t.content_hash, '') || '|' ||
        coalesce(t.metadata::text, '') || '|' ||
        coalesce(t.updated_at::text, '') || '|' ||
        coalesce(t.deleted_at::text, '') || '|' ||
        $6::text || '|' ||
        $7::text,
        'sha256'
      ),
      'hex'
    )
  `;
}

async function fetchProjectionCandidates({
  database = config.graph.database,
  schemaVariant = config.graph.schemaVariant,
  limit = config.graph.projectorBatchSize,
  forceAll = false,
  thoughtIds = [],
  dedupeKeys = [],
} = {}) {
  const revisionSql = projectionRevisionSql();
  const result = await query(
    `
      with projected as (
        select
          t.id,
          t.brain_id,
          t.dedupe_key,
          t.content,
          t.content_hash,
          t.metadata,
          t.created_at,
          t.updated_at,
          t.deleted_at,
          ${revisionSql} as projection_revision_hash,
          gps.projection_revision_hash as projected_revision_hash,
          gps.last_projection_status
        from thoughts t
        left join thought_graph_projection_state gps
          on gps.thought_id = t.id
         and gps.brain_id = t.brain_id
         and gps.graph_database = $1
        where ($2::boolean
          or gps.thought_id is null
          or gps.projection_revision_hash is distinct from ${revisionSql}
          or gps.last_projection_status is distinct from 'projected')
          and (
            ($3::uuid[] is null and $4::text[] is null)
            or ($3::uuid[] is not null and t.id = any($3))
            or ($4::text[] is not null and t.dedupe_key = any($4))
          )
      )
      select *
      from projected
      order by updated_at asc, id asc
      limit $5
    `,
    [
      database,
      forceAll,
      thoughtIds.length ? thoughtIds : null,
      dedupeKeys.length ? dedupeKeys : null,
      limit,
      normalizeGraphSchemaVariant(schemaVariant),
      GRAPH_PROJECTION_REVISION,
    ],
  );

  return result.rows;
}

async function recordProjectionState({
  thoughtId,
  brainId,
  database,
  revisionHash,
  status,
  error = null,
}) {
  await query(
    `
      insert into thought_graph_projection_state (
        thought_id,
        brain_id,
        graph_database,
        projection_revision_hash,
        last_projected_at,
        last_projection_status,
        last_projection_error
      )
      values ($1, $2, $3, $4, now(), $5, $6)
      on conflict (thought_id, graph_database)
      do update set
        brain_id = excluded.brain_id,
        projection_revision_hash = excluded.projection_revision_hash,
        last_projected_at = excluded.last_projected_at,
        last_projection_status = excluded.last_projection_status,
        last_projection_error = excluded.last_projection_error,
        updated_at = now()
    `,
    [thoughtId, brainId, database, revisionHash, status, error],
  );
}

async function upsertNode(tx, node) {
  const label = validateLabel(node.label);
  await tx.run(
    `
      MERGE (n:${label} {canonical_id: $canonicalId})
      SET n += $properties
    `,
    {
      canonicalId: node.canonicalId,
      properties: node.properties,
    },
  );
}

async function upsertEdge(tx, edge) {
  const fromLabel = validateLabel(edge.fromLabel);
  const toLabel = validateLabel(edge.toLabel);
  const type = validateRelationship(edge.type);

  await tx.run(
    `
      MATCH (from:${fromLabel} {canonical_id: $fromId})
      MATCH (to:${toLabel} {canonical_id: $toId})
      MERGE (from)-[r:${type}]->(to)
      SET r += $properties
    `,
    {
      fromId: edge.fromId,
      toId: edge.toId,
      properties: edge.properties,
    },
  );
}

// D2.2 + D2.4: remove a soft-deleted thought's node from the graph and drop its
// projection_state row. Returns { action: 'deleted' | 'skipped' }.
async function deleteThoughtProjection(row, database) {
  // D2.4 restore-vs-projector race: re-check deleted_at immediately before the
  // write. If the row was restored mid-flight (deleted_at is now NULL), do NOT
  // delete anything — the live branch will (re-)project it on a later pass. This
  // recheck is I/O and stays in the adapter, never in the pure planner.
  const recheck = await query(
    `select deleted_at from thoughts where id = $1`,
    [row.id],
  );
  if (!recheck.rows[0] || recheck.rows[0].deleted_at === null) {
    return { action: "skipped" };
  }

  // DETACH DELETE removes the Thought node + ITS edges but leaves shared neighbour
  // nodes (Concept/Person) intact — they are shared, so that is correct.
  await writeGraph(
    (tx) =>
      tx.run("MATCH (n:Thought {canonical_id: $cid}) DETACH DELETE n", {
        cid: canonicalThoughtId(row),
      }),
    database,
  );

  // DELETE the state row (not a status flag): a lingering row keeps the
  // FROM-thoughts candidate join alive and would never re-enter the candidate set
  // after a restore. Removing it makes a restored thought re-appear (gps null).
  await query(
    `delete from thought_graph_projection_state
       where thought_id = $1 and graph_database = $2`,
    [row.id, database],
  );

  return { action: "deleted" };
}

// Apply an UPSERT plan to Neo4j in a single write transaction.
async function applyUpsertPlan(plan, database) {
  await writeGraph(async (tx) => {
    for (const node of plan.nodes) {
      await upsertNode(tx, node);
    }
    for (const edge of plan.edges) {
      await upsertEdge(tx, edge);
    }
  }, database);
}

export async function projectThoughts({
  database = config.graph.database,
  schemaVariant = config.graph.schemaVariant,
  limit = config.graph.projectorBatchSize,
  forceAll = false,
  thoughtIds = [],
  dedupeKeys = [],
  verbose = false,
} = {}) {
  if (!graphEnabled()) {
    throw new Error("Graph integration is disabled");
  }

  await ensureGraphDatabaseExists(database);
  await ensureGraphSchema(database);

  const rows = await fetchProjectionCandidates({
    database,
    schemaVariant,
    limit,
    forceAll,
    thoughtIds,
    dedupeKeys,
  });

  const summary = {
    database,
    schema_variant: normalizeGraphSchemaVariant(schemaVariant),
    fetched: rows.length,
    projected: 0,
    deleted: 0,
    skipped: 0,
    failed: 0,
    failures: [],
  };

  for (const row of rows) {
    try {
      // The planner is the sole decision of WHAT to project. A tombstone yields a
      // DELETE plan (docs/32 D2); a live/restored row yields an UPSERT plan (M4
      // restore→re-projection). schemaVariant is passed explicitly (never the
      // planner default) and projectedAt is the wall clock at write time — the
      // Stage-1 suite pins that an omitted stamp drops the edge property.
      const plan = planProjection(row, {
        schemaVariant,
        projectedAt: new Date().toISOString(),
      });

      if (plan.op === PLAN_OPS.DELETE) {
        // recordProjectionState is intentionally skipped — re-inserting a state
        // row would pin a deleted thought out of the candidate set.
        const outcome = await deleteThoughtProjection(row, database);
        if (outcome.action === "deleted") {
          summary.deleted += 1;
          if (verbose) {
            console.log(`deleted thought projection ${row.id} (${row.dedupe_key})`);
          }
        } else {
          // skipped: restored mid-flight (D2.4). The now-live row already matches
          // its prior projected state, or re-enters candidates if content changed.
          summary.skipped += 1;
          if (verbose) {
            console.log(`skipped delete (restored mid-flight) ${row.id}`);
          }
        }
        continue;
      }

      await applyUpsertPlan(plan, database);
      await recordProjectionState({
        thoughtId: row.id,
        brainId: row.brain_id,
        database,
        revisionHash: row.projection_revision_hash,
        status: "projected",
      });
      summary.projected += 1;
      if (verbose) {
        console.log(`projected thought ${row.id} (${row.dedupe_key})`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordProjectionState({
        thoughtId: row.id,
        brainId: row.brain_id,
        database,
        revisionHash: row.projection_revision_hash,
        status: "failed",
        error: message.slice(0, 2000),
      });
      summary.failed += 1;
      summary.failures.push({
        thought_id: row.id,
        dedupe_key: row.dedupe_key,
        error: message,
      });
      if (verbose) {
        console.error(`failed to project thought ${row.id}: ${message}`);
      }
    }
  }

  return summary;
}

export async function graphProjectionStats(database = config.graph.database) {
  const sql = projectionRevisionSql();
  const result = await query(
    `
      with candidate as (
        select
          t.id,
          t.brain_id,
          gps.last_projection_status,
          gps.last_projected_at,
          gps.last_projection_error,
          ${sql} as revision_hash,
          gps.projection_revision_hash
        from thoughts t
        left join thought_graph_projection_state gps
          on gps.thought_id = t.id
         and gps.brain_id = t.brain_id
         and gps.graph_database = $1
        -- M2/D3: soft-deleted thoughts are operationally hidden and are removed
        -- from Neo4j by the projector delete path. They are NOT live rows, so
        -- they must not inflate total_thought_rows / pending_rows here — a
        -- tombstone awaiting graph removal is not "pending projection" in the
        -- backlog sense this stat reports. Exclude them from the candidate set.
        where t.deleted_at is null
      )
      select
        count(*)::bigint as total_thought_rows,
        count(*) filter (
          where projection_revision_hash = revision_hash
            and last_projection_status = 'projected'
        )::bigint as projected_rows,
        count(*) filter (
          where projection_revision_hash is null
             or projection_revision_hash is distinct from revision_hash
             or last_projection_status is distinct from 'projected'
        )::bigint as pending_rows,
        count(*) filter (where last_projection_status = 'failed')::bigint as failed_rows,
        max(last_projected_at) as last_projected_at
      from candidate
    `,
    [database],
  );

  return result.rows[0] ?? null;
}

// M5 D7: DETACH DELETE a single Thought node by canonical_id. Used by the purge
// handler BEFORE the Postgres hard-delete: if Neo4j is unreachable this REJECTS
// (writeGraph propagates), the caller aborts, and the PG pointer survives. Leaves
// shared neighbour nodes (Concept/Person/...) intact — DETACH only drops the
// Thought's own edges. The targeted `database` lets a test force an outage by
// pointing at a non-existent graph database.
export async function purgeThoughtNode(canonicalId, database = config.graph.database) {
  await writeGraph(
    (tx) => tx.run("MATCH (n:Thought {canonical_id: $cid}) DETACH DELETE n", { cid: canonicalId }),
    database,
  );
}

// M5 D8: orphan reconcile. The projection_state FK cascade destroys the PG
// pointer when a thought is hard-deleted, so the worst orphans (Neo4j Thought
// node, no live PG row) can ONLY be found by scanning Neo4j. Enumerate Thought
// nodes, extract each uuid from 'thought:<uuid>', resolve the LIVE set in one PG
// round-trip (deleted_at is null), and DETACH DELETE every node whose uuid is
// absent from live (no row OR soft-deleted). Shared Concept/Person nodes are not
// Thought-labeled and are never touched.
//
// The scan paginates with SKIP/LIMIT (batchSize per round) and reads the ENTIRE
// graph by default — a no-arg call performs a COMPLETE one-time sweep rather than
// silently truncating at the first batch. The read phase deletes nothing, so SKIP
// stays stable; orphans are removed only after the full set is resolved against PG.
export async function reconcileGraphOrphans({
  database = config.graph.database,
  batchSize = 1000,
} = {}) {
  if (!graphEnabled()) {
    throw new Error("Graph integration is disabled");
  }

  await ensureGraphDatabaseExists(database);

  const scanned = [];
  const uuidByCid = new Map();
  for (let skip = 0; ; skip += batchSize) {
    const scanResult = await runGraph(
      "MATCH (n:Thought) RETURN n.canonical_id AS cid ORDER BY n.canonical_id SKIP $skip LIMIT $limit",
      { skip: neo4j.int(skip), limit: neo4j.int(batchSize) },
      { database, mode: "READ" },
    );
    for (const record of scanResult.records) {
      const cid = record.get("cid");
      if (typeof cid !== "string") {
        continue;
      }
      scanned.push(cid);
      const uuid = thoughtUuidFromCanonicalId(cid);
      if (uuid) {
        uuidByCid.set(cid, uuid);
      }
    }
    if (scanResult.records.length < batchSize) {
      break;
    }
  }

  // Resolve the live set: a thought is live iff it has a PG row with deleted_at
  // null. Absent rows and soft-deleted rows are both orphans in the graph.
  const liveUuids = await fetchLiveThoughtUuids(new Set(uuidByCid.values()));

  const removed = [];
  for (const cid of scanned) {
    const uuid = uuidByCid.get(cid);
    // A node whose canonical_id has no parseable uuid cannot be a live thought;
    // fail closed and remove it (graph residue from a malformed projection).
    if (uuid && liveUuids.has(uuid)) {
      continue;
    }
    await purgeThoughtNode(cid, database);
    removed.push(cid);
  }

  return {
    scanned: scanned.length,
    orphansRemoved: removed.length,
    removed,
  };
}

export function startGraphProjectorLoop() {
  if (!graphEnabled() || config.graph.projectorIntervalSeconds <= 0 || projectorTimer) {
    return;
  }

  const tick = async () => {
    if (projectorRunning) {
      return;
    }
    projectorRunning = true;
    try {
      await projectThoughts({
        database: config.graph.database,
        schemaVariant: config.graph.schemaVariant,
        limit: config.graph.projectorBatchSize,
      });
    } catch (error) {
      console.error(
        `graph projector tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      projectorRunning = false;
    }
  };

  void tick();
  projectorTimer = setInterval(() => {
    void tick();
  }, config.graph.projectorIntervalSeconds * 1000);
}

export async function stopGraphProjectorLoop() {
  if (projectorTimer) {
    clearInterval(projectorTimer);
    projectorTimer = null;
  }
  await closeGraph();
}
