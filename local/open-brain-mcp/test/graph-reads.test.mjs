// Graph-reads egress scrub — DB-backed suite (docs/45 §8.3, runbook §10 gap).
//
// The three graph read tools (graph_neighbors / source_lineage / why_connected)
// traverse Neo4j by id and return Thought nodes from ANY brain — they are not
// brain-scoped. Under enforce, a cloud_bound caller (even an admin) must not see
// nodes that belong to a local-only brain (egress_class not in public/repo) or
// that carry a restricted tier. `fetchReadableThoughtUuids` is the Postgres
// filter the scrub uses to drop those nodes; it is the security-critical seam, so
// it is tested directly against the real dev DB. Self-skips when unreachable and
// HARD-REFUSES prod `ob1`.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const EST = "zzt-gr-est";

let query;
let closePool;
let graphReads;
let store;
let repoBrainId;
let privBrainId;
let skipReason = false;

try {
  const { config } = await import("../src/config.mjs");
  if (config.postgres?.database === "ob1") {
    skipReason = "refusing to run the graph-reads DB suite against prod database 'ob1'";
  } else {
    const db = await import("../src/db.mjs");
    query = db.query;
    closePool = db.closePool;
    await query("select 1");
    graphReads = await import("../src/graph-reads.mjs");
    store = await import("../src/thought-store.mjs");
  }
} catch (error) {
  skipReason = `dev database unreachable (run via 'direnv exec .' from the repo root): ${error.message}`;
}
if (skipReason && closePool) {
  try {
    await closePool();
  } catch {
    /* best effort */
  }
  closePool = null;
}

const ids = {};

async function insertThought({ key, brainId, tier, deleted = false }) {
  const r = await query(
    `insert into thoughts(brain_id, content, dedupe_key, sensitivity_tier, deleted_at)
       values ($1::uuid, $2, $3, $4, $5)
       returning id`,
    [brainId, `gr ${key}`, `zzt-gr-${key}`, tier, deleted ? new Date(0) : null],
  );
  ids[key] = String(r.rows[0].id).toLowerCase();
}

describe("graph-reads egress scrub (DB-backed)", { skip: skipReason }, () => {
  before(async () => {
    await query(
      `delete from thoughts where brain_id in
         (select b.id from brains b join households h on h.id = b.household_id where h.slug = $1)`,
      [EST],
    );
    await query("delete from households where slug = $1", [EST]);
    await query("insert into households(slug, display_name) values ($1, 'graph-reads test')", [EST]);
    const repo = await query(
      `insert into brains(household_id, slug, display_name, kind, egress_class)
         select id, 'zzt-gr-repo', 'repo', 'personal', 'repo' from households where slug = $1 returning id`,
      [EST],
    );
    const priv = await query(
      `insert into brains(household_id, slug, display_name, kind, egress_class)
         select id, 'zzt-gr-priv', 'priv', 'personal', 'private_local' from households where slug = $1 returning id`,
      [EST],
    );
    repoBrainId = repo.rows[0].id;
    privBrainId = priv.rows[0].id;

    await insertThought({ key: "repo-std", brainId: repoBrainId, tier: "standard" });
    await insertThought({ key: "repo-deleted", brainId: repoBrainId, tier: "standard", deleted: true });
    await insertThought({ key: "priv-std", brainId: privBrainId, tier: "standard" });
    await insertThought({ key: "priv-restr", brainId: privBrainId, tier: "restricted" });
  });

  after(async () => {
    await query(
      `delete from thoughts where brain_id in
         (select b.id from brains b join households h on h.id = b.household_id where h.slug = $1)`,
      [EST],
    );
    await query("delete from households where slug = $1", [EST]);
    if (closePool) await closePool();
  });

  it("confine=false returns every LIVE thought regardless of brain/tier (projector parity)", async () => {
    const all = new Set([ids["repo-std"], ids["repo-deleted"], ids["priv-std"], ids["priv-restr"]]);
    const readable = await graphReads.fetchReadableThoughtUuids(all, { confine: false });
    assert.equal(readable.has(ids["repo-std"]), true);
    assert.equal(readable.has(ids["priv-std"]), true, "private_local kept when not confining");
    assert.equal(readable.has(ids["priv-restr"]), true, "restricted kept when not confining");
    assert.equal(readable.has(ids["repo-deleted"]), false, "soft-deleted always dropped");
  });

  it("confine=true keeps only standard rows in public/repo brains", async () => {
    const all = new Set([ids["repo-std"], ids["repo-deleted"], ids["priv-std"], ids["priv-restr"]]);
    const readable = await graphReads.fetchReadableThoughtUuids(all, { confine: true });
    assert.equal(readable.has(ids["repo-std"]), true, "standard row in a repo brain is readable");
    assert.equal(readable.has(ids["priv-std"]), false, "standard row in a private_local brain is dropped");
    assert.equal(readable.has(ids["priv-restr"]), false, "restricted row is dropped");
    assert.equal(readable.has(ids["repo-deleted"]), false, "soft-deleted dropped");
    assert.equal(readable.size, 1, "exactly one readable node");
  });

  it("empty input short-circuits to an empty set", async () => {
    const readable = await graphReads.fetchReadableThoughtUuids(new Set(), { confine: true });
    assert.equal(readable.size, 0);
  });

  // Layer-B per-row clamp source data (server.mjs clampReadRowsByEgress feeds
  // these fields to effectiveEgress). Verify the row's tier/taint columns AND the
  // owning brain's egress_class come back keyed by lowercased id; soft-deleted and
  // absent ids are omitted (the handler treats a miss as a fail-closed drop).
  it("fetchRowEgressById returns per-row egress facts incl. brain_egress_class", async () => {
    const m = await store.fetchRowEgressById([
      ids["repo-std"],
      ids["priv-restr"],
      ids["repo-deleted"],
      "00000000-0000-0000-0000-000000000000",
    ]);
    const repo = m.get(ids["repo-std"]);
    assert.equal(repo?.brain_egress_class, "repo");
    assert.equal(repo?.sensitivity_tier, "standard");
    const priv = m.get(ids["priv-restr"]);
    assert.equal(priv?.brain_egress_class, "private_local");
    assert.equal(priv?.sensitivity_tier, "restricted");
    assert.equal(m.has(ids["repo-deleted"]), false, "soft-deleted row omitted");
    assert.equal(m.has("00000000-0000-0000-0000-000000000000"), false, "absent id omitted");
  });

  it("fetchRowEgressById on empty/blank input returns an empty map", async () => {
    assert.equal((await store.fetchRowEgressById([])).size, 0);
    assert.equal((await store.fetchRowEgressById([null, undefined])).size, 0);
  });
});
