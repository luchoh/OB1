// mint/rotate for BOTH credential families, against the real database.
//
// The pure suite (agent-key-minting.test.mjs) covers the capability gate and slug
// validation. What cannot be tested without Postgres is the shape docs/adr/0006
// settled on: the two families are DISJOINT.
//
//   repo-service:<slug>  editor on repo:<slug>       — claude, codex AND pi
//   pi-common:<slug>     editor on the shared brain  — pi only
//
// So the assertions that matter here are about reach, not about rows: minting the
// agent key must not widen pi onto the repo brain, and rotating it must not take
// down the repo key — which pi now presents too, so revoking it would cut off
// claude and codex as well. The (principal, credential_type) scoping of every
// guard is still exercised, because 0.8.0 rows that put an agent key ON the repo
// brain can survive in a live database and must not clobber the repo family.
//
// Self-skips with an explicit reason when the dev database is unreachable, and
// HARD-REFUSES to run against prod `ob1`. Fixtures are `zzt-`-prefixed households
// and are torn down (every table here cascades from households).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// Fixture names are unique per process: several agents run `npm test` against
// the same dev database at once, and a shared fixture slug means one run's setup
// deletes another run's rows mid-transaction (FK violations, then a deadlock on
// teardown). Every name below is DNS-safe, because the repo slugs become brain
// slugs.
const RUN = crypto.randomBytes(4).toString("hex");
const EST = `zzt-mint-est-${RUN}`;
const BARE_EST = `zzt-mint-bare-est-${RUN}`;
const SHARED_BRAIN_SLUG = `zzt-mint-shared-${RUN}`;

// Per-test repo slugs, so a leaked row from one test cannot be mistaken for
// another test's fixture.
const repo = (name) => `zzt-${name}-${RUN}`;

let query;
let closePool;
let minting;
let skipReason = false;

try {
  const { config } = await import("../src/config.mjs");
  if (config.postgres?.database === "ob1") {
    skipReason = "refusing to run the minting DB suite against prod database 'ob1'";
  } else {
    const db = await import("../src/db.mjs");
    query = db.query;
    closePool = db.closePool;
    await query("select 1");
    const columns = await query(
      `select count(*)::int as n from information_schema.columns
       where table_name = 'brains' and column_name = 'is_shared_agent_brain'`,
    );
    if (columns.rows[0].n < 1) {
      skipReason = "migration 020 is not applied to this database (no brains.is_shared_agent_brain)";
    } else {
      minting = await import("../src/repo-key-minting.mjs");
    }
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

const agentHandlersMissing = !skipReason
  && !(typeof minting.handleMintAgentKey === "function" && typeof minting.handleRotateAgentKey === "function");

// Read the namespace off the module rather than hard-coding it: the prefix moved
// once already (pi: -> pi-common:) and the assertions below are about reach, not
// about spelling. The pure suite is what pins the prefixes apart.
const AGENT_PREFIX = skipReason ? null : minting.__testables?.AGENT_PRINCIPAL_SLUG_PREFIX;
const REPO_PRINCIPAL_PREFIX = skipReason ? null : minting.__testables?.PRINCIPAL_SLUG_PREFIX;

describe("repo + agent key minting (DB-backed)", { skip: skipReason }, () => {
  let householdId;
  let bareHouseholdId;
  let sharedBrainId;
  let minterKeyId;
  let ctx;
  let bareCtx;

  // Keys on a repo brain. After ADR-0006 the agent key is NOT one of them, which
  // is precisely what several tests below assert.
  async function keysOnRepoBrain(repoSlug) {
    const r = await query(
      `select k.id, k.credential_type, k.is_active, k.is_admin, k.can_mint_repo_keys,
              k.read_egress_class, k.brain_id, p.slug as principal_slug, p.principal_type
       from brain_access_keys k
       join brain_principals p on p.id = k.principal_id
       join brains b on b.id = k.brain_id
       where b.household_id = $1::uuid and b.slug = $2
       order by k.created_at asc, k.id asc`,
      [householdId, `repo:${repoSlug}`],
    );
    return r.rows;
  }

  // The agent family is found by PRINCIPAL now, because its keys hang off the
  // shared brain rather than off the repo brain.
  async function keysForPrincipalSlug(principalSlug) {
    const r = await query(
      `select k.id, k.credential_type, k.is_active, k.is_admin, k.can_mint_repo_keys,
              k.read_egress_class, k.brain_id
       from brain_access_keys k
       join brain_principals p on p.id = k.principal_id
       where p.household_id = $1::uuid and p.slug = $2
       order by k.created_at asc, k.id asc`,
      [householdId, principalSlug],
    );
    return r.rows;
  }

  async function principalIdFor(slug, household = householdId) {
    const r = await query(
      "select id from brain_principals where household_id = $1::uuid and slug = $2",
      [household, slug],
    );
    return r.rowCount === 0 ? null : r.rows[0].id;
  }

  async function membershipBrainSlugs(principalId) {
    const r = await query(
      `select b.slug from brain_memberships m join brains b on b.id = m.brain_id
       where m.principal_id = $1::uuid order by b.slug`,
      [principalId],
    );
    return r.rows.map((row) => row.slug);
  }

  before(async () => {
    for (const slug of [EST, BARE_EST]) {
      await query("delete from households where slug = $1", [slug]);
    }
    const h = await query(
      "insert into households(slug, display_name) values ($1, 'mint test') returning id",
      [EST],
    );
    householdId = h.rows[0].id;
    const bare = await query(
      "insert into households(slug, display_name) values ($1, 'mint test, no shared brain') returning id",
      [BARE_EST],
    );
    bareHouseholdId = bare.rows[0].id;

    const shared = await query(
      `insert into brains(household_id, slug, display_name, kind, egress_class, is_shared_agent_brain)
       values ($1::uuid, $2, 'common-public', 'repo', 'repo', true)
       returning id`,
      [householdId, SHARED_BRAIN_SLUG],
    );
    sharedBrainId = shared.rows[0].id;

    // The minting key itself: brain-less, on its own principal. Present so the
    // rotations below can be checked for collateral damage to the authority that
    // issued the credentials.
    const minterPrincipal = await query(
      `insert into brain_principals(household_id, slug, display_name, principal_type)
       values ($1::uuid, $2, 'zzt minter', 'repo_service') returning id`,
      [householdId, `zzt-minter-${RUN}`],
    );
    const minterKey = await query(
      `insert into brain_access_keys(principal_id, brain_id, key_hash, label, credential_type, can_mint_repo_keys)
       values ($1::uuid, null, $2, 'zzt minter key', 'repo_key', true) returning id`,
      [minterPrincipal.rows[0].id, `zzt-${crypto.randomBytes(16).toString("hex")}`],
    );
    minterKeyId = minterKey.rows[0].id;

    ctx = { householdId, principalId: minterPrincipal.rows[0].id, _policy: { caller: { canMintRepoKeys: true } } };
    bareCtx = { householdId: bareHouseholdId, principalId: null, _policy: { caller: { canMintRepoKeys: true } } };
  });

  after(async () => {
    for (const slug of [EST, BARE_EST]) {
      await query("delete from households where slug = $1", [slug]);
    }
    if (closePool) await closePool();
  });

  // --- what each family provisions ----------------------------------------

  it("mint_repo_key creates the repo brain and a repo-service principal confined to it", async () => {
    const result = await minting.handleMintRepoKey({ repo_slug: repo("a") }, ctx);
    assert.match(result.key, /^[0-9a-f]{64}$/, "the plaintext is a fresh 32-byte hex secret");
    assert.equal(result.brain_slug, `repo:${repo("a")}`);

    const brain = await query("select kind, egress_class, is_shared_agent_brain from brains where id = $1::uuid", [result.brain_id]);
    assert.equal(brain.rows[0].kind, "repo");
    assert.equal(brain.rows[0].egress_class, "repo", "born cloud-readable (docs/45): a repo key is cloud_bound");
    assert.equal(brain.rows[0].is_shared_agent_brain, false);

    const keys = await keysOnRepoBrain(repo("a"));
    assert.equal(keys.length, 1);
    assert.equal(keys[0].credential_type, "repo_key");
    assert.equal(keys[0].principal_type, "repo_service");
    assert.equal(keys[0].principal_slug, `${REPO_PRINCIPAL_PREFIX}${repo("a")}`);
    assert.equal(keys[0].is_admin, false, "a minted key is never admin");
    assert.equal(keys[0].can_mint_repo_keys, false, "a minted key can never mint");
    assert.equal(keys[0].read_egress_class, null, "null => cloud_bound (fail-closed)");

    // pi presents this key too (ADR-0006), so this one membership is the whole
    // repo-brain reach of all three harnesses.
    assert.deepEqual(await membershipBrainSlugs(result.principal_id), [`repo:${repo("a")}`], "the repo principal reaches ONE brain");
  });

  it("mint_agent_key gives pi a SECOND principal that reaches the shared brain and NOTHING else", { skip: agentHandlersMissing }, async () => {
    const result = await minting.handleMintAgentKey({ repo_slug: repo("a") }, ctx);
    assert.match(result.key, /^[0-9a-f]{64}$/);
    assert.equal(result.principal_slug, `${AGENT_PREFIX}${repo("a")}`);
    assert.equal(result.shared_brain_id, sharedBrainId);
    assert.equal(result.shared_brain_egress_class, "repo", "surfaced so the operator can see the agent can actually read it");

    const principal = await query("select principal_type from brain_principals where id = $1::uuid", [result.principal_id]);
    assert.equal(principal.rows[0].principal_type, "caged_agent");

    // THE ADR-0006 INVARIANT. A second membership here is the 0.8.0 shape coming
    // back, and it would mean pi-authored repo rows carry a distinct identity the
    // operator decided not to pay for — and, worse, that the agent credential is
    // a superset of the repo credential rather than a disjoint one.
    assert.deepEqual(
      await membershipBrainSlugs(result.principal_id),
      [SHARED_BRAIN_SLUG],
      "the estate-wide shared brain, and nothing else",
    );

    const agentKeys = await keysForPrincipalSlug(result.principal_slug);
    assert.equal(agentKeys.length, 1);
    assert.equal(agentKeys[0].credential_type, "agent_key", "the agent credential is typed agent_key, not repo_key");
    assert.equal(agentKeys[0].brain_id, sharedBrainId, "the default-brain hint points at the only brain it reaches");
    assert.equal(agentKeys[0].is_admin, false);
    assert.equal(agentKeys[0].can_mint_repo_keys, false);
    assert.equal(agentKeys[0].read_egress_class, null);

    // The repo brain is untouched by an agent mint: still exactly the one repo
    // key, still exactly the repo principal's one membership.
    const onRepoBrain = await keysOnRepoBrain(repo("a"));
    assert.deepEqual(onRepoBrain.map((k) => k.credential_type), ["repo_key"], "no credential was issued against the repo brain");
    assert.deepEqual(
      await membershipBrainSlugs(await principalIdFor(`${REPO_PRINCIPAL_PREFIX}${repo("a")}`)),
      [`repo:${repo("a")}`],
      "minting the agent key did not widen the harness principal",
    );
  });

  it("the two families are disjoint: neither principal can reach the other's brain", { skip: agentHandlersMissing }, async () => {
    const repoReach = await membershipBrainSlugs(await principalIdFor(`${REPO_PRINCIPAL_PREFIX}${repo("a")}`));
    const agentReach = await membershipBrainSlugs(await principalIdFor(`${AGENT_PREFIX}${repo("a")}`));
    assert.deepEqual(repoReach.filter((slug) => agentReach.includes(slug)), [], "no brain is reachable by both principals");
    // Stated the other way round so a future widening of either side trips it:
    // the union is exactly one repo brain plus the one shared brain.
    assert.deepEqual([...repoReach, ...agentReach].sort(), [SHARED_BRAIN_SLUG, `repo:${repo("a")}`].sort());
  });

  it("per-repo common principals are distinct and share the ONE shared brain", { skip: agentHandlersMissing }, async () => {
    for (const name of ["m", "n"]) {
      await minting.handleMintRepoKey({ repo_slug: repo(name) }, ctx);
      await minting.handleMintAgentKey({ repo_slug: repo(name) }, ctx);
    }
    const m = await principalIdFor(`${AGENT_PREFIX}${repo("m")}`);
    const n = await principalIdFor(`${AGENT_PREFIX}${repo("n")}`);
    assert.notEqual(m, n, "per-repo, so one cage can be revoked without killing the others");
    assert.deepEqual(await membershipBrainSlugs(m), [SHARED_BRAIN_SLUG]);
    assert.deepEqual(await membershipBrainSlugs(n), [SHARED_BRAIN_SLUG]);

    // Revocation granularity is the whole point of per-repo principals.
    await minting.handleRotateAgentKey({ repo_slug: repo("m") }, ctx);
    const live = (await keysForPrincipalSlug(`${AGENT_PREFIX}${repo("n")}`)).filter((k) => k.is_active);
    assert.equal(live.length, 1, "burning one repo's cage credential leaves the others alone");
  });

  // --- the narrowed guards -------------------------------------------------
  //
  // 0.8.0 issued agent keys ON the repo brain. Those rows can still exist in a
  // live database, so the repo-family guards must stay scoped by principal and
  // credential_type rather than by brain.

  it("a surviving 0.8.0 agent key on the repo brain does not block mint_repo_key", { skip: agentHandlersMissing }, async () => {
    await minting.handleMintRepoKey({ repo_slug: repo("b") }, ctx);
    await minting.handleMintAgentKey({ repo_slug: repo("b") }, ctx);
    const agentPrincipalId = await principalIdFor(`${AGENT_PREFIX}${repo("b")}`);
    const repoBrainId = (await query(
      "select id from brains where household_id = $1::uuid and slug = $2",
      [householdId, `repo:${repo("b")}`],
    )).rows[0].id;

    // The 0.8.0 shape, forged by hand: an agent key whose brain_id is the repo
    // brain. Nothing mints this any more; the point is that it is survivable.
    const legacy = await query(
      `insert into brain_access_keys(principal_id, brain_id, key_hash, label, credential_type)
       values ($1::uuid, $2::uuid, $3, 'zzt 0.8.0 agent key', 'agent_key') returning id`,
      [agentPrincipalId, repoBrainId, `zzt-${crypto.randomBytes(16).toString("hex")}`],
    );

    // The repo key is lost / revoked by hand; the legacy agent key stays live.
    await query(
      `update brain_access_keys set is_active = false
       where credential_type = 'repo_key' and brain_id = $1::uuid`,
      [repoBrainId],
    );

    const reminted = await minting.handleMintRepoKey({ repo_slug: repo("b") }, ctx);
    assert.match(reminted.key, /^[0-9a-f]{64}$/, "a brain-wide guard would 409 here and strand the repo");

    const live = (await keysOnRepoBrain(repo("b"))).filter((k) => k.is_active);
    assert.deepEqual(live.map((k) => k.credential_type).sort(), ["agent_key", "repo_key"]);

    // ... and rotating the repo key must not sweep the legacy row up with it.
    const rotated = await minting.handleRotateRepoKey({ repo_slug: repo("b") }, ctx);
    assert.equal(rotated.revoked_key_count, 1, "exactly the repo family's one live key");
    const legacyAfter = await query("select is_active from brain_access_keys where id = $1::uuid", [legacy.rows[0].id]);
    assert.equal(legacyAfter.rows[0].is_active, true, "a brain-wide revoke would have taken pi offline");
  });

  it("mint_repo_key is still create-only for its OWN family", async () => {
    await minting.handleMintRepoKey({ repo_slug: repo("c") }, ctx);
    await assert.rejects(
      () => minting.handleMintRepoKey({ repo_slug: repo("c") }, ctx),
      (e) => e.status === 409 && /rotate_repo_key/.test(e.message),
      "a second live repo key would make revoking one revoke nothing",
    );
    assert.equal((await keysOnRepoBrain(repo("c"))).filter((k) => k.is_active).length, 1);
  });

  it("mint_agent_key is create-only for its OWN family", { skip: agentHandlersMissing }, async () => {
    await minting.handleMintRepoKey({ repo_slug: repo("d") }, ctx);
    await minting.handleMintAgentKey({ repo_slug: repo("d") }, ctx);
    await assert.rejects(
      () => minting.handleMintAgentKey({ repo_slug: repo("d") }, ctx),
      (e) => e.status === 409 && /rotate_agent_key/.test(e.message),
    );
    const live = (await keysForPrincipalSlug(`${AGENT_PREFIX}${repo("d")}`)).filter((k) => k.is_active);
    assert.equal(live.length, 1);
  });

  it("rotate_repo_key leaves pi's common key alone", { skip: agentHandlersMissing }, async () => {
    await minting.handleMintRepoKey({ repo_slug: repo("e") }, ctx);
    const agent = await minting.handleMintAgentKey({ repo_slug: repo("e") }, ctx);

    const rotated = await minting.handleRotateRepoKey({ repo_slug: repo("e") }, ctx);
    assert.equal(rotated.revoked_key_count, 1, "exactly one credential was revoked");

    const agentKeys = await keysForPrincipalSlug(agent.principal_slug);
    assert.deepEqual(agentKeys.map((k) => k.is_active), [true], "rotating the harness key must not cut pi off the shared brain");
    assert.equal((await keysOnRepoBrain(repo("e"))).filter((k) => k.credential_type === "repo_key" && k.is_active).length, 1);
  });

  it("rotate_agent_key revokes ONLY the common key — the repo key survives", { skip: agentHandlersMissing }, async () => {
    await minting.handleMintRepoKey({ repo_slug: repo("f") }, ctx);
    await minting.handleMintAgentKey({ repo_slug: repo("f") }, ctx);
    const repoKeyId = (await keysOnRepoBrain(repo("f"))).find((k) => k.credential_type === "repo_key").id;

    const rotated = await minting.handleRotateAgentKey({ repo_slug: repo("f") }, ctx);
    assert.equal(rotated.revoked_key_count, 1);
    assert.match(rotated.key, /^[0-9a-f]{64}$/);
    assert.equal(rotated.shared_brain_id, sharedBrainId);

    const after = await query("select is_active from brain_access_keys where id = $1::uuid", [repoKeyId]);
    assert.equal(after.rows[0].is_active, true, "pi presents the repo key too — burning its common key is not a repo outage for anyone");

    const live = (await keysForPrincipalSlug(`${AGENT_PREFIX}${repo("f")}`)).filter((k) => k.is_active);
    assert.equal(live.length, 1);
    assert.equal(live[0].brain_id, sharedBrainId);

    // A replacement must not quietly widen: reach after a rotation is the reach
    // the principal was minted with.
    assert.deepEqual(await membershipBrainSlugs(rotated.principal_id), [SHARED_BRAIN_SLUG]);
  });

  it("no rotation ever touches the minting authority's own key", async () => {
    const r = await query("select is_active from brain_access_keys where id = $1::uuid", [minterKeyId]);
    assert.equal(r.rows[0].is_active, true, "the minter has brain_id null and its own principal");
  });

  // --- refusals ------------------------------------------------------------

  it("mint_agent_key refuses a repo whose brain does not exist (typo guard)", { skip: agentHandlersMissing }, async () => {
    await assert.rejects(
      () => minting.handleMintAgentKey({ repo_slug: repo("never-minted") }, ctx),
      (e) => e.status === 404 && /mint_repo_key/.test(e.message),
      "a fat-fingered slug would otherwise mint a live key no cage will ever present",
    );
    const brains = await query(
      "select 1 from brains where household_id = $1::uuid and slug = $2",
      [householdId, `repo:${repo("never-minted")}`],
    );
    assert.equal(brains.rowCount, 0, "the typo guard must not create the brain it was checking for");
    assert.equal(await principalIdFor(`${AGENT_PREFIX}${repo("never-minted")}`), null, "and no principal either");
  });

  it("rotate_agent_key refuses when the agent principal does not exist", { skip: agentHandlersMissing }, async () => {
    await minting.handleMintRepoKey({ repo_slug: repo("g") }, ctx);
    await assert.rejects(
      () => minting.handleRotateAgentKey({ repo_slug: repo("g") }, ctx),
      (e) => e.status === 404 && /mint_agent_key/.test(e.message),
      "rotation replaces a credential; it must never mint the first one",
    );
  });

  it("mint_agent_key refuses when the estate has no shared agent brain", { skip: agentHandlersMissing }, async () => {
    await minting.handleMintRepoKey({ repo_slug: repo("h") }, bareCtx);
    await assert.rejects(
      () => minting.handleMintAgentKey({ repo_slug: repo("h") }, bareCtx),
      (e) => e.status === 409 && /is_shared_agent_brain/.test(e.message),
      "the shared write surface for an injection-exposed agent is a human decision",
    );
    assert.equal(
      await principalIdFor(`${AGENT_PREFIX}${repo("h")}`, bareHouseholdId),
      null,
      "the refused mint rolled back the principal it had created",
    );
  });

  it("neither family will touch a brain that is not a repo brain", { skip: agentHandlersMissing }, async () => {
    await query(
      `insert into brains(household_id, slug, display_name, kind, egress_class)
       values ($1::uuid, $2, 'decoy', 'personal', 'private_local')`,
      [householdId, `repo:${repo("decoy")}`],
    );
    for (const handler of [minting.handleMintRepoKey, minting.handleMintAgentKey, minting.handleRotateRepoKey, minting.handleRotateAgentKey]) {
      await assert.rejects(
        () => handler({ repo_slug: repo("decoy") }, ctx),
        (e) => e.status === 409 && /refusing to touch it/.test(e.message),
      );
    }
    const keys = await query(
      `select 1 from brain_access_keys k join brains b on b.id = k.brain_id
       where b.household_id = $1::uuid and b.slug = $2`,
      [householdId, `repo:${repo("decoy")}`],
    );
    assert.equal(keys.rowCount, 0, "no credential was issued against the decoy brain");
  });

  it("a common principal that has gained reach outside its scope is never re-issued a key", { skip: agentHandlersMissing }, async () => {
    await minting.handleMintRepoKey({ repo_slug: repo("i") }, ctx);
    const agent = await minting.handleMintAgentKey({ repo_slug: repo("i") }, ctx);

    // Someone widens pi's common principal by hand, onto another repo's brain.
    const other = await minting.handleMintRepoKey({ repo_slug: repo("j") }, ctx);
    await query(
      "insert into brain_memberships(principal_id, brain_id, role) values ($1::uuid, $2::uuid, 'editor')",
      [agent.principal_id, other.brain_id],
    );

    await assert.rejects(
      () => minting.handleRotateAgentKey({ repo_slug: repo("i") }, ctx),
      (e) => e.status === 409 && /outside this credential's scope/.test(e.message),
      "a fresh key must not silently inherit reach the principal was not minted with",
    );
  });

  it("a 0.8.0 common principal still holding its OWN repo brain is refused, not re-issued", { skip: agentHandlersMissing }, async () => {
    await minting.handleMintRepoKey({ repo_slug: repo("o") }, ctx);
    const agent = await minting.handleMintAgentKey({ repo_slug: repo("o") }, ctx);
    const repoBrainId = (await query(
      "select id from brains where household_id = $1::uuid and slug = $2",
      [householdId, `repo:${repo("o")}`],
    )).rows[0].id;

    // The 0.8.0 second membership. Under ADR-0006 the repo brain is out of scope
    // for this principal, so the guard must treat it exactly like any other
    // foreign brain — a re-mint that tolerated it would restore the old shape.
    await query(
      "insert into brain_memberships(principal_id, brain_id, role) values ($1::uuid, $2::uuid, 'editor')",
      [agent.principal_id, repoBrainId],
    );

    await assert.rejects(
      () => minting.handleRotateAgentKey({ repo_slug: repo("o") }, ctx),
      (e) => e.status === 409 && /outside this credential's scope/.test(e.message),
      "the operator has to clean the legacy membership up by hand; it is not silently re-blessed",
    );
  });

  it("mint_agent_key refuses to adopt a principal of another type", { skip: agentHandlersMissing }, async () => {
    await minting.handleMintRepoKey({ repo_slug: repo("k") }, ctx);
    await query(
      `insert into brain_principals(household_id, slug, display_name, principal_type)
       values ($1::uuid, $2, 'squatter', 'person')`,
      [householdId, `${AGENT_PREFIX}${repo("k")}`],
    );
    await assert.rejects(
      () => minting.handleMintAgentKey({ repo_slug: repo("k") }, ctx),
      (e) => e.status === 409 && /not a 'caged_agent'/.test(e.message),
      "adopting a stranger's principal would issue a key carrying that principal's whole membership set",
    );
  });

  it("a mint in one estate cannot reach another estate's brain of the same name", async () => {
    await minting.handleMintRepoKey({ repo_slug: repo("l") }, ctx);
    const mine = await query(
      "select id from brains where household_id = $1::uuid and slug = $2",
      [householdId, `repo:${repo("l")}`],
    );
    const theirs = await minting.handleMintRepoKey({ repo_slug: repo("l") }, bareCtx);
    assert.notEqual(theirs.brain_id, mine.rows[0].id, "same slug, different estate, different brain");
  });
});
