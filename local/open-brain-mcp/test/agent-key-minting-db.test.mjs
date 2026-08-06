// mint/rotate for BOTH credential families, against the real database.
//
// The pure suite (agent-key-minting.test.mjs) covers the capability gate and slug
// validation. What cannot be tested without Postgres is the thing this slice
// actually changed: two credential families now hold keys on the SAME repo brain,
// so every "already has an active key" check and every revoke had to narrow from
// brain-wide to (principal, credential_type). A brain-wide guard is not a
// cosmetic bug — it makes provisioning order unrecoverable and makes rotating one
// family silently take the other offline.
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

describe("repo + agent key minting (DB-backed)", { skip: skipReason }, () => {
  let householdId;
  let bareHouseholdId;
  let sharedBrainId;
  let minterKeyId;
  let ctx;
  let bareCtx;

  async function keysFor(repoSlug) {
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

    const keys = await keysFor(repo("a"));
    assert.equal(keys.length, 1);
    assert.equal(keys[0].credential_type, "repo_key");
    assert.equal(keys[0].principal_type, "repo_service");
    assert.equal(keys[0].principal_slug, `repo-service:${repo("a")}`);
    assert.equal(keys[0].is_admin, false, "a minted key is never admin");
    assert.equal(keys[0].can_mint_repo_keys, false, "a minted key can never mint");
    assert.equal(keys[0].read_egress_class, null, "null => cloud_bound (fail-closed)");

    assert.deepEqual(await membershipBrainSlugs(result.principal_id), [`repo:${repo("a")}`], "the harness principal reaches ONE brain");
  });

  it("mint_agent_key gives the caged agent its OWN principal with TWO memberships", { skip: agentHandlersMissing }, async () => {
    const result = await minting.handleMintAgentKey({ repo_slug: repo("a") }, ctx);
    assert.match(result.key, /^[0-9a-f]{64}$/);
    assert.equal(result.principal_slug, `pi:${repo("a")}`);
    assert.equal(result.shared_brain_id, sharedBrainId);
    assert.equal(result.shared_brain_egress_class, "repo", "surfaced so the operator can see the agent can actually read it");

    const principal = await query("select principal_type from brain_principals where id = $1::uuid", [result.principal_id]);
    assert.equal(principal.rows[0].principal_type, "caged_agent");

    assert.deepEqual(
      await membershipBrainSlugs(result.principal_id),
      [`repo:${repo("a")}`, SHARED_BRAIN_SLUG].sort(),
      "repo brain + the shared agent brain, and nothing else",
    );

    const keys = await keysFor(repo("a"));
    assert.equal(keys.length, 2, "both families hold a key on the same repo brain");
    const agentKey = keys.find((k) => k.credential_type === "agent_key");
    assert.ok(agentKey, "the agent credential is typed agent_key, not repo_key");
    assert.equal(agentKey.principal_type, "caged_agent");
    assert.equal(agentKey.is_admin, false);
    assert.equal(agentKey.can_mint_repo_keys, false);
    assert.equal(agentKey.read_egress_class, null);

    // The two families must not share a principal — that is the whole reason the
    // agent needs its own key (a key carries its PRINCIPAL's memberships).
    const repoKey = keys.find((k) => k.credential_type === "repo_key");
    assert.notEqual(repoKey.principal_slug, agentKey.principal_slug);
    assert.deepEqual(await membershipBrainSlugs((await query(
      "select id from brain_principals where household_id = $1::uuid and slug = $2",
      [householdId, `repo-service:${repo("a")}`],
    )).rows[0].id), [`repo:${repo("a")}`], "minting the agent key did not widen the harness principal");
  });

  // --- the narrowed guards -------------------------------------------------

  it("mint_repo_key is NOT blocked by the caged agent's key on the same brain", { skip: agentHandlersMissing }, async () => {
    await minting.handleMintRepoKey({ repo_slug: repo("b") }, ctx);
    await minting.handleMintAgentKey({ repo_slug: repo("b") }, ctx);

    // The repo key is lost / revoked by hand; the agent key stays live.
    await query(
      `update brain_access_keys set is_active = false
       where credential_type = 'repo_key' and brain_id = (
         select id from brains where household_id = $1::uuid and slug = $2)`,
      [householdId, `repo:${repo("b")}`],
    );

    const reminted = await minting.handleMintRepoKey({ repo_slug: repo("b") }, ctx);
    assert.match(reminted.key, /^[0-9a-f]{64}$/, "a brain-wide guard would 409 here and strand the repo");

    const live = (await keysFor(repo("b"))).filter((k) => k.is_active);
    assert.deepEqual(live.map((k) => k.credential_type).sort(), ["agent_key", "repo_key"]);
  });

  it("mint_repo_key is still create-only for its OWN family", async () => {
    await minting.handleMintRepoKey({ repo_slug: repo("c") }, ctx);
    await assert.rejects(
      () => minting.handleMintRepoKey({ repo_slug: repo("c") }, ctx),
      (e) => e.status === 409 && /rotate_repo_key/.test(e.message),
      "a second live repo key would make revoking one revoke nothing",
    );
    assert.equal((await keysFor(repo("c"))).filter((k) => k.is_active).length, 1);
  });

  it("mint_agent_key is create-only for its OWN family", { skip: agentHandlersMissing }, async () => {
    await minting.handleMintRepoKey({ repo_slug: repo("d") }, ctx);
    await minting.handleMintAgentKey({ repo_slug: repo("d") }, ctx);
    await assert.rejects(
      () => minting.handleMintAgentKey({ repo_slug: repo("d") }, ctx),
      (e) => e.status === 409 && /rotate_agent_key/.test(e.message),
    );
    assert.equal((await keysFor(repo("d"))).filter((k) => k.is_active && k.credential_type === "agent_key").length, 1);
  });

  it("rotate_repo_key revokes ONLY the repo key — the caged agent stays online", { skip: agentHandlersMissing }, async () => {
    await minting.handleMintRepoKey({ repo_slug: repo("e") }, ctx);
    await minting.handleMintAgentKey({ repo_slug: repo("e") }, ctx);
    const before = await keysFor(repo("e"));
    const agentKeyId = before.find((k) => k.credential_type === "agent_key").id;

    const rotated = await minting.handleRotateRepoKey({ repo_slug: repo("e") }, ctx);
    assert.equal(rotated.revoked_key_count, 1, "exactly one credential was revoked");

    const after = await keysFor(repo("e"));
    assert.equal(after.find((k) => k.id === agentKeyId).is_active, true, "rotating the harness key must not take pi offline");
    assert.equal(after.filter((k) => k.credential_type === "repo_key" && k.is_active).length, 1);
  });

  it("rotate_agent_key revokes ONLY the agent key — the harnesses stay online", { skip: agentHandlersMissing }, async () => {
    await minting.handleMintRepoKey({ repo_slug: repo("f") }, ctx);
    await minting.handleMintAgentKey({ repo_slug: repo("f") }, ctx);
    const repoKeyId = (await keysFor(repo("f"))).find((k) => k.credential_type === "repo_key").id;

    const rotated = await minting.handleRotateAgentKey({ repo_slug: repo("f") }, ctx);
    assert.equal(rotated.revoked_key_count, 1);
    assert.match(rotated.key, /^[0-9a-f]{64}$/);

    const after = await keysFor(repo("f"));
    assert.equal(after.find((k) => k.id === repoKeyId).is_active, true, "burning the injection-exposed key is not a repo outage");
    assert.equal(after.filter((k) => k.credential_type === "agent_key" && k.is_active).length, 1);
  });

  it("no rotation ever touches the minting authority's own key", async () => {
    const r = await query("select is_active from brain_access_keys where id = $1::uuid", [minterKeyId]);
    assert.equal(r.rows[0].is_active, true, "the minter has brain_id null and its own principal");
  });

  // --- refusals ------------------------------------------------------------

  it("mint_agent_key refuses to create the repo brain by naming it", { skip: agentHandlersMissing }, async () => {
    await assert.rejects(
      () => minting.handleMintAgentKey({ repo_slug: repo("never-minted") }, ctx),
      (e) => e.status === 404 && /mint_repo_key/.test(e.message),
    );
    const brains = await query(
      "select 1 from brains where household_id = $1::uuid and slug = $2",
      [householdId, `repo:${repo("never-minted")}`],
    );
    assert.equal(brains.rowCount, 0, "a 404 must not have provisioned anything");
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
    const principals = await query(
      "select 1 from brain_principals where household_id = $1::uuid and slug = $2",
      [bareHouseholdId, `pi:${repo("h")}`],
    );
    assert.equal(principals.rowCount, 0, "the refused mint rolled back the principal it had created");
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

  it("a principal that has gained reach outside its scope is never re-issued a key", { skip: agentHandlersMissing }, async () => {
    await minting.handleMintRepoKey({ repo_slug: repo("i") }, ctx);
    const agent = await minting.handleMintAgentKey({ repo_slug: repo("i") }, ctx);

    // Someone widens pi's reach by hand, onto another repo's brain.
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

  it("mint_agent_key refuses to adopt a principal of another type", { skip: agentHandlersMissing }, async () => {
    await minting.handleMintRepoKey({ repo_slug: repo("k") }, ctx);
    await query(
      `insert into brain_principals(household_id, slug, display_name, principal_type)
       values ($1::uuid, $2, 'squatter', 'person')`,
      [householdId, `pi:${repo("k")}`],
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
