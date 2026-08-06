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

// The gate reads one nested property, so the shapes that could sneak past it are
// the ones where the property LOOKS true without the row saying so: a boxed
// Boolean, a wrapper, or a capability parked one level away from where the gate
// reads it.
test("mint capability: fails closed for lookalike true values", () => {
  const shapes = [
    ["boxed Boolean", contextWith({ canMintRepoKeys: new Boolean(true) })],
    ["array-wrapped", contextWith({ canMintRepoKeys: [true] })],
    ["object-wrapped", contextWith({ canMintRepoKeys: {} })],
    ["column name, not the caller field", contextWith({ can_mint_repo_keys: true })],
    ["capability outside the policy bundle", { caller: { canMintRepoKeys: true } }],
    ["capability on a differently named collection", { _policy: { callers: [{ canMintRepoKeys: true }] } }],
  ];

  for (const [label, ctx] of shapes) {
    assert.throws(
      () => requireMintCapability(ctx),
      (error) => error.status === 403,
      `expected 403 for ${label}`,
    );
  }
});

// A decoy sibling must not change the verdict either way: the gate looks at
// exactly one path and nothing else.
test("mint capability: reads only _policy.caller", () => {
  assert.doesNotThrow(() =>
    requireMintCapability({ _policy: { caller: { canMintRepoKeys: true } }, canMintRepoKeys: false }));
  assert.throws(
    () => requireMintCapability({ _policy: { caller: { canMintRepoKeys: false } }, canMintRepoKeys: true }),
    (error) => error.status === 403,
  );
});

test("mint capability: unrelated caller fields never affect the verdict", () => {
  assert.doesNotThrow(() =>
    requireMintCapability(contextWith({
      canMintRepoKeys: true,
      isAdmin: false,
      egressClass: "cloud_bound",
      brainId: null,
    })));
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

// The accepted slug is concatenated into 'repo:<slug>' and 'repo-service:<slug>'
// and becomes a row identity. Anything that ends a line, closes a quote, or
// carries a non-ASCII lookalike would make two different repos indistinguishable
// to an operator reading the table.
test("repo slug: rejects embedded terminators, separators and lookalikes", () => {
  const bad = [
    "ob1\nsystem-config",     // newline is only stripped at the ends
    "ob1\tsc",
    "ob1\u0000",              // NUL is not whitespace, so trim cannot hide it
    "ob1\u200bsc",            // zero-width space
    "\u043eb1",               // Cyrillic 'о' homoglyph
    "ob1%2fsc",               // percent-encoded separator
    "ob1:sc",
    "ob1@host",
    "ob1*",
    "repo-service:ob1",       // the principal namespace prefix
    "--",
    "-",
    "  ",                     // whitespace only, empty after trim
    "\n",
  ];

  for (const slug of bad) {
    assert.throws(
      () => validateRepoSlug(slug),
      (error) => error.status === 400,
      `expected 400 for ${JSON.stringify(slug)}`,
    );
  }
});

test("repo slug: only primitive strings are accepted", () => {
  // A String wrapper is truthy and stringifies to a valid slug, so a typeof
  // check is the only thing standing between it and the SQL below.
  assert.throws(
    () => validateRepoSlug(new String("ob1")),
    (error) => error.status === 400,
  );
  assert.throws(() => validateRepoSlug(["ob1"]), (error) => error.status === 400);
  assert.throws(() => validateRepoSlug({ toString: () => "ob1" }), (error) => error.status === 400);
});

test("repo slug: the 63-char bound is measured after trimming", () => {
  const at = "x".repeat(63);
  assert.equal(validateRepoSlug(`  ${at}  `), at);
  assert.throws(() => validateRepoSlug(`  ${"x".repeat(64)}  `), (error) => error.status === 400);
});

// The invariant the rest of the module leans on: whatever comes back is safe to
// concatenate into a brain slug. Stated as a property so a future loosening of
// the pattern has to break this test to land.
test("repo slug: every accepted value is DNS-safe and interpolation-safe", () => {
  const corpus = [
    "ob1", "a", "a1", "1a", "a-b", "x".repeat(63), "  ob1  ", "0-9-a",
    "OB1", "", "-a", "a-", "a_b", "a b", "a.b", "repo:a", "a/b", "a\\b",
    "a'b", 'a"b', "a`b", "a;b", "a$b", "a\nb", "aéb", "x".repeat(64),
    null, undefined, 0, 1, true, false, {}, [], () => "ob1",
  ];

  for (const candidate of corpus) {
    let accepted;
    try {
      accepted = validateRepoSlug(candidate);
    } catch (error) {
      assert.equal(error.status, 400, `rejection must be a 400 for ${JSON.stringify(candidate)}`);
      continue;
    }

    const why = `accepted ${JSON.stringify(candidate)} as ${JSON.stringify(accepted)}`;
    assert.equal(typeof accepted, "string", why);
    assert.match(accepted, /^[a-z0-9-]+$/, why);
    assert.ok(accepted.length >= 1 && accepted.length <= 63, why);
    assert.ok(!accepted.startsWith("-") && !accepted.endsWith("-"), why);
    assert.equal(accepted.trim(), accepted, why);
  }
});

// A /g regex would carry lastIndex between calls and start returning false for
// valid slugs on alternate invocations.
test("repo slug: the pattern is anchored and stateless", () => {
  const { REPO_SLUG_PATTERN } = __testables;
  assert.equal(REPO_SLUG_PATTERN.global, false);
  assert.equal(REPO_SLUG_PATTERN.source.startsWith("^"), true);
  assert.equal(REPO_SLUG_PATTERN.source.endsWith("$"), true);

  for (let i = 0; i < 5; i += 1) {
    assert.equal(validateRepoSlug("system-config"), "system-config");
  }
});

// --------------------------------------------------------------------------
// display_name
//
// Unlike repo_slug, the display name is free text an operator will later read
// out of the brains table and out of tool output, so the invariants are about
// what it must NOT be able to do there: no unbounded length, and no control
// characters that could rewrite a terminal line or hide a second brain name.
//
// These run against whatever sanitizer repo-key-minting.mjs exposes. Until that
// helper is exported the handler's only display-name handling is an inline
// trim inside a transactional body, which cannot be reached without Postgres.
// --------------------------------------------------------------------------

const sanitizeDisplayName = __testables.sanitizeDisplayName ?? __testables.normalizeDisplayName ?? null;
const displayNameSkip = sanitizeDisplayName
  ? false
  : "repo-key-minting.mjs exports no display-name sanitizer (expected __testables.sanitizeDisplayName)";

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

test("display_name: output is always bounded and control-character free", { skip: displayNameSkip }, () => {
  const corpus = [
    "OB1",
    "  padded  ",
    "x".repeat(500),
    "x".repeat(128),
    "x".repeat(129),
    "line\nbreak",
    "carriage\rreturn",
    "tab\tseparated",
    "bell\u0007",
    "escape\u001b[31mred",           // an ANSI sequence must not survive into operator output
    "nul\u0000byte",
    "\u200bzero width",
    "",
    "   ",
    "\u00e9moji ok? \u2705",         // non-ASCII that is NOT a control char may pass through
    null,
    undefined,
    42,
    {},
    [],
  ];

  for (const candidate of corpus) {
    let result;
    try {
      result = sanitizeDisplayName(candidate);
    } catch (error) {
      // Rejecting is an acceptable answer, as long as it is a 400 and not a 500.
      assert.equal(error.status, 400, `rejection must be a 400 for ${JSON.stringify(candidate)}`);
      continue;
    }

    const why = `sanitized ${JSON.stringify(candidate)} to ${JSON.stringify(result)}`;
    assert.equal(typeof result, "string", why);
    assert.ok(result.length <= 128, why);
    assert.doesNotMatch(result, CONTROL_CHARS, why);
    assert.equal(result.trim(), result, why);
  }
});

test("display_name: a name with printable content is never emptied", { skip: displayNameSkip }, () => {
  // Stripping control characters must not be able to turn a real name into a
  // blank brain label; the fallback belongs somewhere, whether here or in the
  // caller, but the printable characters themselves must survive.
  for (const candidate of ["OB1\u0007", "  system-config  ", "a\nb"]) {
    const result = sanitizeDisplayName(candidate);
    if (typeof result === "string" && result.length > 0) {
      continue;
    }
    assert.fail(`sanitizer emptied ${JSON.stringify(candidate)} to ${JSON.stringify(result)}`);
  }
});

test("display_name: an ordinary name survives untouched", { skip: displayNameSkip }, () => {
  assert.equal(sanitizeDisplayName("Repo brain: system-config"), "Repo brain: system-config");
});
