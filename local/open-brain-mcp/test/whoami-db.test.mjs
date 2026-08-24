// whoami against the real database.
//
// whoami exists because every OB1 client falls back to MCP_ACCESS_KEY when its
// scoped key is unset (docs/adr/0004 amendment). A mis-provisioned scoped key
// therefore tests GREEN during rollout — it silently used the admin fallback —
// and only 401s after the shared admin key is withdrawn, i.e. after the
// irreversible step. whoami answers "is this the key I THINK it is?" instead of
// "does some key work?".
//
// The assertions that matter are therefore:
//
//   1. the three credential shapes are DISTINGUISHABLE from each other — if a repo
//      key and the legacy admin key produced similar-looking output, the tool would
//      certify a mis-provisioned key as correct, which is worse than not having it;
//   2. reported reach matches the read path's scope, not a parallel query;
//   3. it works for the degenerate callers — the brain-less minter and the
//      principal-less legacy admin — since those are exactly when you need to ask;
//   4. no key value, no key_hash, not even an 8-char prefix, appears in any output.
//
// Self-skips with an explicit reason when the dev database is unreachable, and
// HARD-REFUSES to run against prod `ob1`. Fixtures are `zzt-`-prefixed households
// and are torn down (every table here cascades from households).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// Unique per process: several agents run `npm test` against the same dev database
// at once, and a shared fixture slug means one run's setup deletes another's rows.
const RUN = crypto.randomBytes(4).toString("hex");
const EST = `zzt-whoami-est-${RUN}`;
const KEY_REPO = `zzt-repo-key-${RUN}`;
const KEY_MINTER = `zzt-minter-key-${RUN}`;

let query;
let closePool;
let app;
let hashAccessKey;
let legacyAdminKey = null;
let skipReason = false;

try {
  const { config } = await import("../src/config.mjs");
  if (config.postgres?.database === "ob1") {
    skipReason = "refusing to run the whoami DB suite against prod database 'ob1'";
  } else {
    const db = await import("../src/db.mjs");
    query = db.query;
    closePool = db.closePool;
    await query("select 1");
    ({ app } = await import("../src/server.mjs"));
    ({ hashAccessKey } = await import("../src/auth.mjs"));
    legacyAdminKey = config.accessKey ?? null;
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

async function whoami(key) {
  const res = await app.request("/whoami", { headers: key ? { "x-access-key": key } : {} });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

describe("whoami (DB-backed)", { skip: skipReason }, () => {
  let ids;

  before(async () => {
    const est = (await query(
      "insert into households (slug, display_name) values ($1,$2) returning id",
      [EST, "whoami fixture"],
    )).rows[0].id;

    const repoBrain = (await query(
      `insert into brains (household_id, slug, display_name, kind, egress_class)
       values ($1,$2,$3,'repo','repo') returning id`,
      [est, `repo:zzt-${RUN}`, "repo brain"],
    )).rows[0].id;

    const repoPrincipal = (await query(
      `insert into brain_principals (household_id, slug, display_name, principal_type, default_brain_id)
       values ($1,$2,$3,'service',$4) returning id`,
      [est, `repo-service:zzt-${RUN}`, "repo service", repoBrain],
    )).rows[0].id;

    // Brain-less on purpose: the minter is the caller with no usable brain, which
    // is the shape auth.mjs relaxes requireUsableBrain for.
    const minterPrincipal = (await query(
      `insert into brain_principals (household_id, slug, display_name, principal_type, default_brain_id)
       values ($1,$2,$3,'service',null) returning id`,
      [est, `minter:zzt-${RUN}`, "minter"],
    )).rows[0].id;

    await query(
      "insert into brain_memberships (principal_id, brain_id, role) values ($1,$2,'editor')",
      [repoPrincipal, repoBrain],
    );
    await query(
      `insert into brain_access_keys (principal_id, brain_id, key_hash, label, credential_type, is_admin, read_egress_class)
       values ($1,$2,$3,$4,'repo_key',false,null)`,
      [repoPrincipal, repoBrain, hashAccessKey(KEY_REPO), `zzt repo key ${RUN}`],
    );
    await query(
      `insert into brain_access_keys (principal_id, brain_id, key_hash, label, credential_type, is_admin, can_mint_repo_keys)
       values ($1,null,$2,$3,'minter',false,true)`,
      [minterPrincipal, hashAccessKey(KEY_MINTER), `zzt minter key ${RUN}`],
    );

    ids = { est, repoBrain };
  });

  after(async () => {
    if (ids?.est) {
      await query("delete from households where id = $1::uuid", [ids.est]);
    }
    if (closePool) await closePool();
  });

  it("a scoped repo key reports its own principal and exactly its own brain", async () => {
    const { status, body } = await whoami(KEY_REPO);
    assert.equal(status, 200);
    assert.equal(body.principal.slug, `repo-service:zzt-${RUN}`);
    assert.equal(body.is_admin, false);
    assert.equal(body.can_mint_repo_keys, false);
    assert.equal(body.brain_count, 1, "a repo key reaches exactly one brain");
    assert.equal(body.brains[0].slug, `repo:zzt-${RUN}`);
    assert.equal(body.brains[0].role, "editor");
  });

  it("the brain-less minter key answers instead of 403ing", async () => {
    // The whole point: you ask what you are precisely when you have no brain and
    // every content tool is refusing you.
    const { status, body } = await whoami(KEY_MINTER);
    assert.equal(status, 200, "a brain-less credential must still be able to describe itself");
    assert.equal(body.can_mint_repo_keys, true);
    assert.equal(body.brain_count, 0);
  });

  it("the three shapes are distinguishable — the point of the tool", async () => {
    const repo = (await whoami(KEY_REPO)).body;
    const minter = (await whoami(KEY_MINTER)).body;
    assert.notEqual(repo.principal.slug, minter.principal.slug);
    assert.notEqual(repo.can_mint_repo_keys, minter.can_mint_repo_keys);

    if (legacyAdminKey) {
      const legacy = (await whoami(legacyAdminKey)).body;
      // A scoped key that silently fell back to the admin key would look like THIS.
      // Telling them apart is what catches the mis-provisioning before withdrawal.
      assert.notEqual(legacy.auth_source, repo.auth_source);
      assert.equal(legacy.is_admin, true);
      assert.equal(repo.is_admin, false);
    }
  });

  it("the legacy admin path answers honestly and enumerates nothing", async () => {
    if (!legacyAdminKey) return;
    const { status, body } = await whoami(legacyAdminKey);
    assert.equal(status, 200, "the principal-less legacy path must not crash");
    assert.equal(body.principal, null);
    assert.equal(body.is_admin, true);
    assert.equal(body.brain_count, 0, "it must not dump the estate");
  });

  it("no key material appears anywhere in the output", async () => {
    for (const key of [KEY_REPO, KEY_MINTER]) {
      const payload = JSON.stringify((await whoami(key)).body);
      const hash = hashAccessKey(key);
      assert.ok(!payload.includes(key), "the key value must never be echoed");
      assert.ok(!payload.includes(hash), "the key hash is the authenticator; it must never appear");
      assert.ok(!payload.includes(hash.slice(0, 8)), "not even an 8-char hash prefix");
      assert.ok(!payload.includes("key_hash"), "no key_hash field at all");
    }
  });

  it("an unknown key is refused rather than described", async () => {
    const { status } = await whoami(`zzt-not-a-key-${RUN}`);
    assert.equal(status, 401);
  });
});
