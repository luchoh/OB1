// list_brains / list_principals / list_keys against the real database.
//
// These handlers exist because the estate was write-only through tooling: you
// could mint, but you could not ask what exists (docs/adr/0004). The assertions
// that matter are therefore not "does it return rows" but:
//
//   1. the capability gate is the SAME one that gates minting, on all three;
//   2. enumeration is confined to the minter household;
//   3. reach counts follow the PRINCIPAL's memberships (ADR-0003), not the key's
//      default-brain hint, and a deny row grants nothing;
//   4. a stray ACTIVE admin key is surfaced by name at the top level — the orphan
//      bootstrap-admin case;
//   5. no key_hash, not even an 8-char prefix, appears anywhere in the output.
//
// Self-skips with an explicit reason when the dev database is unreachable, and
// HARD-REFUSES to run against prod `ob1`. Fixtures are `zzt-`-prefixed households
// and are torn down (every table here cascades from households).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// Unique per process: several agents run `npm test` against the same dev database
// at once, and a shared fixture slug means one run's setup deletes another run's
// rows mid-test.
const RUN = crypto.randomBytes(4).toString("hex");
const EST = `zzt-enum-est-${RUN}`;
const OTHER_EST = `zzt-enum-other-${RUN}`;

let query;
let closePool;
let enumeration;
let skipReason = false;

try {
  const { config } = await import("../src/config.mjs");
  if (config.postgres?.database === "ob1") {
    skipReason = "refusing to run the enumeration DB suite against prod database 'ob1'";
  } else {
    const db = await import("../src/db.mjs");
    query = db.query;
    closePool = db.closePool;
    await query("select 1");
    enumeration = await import("../src/repo-key-minting.mjs");
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

const handlersMissing = !skipReason
  && !(typeof enumeration.handleListBrains === "function"
    && typeof enumeration.handleListPrincipals === "function"
    && typeof enumeration.handleListKeys === "function");

// The minter's context shape, mirroring auth.mjs makeContext: the capability is
// read off _policy.caller.canMintRepoKeys, the confinement off householdId.
const minterContext = (householdId) => ({
  householdId,
  principalId: null,
  _policy: { caller: { canMintRepoKeys: true } },
});
const nonMinterContext = (householdId) => ({
  householdId,
  principalId: null,
  _policy: { caller: { canMintRepoKeys: false } },
});

describe("estate enumeration (database)", { skip: skipReason || (handlersMissing && "list handlers are not exported yet") }, () => {
  const ids = {};

  const insertBrain = async (household, slug, kind, egressClass, opts = {}) => (await query(
    `insert into brains (household_id, slug, display_name, kind, egress_class,
                         is_default_shared, is_shared_agent_brain)
     values ($1::uuid, $2, $2, $3, $4, $5, $6) returning id`,
    [household, slug, kind, egressClass, opts.defaultShared ?? false, opts.sharedAgent ?? false],
  )).rows[0].id;

  const insertPrincipal = async (household, slug, type, defaultBrainId) => (await query(
    `insert into brain_principals (household_id, slug, display_name, principal_type, default_brain_id)
     values ($1::uuid, $2, $2, $3, $4::uuid) returning id`,
    [household, slug, type, defaultBrainId],
  )).rows[0].id;

  const insertMembership = (principalId, brainId, role, isDeny = false) => query(
    `insert into brain_memberships (principal_id, brain_id, role, is_deny)
     values ($1::uuid, $2::uuid, $3, $4)`,
    [principalId, brainId, role, isDeny],
  );

  const insertKey = async (principalId, brainId, label, o = {}) => (await query(
    `insert into brain_access_keys (principal_id, brain_id, key_hash, label, credential_type,
                                    is_active, is_admin, read_egress_class, can_mint_repo_keys)
     values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      principalId, brainId, crypto.randomBytes(32).toString("hex"), label,
      o.credentialType ?? "repo_key", o.active ?? true, o.admin ?? false,
      o.readEgressClass ?? null, o.canMint ?? false,
    ],
  )).rows[0].id;

  before(async () => {
    ids.household = (await query(
      "insert into households (slug, display_name) values ($1, $1) returning id",
      [EST],
    )).rows[0].id;
    ids.otherHousehold = (await query(
      "insert into households (slug, display_name) values ($1, $1) returning id",
      [OTHER_EST],
    )).rows[0].id;

    ids.repoBrain = await insertBrain(ids.household, `repo:zzt-a-${RUN}`, "repo", "repo");
    ids.personalBrain = await insertBrain(
      ids.household, `zzt-personal-${RUN}`, "personal", "private_local", { defaultShared: true },
    );
    ids.sharedBrain = await insertBrain(
      ids.household, `zzt-common-${RUN}`, "repo", "repo", { sharedAgent: true },
    );
    ids.foreignBrain = await insertBrain(ids.otherHousehold, `zzt-foreign-${RUN}`, "repo", "repo");

    ids.repoService = await insertPrincipal(
      ids.household, `repo-service:zzt-a-${RUN}`, "repo_service", ids.repoBrain,
    );
    ids.person = await insertPrincipal(ids.household, `zzt-person-${RUN}`, "person", ids.personalBrain);
    ids.foreignPrincipal = await insertPrincipal(
      ids.otherHousehold, `zzt-foreign-p-${RUN}`, "repo_service", ids.foreignBrain,
    );

    await insertMembership(ids.repoService, ids.repoBrain, "editor");
    await insertMembership(ids.person, ids.personalBrain, "owner");
    // A deny row: it must be VISIBLE in list_principals and grant no reach in
    // list_brains. An operator who denied a membership by hand meant it.
    await insertMembership(ids.person, ids.sharedBrain, "viewer", true);
    // Granted cross-estate reach INTO this household's repo brain (ADR-0003).
    await insertMembership(ids.foreignPrincipal, ids.repoBrain, "editor");

    ids.repoKey = await insertKey(ids.repoService, ids.repoBrain, `zzt repo key ${RUN}`);
    // The case this suite is named for: an orphan, still-active admin key.
    ids.strayAdminKey = await insertKey(ids.person, ids.personalBrain, `zzt bootstrap-admin ${RUN}`, {
      credentialType: "service_key", admin: true, readEgressClass: "local_trusted",
    });
    ids.revokedAdminKey = await insertKey(ids.person, ids.personalBrain, `zzt revoked admin ${RUN}`, {
      credentialType: "service_key", admin: true, active: false,
    });
    ids.foreignKey = await insertKey(ids.foreignPrincipal, ids.foreignBrain, `zzt foreign key ${RUN}`);
    // Brain-less, like the real minter: exercises the left join on brains.
    ids.minterKey = (await query(
      `insert into brain_access_keys (principal_id, brain_id, key_hash, label, credential_type,
                                      is_active, is_admin, can_mint_repo_keys)
       values ($1::uuid, null, $2, $3, 'minting_key', true, false, true) returning id`,
      [ids.person, crypto.randomBytes(32).toString("hex"), `zzt minter ${RUN}`],
    )).rows[0].id;

    await query(
      `insert into thoughts (brain_id, content, written_by_principal_id, dedupe_key)
       values ($1::uuid, 'zzt enumeration probe', $2::uuid, $3)`,
      [ids.repoBrain, ids.repoService, `zzt-live-${RUN}`],
    );
    await query(
      `insert into thoughts (brain_id, content, written_by_principal_id, dedupe_key, deleted_at)
       values ($1::uuid, 'zzt deleted probe', $2::uuid, $3, now())`,
      [ids.repoBrain, ids.repoService, `zzt-gone-${RUN}`],
    );
  });

  after(async () => {
    if (!query) return;
    await query(
      "delete from thoughts where brain_id in (select id from brains where household_id = $1::uuid)",
      [ids.household],
    ).catch(() => {});
    for (const household of [ids.household, ids.otherHousehold]) {
      if (household) {
        await query("delete from households where id = $1::uuid", [household]).catch(() => {});
      }
    }
    if (closePool) await closePool();
  });

  // The whole point of the gate: enumeration is the operator's provisioning
  // credential's job, and no agent key carries can_mint_repo_keys.
  it("all three handlers refuse a caller without the minting capability", async () => {
    for (const handler of [
      enumeration.handleListBrains, enumeration.handleListPrincipals, enumeration.handleListKeys,
    ]) {
      await assert.rejects(
        () => handler({}, nonMinterContext(ids.household)),
        (error) => error.status === 403 && /mint repo keys/.test(error.message),
      );
    }
  });

  it("all three handlers refuse a minter that is not homed in an estate", async () => {
    for (const handler of [
      enumeration.handleListBrains, enumeration.handleListPrincipals, enumeration.handleListKeys,
    ]) {
      await assert.rejects(
        () => handler({}, minterContext(null)),
        (error) => error.status === 403 && /not homed/.test(error.message),
      );
    }
  });

  it("list_brains reports only the minter household's brains, with shape and thought counts", async () => {
    const result = await enumeration.handleListBrains({}, minterContext(ids.household));
    assert.equal(result.household_id, ids.household);
    assert.equal(result.brain_count, 3);
    assert.ok(!result.brains.some((b) => b.brain_id === ids.foreignBrain), "no cross-estate brains");

    const bySlug = Object.fromEntries(result.brains.map((b) => [b.slug, b]));
    const repo = bySlug[`repo:zzt-a-${RUN}`];
    assert.equal(repo.kind, "repo");
    assert.equal(repo.egress_class, "repo");
    assert.equal(repo.is_default_shared, false);
    assert.equal(repo.is_shared_agent_brain, false);
    assert.equal(repo.thought_count, 1, "live thoughts only");
    assert.equal(repo.deleted_thought_count, 1, "soft-deleted counted separately, not silently");

    const personal = bySlug[`zzt-personal-${RUN}`];
    assert.equal(personal.is_default_shared, true);
    assert.equal(personal.egress_class, "private_local");
    assert.equal(bySlug[`zzt-common-${RUN}`].is_shared_agent_brain, true);
  });

  // Reach, not brain_id. Counting the key's default-brain hint would report 0
  // reachable keys for a brain half the estate can write to.
  it("list_brains counts keys by principal reach, including admin-in-estate and granted cross-estate reach", async () => {
    const result = await enumeration.handleListBrains({}, minterContext(ids.household));
    const bySlug = Object.fromEntries(result.brains.map((b) => [b.slug, b]));

    // repo key (membership) + foreign key (granted membership) + stray admin
    // (admin in home estate) — three live credentials reach the repo brain.
    const repo = bySlug[`repo:zzt-a-${RUN}`];
    assert.equal(repo.active_key_count, 3);
    assert.equal(repo.active_admin_key_count, 1);
    assert.equal(repo.external_principal_key_count, 1, "the foreign principal's key is flagged, not hidden");

    // The person's two active keys reach their own brain; the repo key does not.
    const personal = bySlug[`zzt-personal-${RUN}`];
    assert.equal(personal.active_key_count, 2);
    assert.equal(personal.external_principal_key_count, 0);

    // NOBODY reaches the shared brain. The person holds a brain-level DENY on it,
    // and a deny vetoes EVERY grant arm — including their admin key's home-estate
    // reach (access-policy.mjs:300 is NOT hasDenyBrain AND (...)). An earlier
    // version of this test asserted 1 here and called it "the admin key"; that 1
    // was the deny-shadowed admin key leaking through the un-vetoed admin arm, so
    // the test was cementing the bug rather than catching it.
    const shared = bySlug[`zzt-common-${RUN}`];
    assert.equal(shared.active_key_count, 0, "a brain-level deny vetoes admin home-reach too");
    assert.equal(shared.active_admin_key_count, 0);
  });

  it("list_principals shows each principal's memberships, deny rows included", async () => {
    const result = await enumeration.handleListPrincipals({}, minterContext(ids.household));
    assert.equal(result.principal_count, 2, "the other estate's principal is not enumerated");

    const bySlug = Object.fromEntries(result.principals.map((p) => [p.slug, p]));
    const service = bySlug[`repo-service:zzt-a-${RUN}`];
    assert.equal(service.principal_type, "repo_service");
    assert.equal(service.memberships.length, 1, "a correctly scoped repo principal reaches exactly one brain");
    assert.equal(service.memberships[0].brain_slug, `repo:zzt-a-${RUN}`);
    assert.equal(service.memberships[0].role, "editor");
    assert.equal(service.memberships[0].is_deny, false);
    assert.equal(service.memberships[0].in_household, true);
    assert.equal(service.active_key_count, 1);
    assert.equal(service.inactive_key_count, 0);

    const person = bySlug[`zzt-person-${RUN}`];
    assert.equal(person.memberships.length, 2);
    const denied = person.memberships.find((m) => m.brain_slug === `zzt-common-${RUN}`);
    assert.equal(denied.is_deny, true, "deny rows are shown, not filtered away");
    assert.equal(person.default_brain_slug, `zzt-personal-${RUN}`);
    assert.equal(person.active_key_count, 2);
    assert.equal(person.inactive_key_count, 1);
  });

  it("list_keys surfaces a stray ACTIVE admin key at the top level", async () => {
    const result = await enumeration.handleListKeys({}, minterContext(ids.household));
    assert.equal(result.active_admin_key_count, 1);
    assert.equal(result.active_admin_keys.length, 1);
    assert.equal(result.active_admin_keys[0].key_id, ids.strayAdminKey);
    assert.equal(result.active_admin_keys[0].label, `zzt bootstrap-admin ${RUN}`);
    assert.equal(result.active_admin_keys[0].principal_slug, `zzt-person-${RUN}`);
    assert.equal(result.keys[0].is_admin, true, "admin keys sort first, so a stray cannot hide in a long list");
    assert.equal(result.active_minting_key_count, 1);
  });

  it("list_keys returns the full credential shape and never a key hash", async () => {
    const result = await enumeration.handleListKeys({}, minterContext(ids.household));
    assert.equal(result.key_count, 4, "four keys on this household's principals; the foreign key is excluded");
    assert.ok(!result.keys.some((k) => k.key_id === ids.foreignKey));

    const blob = JSON.stringify(result);
    assert.ok(!blob.includes("key_hash"), "no key_hash field");
    const hashes = (await query(
      "select k.key_hash from brain_access_keys k join brain_principals p on p.id = k.principal_id where p.household_id = $1::uuid",
      [ids.household],
    )).rows.map((r) => r.key_hash);
    assert.equal(hashes.length, 4);
    for (const hash of hashes) {
      assert.ok(!blob.includes(hash), "a full key hash leaked");
      // The hash IS the authenticator; a prefix shrinks an offline search for the
      // plaintext, so not even 8 characters may appear.
      assert.ok(!blob.includes(hash.slice(0, 8)), "a key hash prefix leaked");
    }

    const stray = result.keys.find((k) => k.key_id === ids.strayAdminKey);
    assert.equal(stray.credential_type, "service_key");
    assert.equal(stray.can_mint_repo_keys, false);
    assert.equal(stray.read_egress_class, "local_trusted");
    assert.equal(stray.is_active, true);
    assert.equal(stray.principal_type, "person");
    assert.equal(stray.bound_brain_slug, `zzt-personal-${RUN}`);
    assert.ok(stray.created_at instanceof Date);
    assert.equal(stray.last_used_at, null);

    const minter = result.keys.find((k) => k.key_id === ids.minterKey);
    assert.equal(minter.can_mint_repo_keys, true);
    assert.equal(minter.bound_brain_id, null, "a brain-less key is listed, not dropped by the join");
    assert.equal(minter.bound_brain_slug, null);

    const revoked = result.keys.find((k) => k.key_id === ids.revokedAdminKey);
    assert.equal(revoked.is_active, false, "inactive keys are included and marked");
    assert.equal(revoked.is_admin, true);
  });

  it("list_keys filters: include_inactive and only_admin", async () => {
    const activeOnly = await enumeration.handleListKeys(
      { include_inactive: false }, minterContext(ids.household),
    );
    assert.equal(activeOnly.key_count, 3);
    assert.ok(activeOnly.keys.every((k) => k.is_active));

    const adminOnly = await enumeration.handleListKeys({ only_admin: true }, minterContext(ids.household));
    assert.equal(adminOnly.key_count, 2, "both admin keys: the live one and the revoked one");

    const strayHunt = await enumeration.handleListKeys(
      { only_admin: true, include_inactive: false }, minterContext(ids.household),
    );
    assert.equal(strayHunt.key_count, 1);
    assert.equal(strayHunt.keys[0].key_id, ids.strayAdminKey);
  });

  // "include_inactive: 'false'" must not silently mean true and hide exactly the
  // rows the operator is hunting for.
  it("list_keys rejects non-boolean flags rather than coercing them", async () => {
    for (const args of [{ include_inactive: "false" }, { only_admin: 1 }, { only_admin: "yes" }]) {
      await assert.rejects(
        () => enumeration.handleListKeys(args, minterContext(ids.household)),
        (error) => error.status === 400,
      );
    }
  });

  it("enumeration is confined to the minter's own household", async () => {
    const brains = await enumeration.handleListBrains({}, minterContext(ids.otherHousehold));
    assert.equal(brains.brain_count, 1);
    assert.equal(brains.brains[0].brain_id, ids.foreignBrain);

    const principals = await enumeration.handleListPrincipals({}, minterContext(ids.otherHousehold));
    assert.equal(principals.principal_count, 1);

    const keys = await enumeration.handleListKeys({}, minterContext(ids.otherHousehold));
    assert.equal(keys.key_count, 1);
    assert.equal(keys.keys[0].key_id, ids.foreignKey);
    assert.equal(keys.active_admin_key_count, 0);
  });

  // Read-only is a property, not a comment: if any handler ever grows a write,
  // this catches it.
  it("no handler writes", async () => {
    const snapshot = async () => (await query(
      `select
         (select count(*)::int from brains where household_id = $1::uuid) as brains,
         (select count(*)::int from brain_principals where household_id = $1::uuid) as principals,
         (select count(*)::int from brain_access_keys k join brain_principals p on p.id = k.principal_id
           where p.household_id = $1::uuid) as keys,
         (select count(*)::int from brain_memberships m join brain_principals p on p.id = m.principal_id
           where p.household_id = $1::uuid) as memberships`,
      [ids.household],
    )).rows[0];

    const before = await snapshot();
    await enumeration.handleListBrains({}, minterContext(ids.household));
    await enumeration.handleListPrincipals({}, minterContext(ids.household));
    await enumeration.handleListKeys({}, minterContext(ids.household));
    assert.deepEqual(await snapshot(), before);
  });
});
