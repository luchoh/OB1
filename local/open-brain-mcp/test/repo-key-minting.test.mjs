import test from "node:test";
import assert from "node:assert/strict";
import { __testables } from "../src/repo-key-minting.mjs";

// These cover the two decisions that are pure — the capability gate and slug
// validation. Both are the parts that must fail CLOSED, so they are worth
// testing without a database. The transactional bodies need real Postgres and
// are exercised by the local smoke script instead.

const { validateRepoSlug, requireMintCapability } = __testables;

function contextWith(caller) {
  return { _policy: { caller } };
}

test("mint capability: only an explicit true passes", () => {
  assert.doesNotThrow(() => requireMintCapability(contextWith({ canMintRepoKeys: true })));
});

test("mint capability: fails closed for every non-true shape", () => {
  const shapes = [
    contextWith({ canMintRepoKeys: false }),
    contextWith({ canMintRepoKeys: "true" }),   // truthy string must NOT pass
    contextWith({ canMintRepoKeys: 1 }),        // truthy number must NOT pass
    contextWith({}),                            // capability absent
    contextWith({ isAdmin: true }),             // admin is NOT a minter (docs/53)
    { _policy: {} },                            // no caller
    {},                                         // no policy bundle
    null,
    undefined,
  ];

  for (const ctx of shapes) {
    assert.throws(
      () => requireMintCapability(ctx),
      (error) => error.status === 403,
      `expected 403 for ${JSON.stringify(ctx)}`,
    );
  }
});

test("repo slug: accepts DNS-safe names", () => {
  for (const slug of ["ob1", "system-config", "wingman-ios", "a", "a1", "a-b-c", "x".repeat(63)]) {
    assert.equal(validateRepoSlug(slug), slug);
  }
});

test("repo slug: trims surrounding whitespace", () => {
  assert.equal(validateRepoSlug("  ob1  "), "ob1");
});

test("repo slug: rejects anything not DNS-safe", () => {
  const bad = [
    "",                  // empty
    "-lead",             // leading hyphen
    "trail-",            // trailing hyphen
    "OB1",               // uppercase
    "under_score",
    "with space",
    "dot.separated",
    "repo:ob1",          // must not smuggle the namespace prefix
    "x".repeat(64),      // too long
    "a/../b",            // path-ish
    "a'; drop table brains; --",
    null,
    undefined,
    42,
    {},
  ];

  for (const slug of bad) {
    assert.throws(
      () => validateRepoSlug(slug),
      (error) => error.status === 400,
      `expected 400 for ${JSON.stringify(slug)}`,
    );
  }
});
