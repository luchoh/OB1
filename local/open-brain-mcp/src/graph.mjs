// Graph module — public facade (PRD docs/34, module 3).
//
// graph.mjs used to be a 2,504-line file holding the Neo4j driver, the read
// tools, the projector, the plan-building transform, and the canonical-id parse
// all at once. It has been split along its natural seams; this file is now a thin
// barrel that re-exports the public surface so existing importers
// (server.mjs / retrieval.mjs / index.mjs / graph-projector.mjs) need no change.
//
// The seams:
//   - projection-planner.mjs — the PURE row→plan transform + graph vocabulary
//     (extracted in Stage 1, the single home of all plan-building code).
//   - graph-driver.mjs       — Neo4j driver/session lifecycle, db/schema ensure,
//     healthcheck, low-level run helpers.
//   - graph-reads.mjs        — the four read tools, each scrubbed for soft-deleted
//     Thoughts by construction through one seam.
//   - graph-projection.mjs   — candidate scan, plan application onto Neo4j, the
//     projector loop, and graph-write maintenance (purge / orphan reconcile).

export { GRAPH_SCHEMA_VARIANTS } from "./projection-planner.mjs";

export {
  closeGraph,
  ensureGraphDatabaseExists,
  ensureGraphSchema,
  healthcheckGraph,
} from "./graph-driver.mjs";

export {
  graphNeighbors,
  graphThoughtNeighbors,
  sourceLineage,
  whyConnected,
} from "./graph-reads.mjs";

export {
  graphProjectionStats,
  projectThoughts,
  purgeThoughtNode,
  reconcileGraphOrphans,
  startGraphProjectorLoop,
  stopGraphProjectorLoop,
} from "./graph-projection.mjs";
