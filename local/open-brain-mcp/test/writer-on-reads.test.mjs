// The writer is surfaced on the read plane — DB-backed, because the behaviour is
// a join in the query rather than anything a mock could demonstrate.
//
// Why this exists: the caged agent is being given write access to the operator's
// personal brain. Attribution was already recorded on every write, but no read
// path returned it, so an agent's notes and the operator's own were
// indistinguishable in his own search results. The database knew; no reader ever
// found out.
//
// The writer is joined on rather than added to the ranked-read functions'
// return shape: changing that shape means DROPping and recreating all five
// (Postgres refuses to replace a function whose return type changed), which is
// ~360 lines of function body reproduced by hand for a column the caller can
// reach through the `id` those functions already return.
//
// NULL is a first-class expected value, not a gap. Everything captured before
// writer attribution existed, and anything written through the legacy shared
// key, genuinely has no recorded writer — and "we do not know" must not be
// presented as "yours".

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const RUN = crypto.randomBytes(4).toString("hex");
const EST = `zzt-writer-reads-est-${RUN}`;
const BRAIN = `zzt-writer-reads-brain-${RUN}`;
const AGENT = `zzt-pi-personal-${RUN}`;

const EMB = Array(1536).fill(0);
EMB[0] = 1;

const ACTOR = { auth_source: "service_key", principal_id: null, is_admin: false };

let query;
let closePool;
let store;
let retrieval;
let skipReason = false;

try {
  const { config } = await import("../src/config.mjs");
  if (config.postgres?.database === "ob1") {
    skipReason = "refusing to run the writer-on-reads DB suite against prod database 'ob1'";
  } else {
    const db = await import("../src/db.mjs");
    query = db.query;
    closePool = db.closePool;
    await query("select 1");
    store = await import("../src/thought-store.mjs");
    retrieval = await import("../src/retrieval.mjs");
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

describe("the writer is visible on the read plane (DB-backed)", { skip: skipReason }, () => {
  let brainId;
  let agentPrincipalId;

  before(async () => {
    await query(
      "insert into households (slug, display_name) values ($1, 'zzt writer reads') on conflict (slug) do nothing",
      [EST],
    );
    brainId = (await query(
      `insert into brains (household_id, slug, display_name, kind, egress_class, is_default_shared)
       select id, $2, 'zzt writer reads', 'repo', 'repo', false from households where slug = $1
       returning id`,
      [EST, BRAIN],
    )).rows[0].id;
    agentPrincipalId = (await query(
      `insert into brain_principals (household_id, slug, display_name, principal_type)
       select id, $2, 'zzt caged agent', 'caged_agent' from households where slug = $1
       returning id`,
      [EST, AGENT],
    )).rows[0].id;

    await store.captureThought({
      brainId, content: "a note the agent wrote", embedding: EMB,
      embeddingModel: "zzt-test-model", metadata: {}, dedupeKey: `zzt-attributed-${RUN}`,
      actor: ACTOR, writtenByPrincipalId: agentPrincipalId,
    });
    await store.captureThought({
      brainId, content: "a note with no recorded writer", embedding: EMB,
      embeddingModel: "zzt-test-model", metadata: {}, dedupeKey: `zzt-unattributed-${RUN}`,
      actor: ACTOR,
    });
  });

  after(async () => {
    await query("delete from thoughts where brain_id = $1::uuid", [brainId]);
    await query("delete from brain_principals where id = $1::uuid", [agentPrincipalId]);
    await query("delete from brains where id = $1::uuid", [brainId]);
    await query("delete from households where slug = $1", [EST]);
    if (closePool) {
      await closePool();
    }
  });

  const byContent = (rows, needle) => rows.find((r) => r.content.includes(needle));

  async function search(opts = {}) {
    const out = await retrieval.retrieveThoughts({
      brainId, embedding: EMB, threshold: 0.0, count: 10, filter: {}, ...opts,
    });
    return Array.isArray(out) ? out : (out.results ?? out.matches ?? out.thoughts ?? []);
  }

  it("names the writer on a search result, by slug rather than uuid", async () => {
    const rows = await search();
    const mine = byContent(rows, "the agent wrote");
    assert.ok(mine, "the attributed thought should be retrievable");
    assert.equal(mine.written_by, AGENT,
      "a reader must be able to see WHO wrote it at a glance; a uuid would not tell them");
  });

  it("reports an unrecorded writer as null, not as the reader's own", async () => {
    const rows = await search();
    const theirs = byContent(rows, "no recorded writer");
    assert.ok(theirs);
    assert.equal(theirs.written_by, null,
      "pre-attribution and legacy-key rows have no writer; unknown must not read as yours");
  });

  it("surfaces the writer on the recency-ranked path too", async () => {
    // A different ranked-read function with a different return shape — the join
    // has to be applied at both call sites, and forgetting one is the obvious
    // way for this to half-work.
    const rows = await search({ recencyWeight: 0.5 });
    const mine = byContent(rows, "the agent wrote");
    assert.ok(mine, "the attributed thought should be retrievable on the recency path");
    assert.equal(mine.written_by, AGENT);
  });
});
