import test from "node:test";
import assert from "node:assert/strict";
import * as minting from "../src/repo-key-minting.mjs";

// mint_agent_key / rotate_agent_key (0.8.0) issue a STRICTLY WIDER credential
// than mint_repo_key: the caged agent's principal is a member of the repo brain
// AND of the shared cross-repo agent brain. That makes the capability gate the
// single thing standing between "a key that reads one repo" and "a key that
// writes a brain every repo can read", so it is tested the same way the repo
// gate is — as a pure function of the access context, no database.
//
// Everything here is DB-FREE by construction. The denied-shape tests deliberately
// pass a householdId that exists in no database, so a gate that failed open could
// not create a row even if it reached Postgres: it would surface as a foreign-key
// error, which is not a 403, which fails the test.

const { validateRepoSlug, requireMintCapability } = minting.__testables;

// A syntactically valid household uuid that is not in any database.
const ABSENT_HOUSEHOLD = "00000000-0000-4000-8000-0000000000cc";

const handleMintAgentKey = typeof minting.handleMintAgentKey === "function" ? minting.handleMintAgentKey : null;
const handleRotateAgentKey = typeof minting.handleRotateAgentKey === "function" ? minting.handleRotateAgentKey : null;

const agentHandlerSkip = handleMintAgentKey && handleRotateAgentKey
  ? false
  : "repo-key-minting.mjs exports no agent-key handlers yet (expected handleMintAgentKey / handleRotateAgentKey)";

const agentHandlers = [
  ["mint_agent_key", handleMintAgentKey],
  ["rotate_agent_key", handleRotateAgentKey],
];

// The caller shapes auth.mjs actually builds, named as an operator would name
// them. Not one of these may mint an agent key: `canMintRepoKeys` is set to true
// only for the operator-provisioned minter key.
const DENIED_CALLERS = [
  ["repo key (claude/codex harness)", {
    kind: "service_key",
    principalId: "11111111-1111-4111-8111-111111111111",
    principalType: "repo_service",
    isAdmin: false,
    canMintRepoKeys: false,
    readEgressClass: "cloud_bound",
  }],
  ["caged agent key (pi escalating from inside the cage)", {
    kind: "service_key",
    principalId: "22222222-2222-4222-8222-222222222222",
    principalType: "caged_agent",
    isAdmin: false,
    canMintRepoKeys: false,
    readEgressClass: "cloud_bound",
  }],
  ["legacy admin secret (MCP_ACCESS_KEY)", {
    kind: "legacy_admin_key",
    principalId: null,
    isAdmin: true,
    readEgressClass: "cloud_bound",
  }],
  ["stored admin key", {
    kind: "service_key",
    principalId: "33333333-3333-4333-8333-333333333333",
    isAdmin: true,
    canMintRepoKeys: false,
    readEgressClass: "local_trusted",
  }],
  ["human token", {
    kind: "human_token",
    principalId: "44444444-4444-4444-8444-444444444444",
    isAdmin: false,
    readEgressClass: "cloud_bound",
  }],
];

function contextFor(caller, { householdId = ABSENT_HOUSEHOLD } = {}) {
  return { householdId, principalId: caller.principalId ?? null, _policy: { caller } };
}

const MINTER = {
  kind: "service_key",
  principalId: "55555555-5555-4555-8555-555555555555",
  principalType: "repo_service",
  isAdmin: false,
  canMintRepoKeys: true,
  readEgressClass: "cloud_bound",
};

// --------------------------------------------------------------------------
// Capability gate
// --------------------------------------------------------------------------

test("agent-key handlers: every real caller shape without the capability gets 403", { skip: agentHandlerSkip }, async () => {
  for (const [toolName, handler] of agentHandlers) {
    for (const [label, caller] of DENIED_CALLERS) {
      await assert.rejects(
        () => handler({ repo_slug: "ob1" }, contextFor(caller)),
        (error) => error.status === 403,
        `${toolName} must 403 for ${label}`,
      );
    }
  }
});

// The household is present in these contexts, so a 403 can only have come from
// the capability check — the "not homed in an estate" refusal is unreachable.
test("agent-key handlers: fail closed for every non-true capability shape", { skip: agentHandlerSkip }, async () => {
  const shapes = [
    ["absent", {}],
    ["false", { canMintRepoKeys: false }],
    ["truthy string", { canMintRepoKeys: "true" }],
    ["truthy number", { canMintRepoKeys: 1 }],
    ["boxed Boolean", { canMintRepoKeys: new Boolean(true) }],
    ["array-wrapped", { canMintRepoKeys: [true] }],
    ["column spelling", { can_mint_repo_keys: true }],
  ];

  for (const [toolName, handler] of agentHandlers) {
    for (const [label, caller] of shapes) {
      await assert.rejects(
        () => handler({ repo_slug: "ob1" }, contextFor(caller)),
        (error) => error.status === 403,
        `${toolName} must 403 when the capability is ${label}`,
      );
    }
    // The capability parked anywhere other than _policy.caller is not the
    // capability.
    for (const ctx of [
      { householdId: ABSENT_HOUSEHOLD, canMintRepoKeys: true },
      { householdId: ABSENT_HOUSEHOLD, caller: { canMintRepoKeys: true } },
      { householdId: ABSENT_HOUSEHOLD, _policy: {} },
      { householdId: ABSENT_HOUSEHOLD },
      {},
      null,
      undefined,
    ]) {
      await assert.rejects(
        () => handler({ repo_slug: "ob1" }, ctx),
        (error) => error.status === 403,
        `${toolName} must 403 for ${JSON.stringify(ctx)}`,
      );
    }
  }
});

// The mirror of the tests above: they would all pass if the handler threw 403
// unconditionally. This proves the minter capability is the thing being read —
// the refusal a real minter hits is the estate check, not the capability one.
test("agent-key handlers: the minter capability passes the gate (stopped later, elsewhere)", { skip: agentHandlerSkip }, async () => {
  for (const [toolName, handler] of agentHandlers) {
    await assert.rejects(
      () => handler({ repo_slug: "ob1" }, { _policy: { caller: MINTER } }),
      (error) => error.status === 403 && !/not authorized/i.test(error.message),
      `${toolName} must refuse a brain-less minter for a reason other than the capability`,
    );
  }
});

// The agent handlers share one capability with the repo handlers by design
// (docs/53: can_mint_repo_keys creates repo brains, repo keys and agent keys and
// nothing else). If a separate capability is ever introduced, this breaks.
test("agent-key handlers: the gate is the shared requireMintCapability", { skip: agentHandlerSkip }, () => {
  assert.doesNotThrow(() => requireMintCapability({ _policy: { caller: MINTER } }));
  assert.throws(
    () => requireMintCapability(contextFor(DENIED_CALLERS[0][1])),
    (error) => error.status === 403,
  );
});

// --------------------------------------------------------------------------
// Slug validation
//
// The slug is concatenated into 'repo:<slug>' and 'pi:<slug>' and becomes a row
// identity, exactly as on the repo path. These run through the HANDLER (not the
// helper) so a new code path that forgot to validate cannot pass: the context
// carries both the capability and a household, so nothing else can reject first.
// --------------------------------------------------------------------------

const MINTER_CONTEXT = contextFor(MINTER);

test("agent-key handlers: a non-DNS-safe slug is a 400 before any database work", { skip: agentHandlerSkip }, async () => {
  const bad = [
    "", "-lead", "trail-", "OB1", "under_score", "with space", "dot.separated",
    "repo:ob1", "pi:ob1", "x".repeat(64), "a/../b", "a'; drop table brains; --",
    "ob1\nsystem-config", "ob1\u200bsc", "\u043eb1", "ob1\u0000",
    null, undefined, 42, {}, [],
  ];

  for (const [toolName, handler] of agentHandlers) {
    for (const slug of bad) {
      await assert.rejects(
        () => handler({ repo_slug: slug }, MINTER_CONTEXT),
        (error) => error.status === 400,
        `${toolName} must 400 for ${JSON.stringify(slug)}`,
      );
    }
  }
});

test("agent-key handlers: a missing repo_slug is a 400, not a crash", { skip: agentHandlerSkip }, async () => {
  for (const [toolName, handler] of agentHandlers) {
    for (const args of [{}, null, undefined, { repo_slug: null }]) {
      await assert.rejects(
        () => handler(args, MINTER_CONTEXT),
        (error) => error.status === 400,
        `${toolName} must 400 for args ${JSON.stringify(args)}`,
      );
    }
  }
});

// The shared validator itself must keep the guarantee the agent path now also
// depends on: whatever it returns is safe to interpolate into a principal slug.
test("agent-key path: the shared slug validator still returns interpolation-safe output", () => {
  for (const slug of ["ob1", "system-config", "wingman-ios", "a", "x".repeat(63), "  ob1  "]) {
    const accepted = validateRepoSlug(slug);
    assert.match(accepted, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    assert.ok(accepted.length <= 63);
  }
});

// --------------------------------------------------------------------------
// Managed principal / credential types
//
// The agent path writes principal_type = 'caged_agent' and credential_type =
// 'agent_key'. Neither column has a CHECK constraint, so these assertions are
// the only thing that keeps an argument-derived string out of them.
// --------------------------------------------------------------------------

const assertManagedPrincipalType = minting.__testables.assertManagedPrincipalType ?? null;
const assertManagedCredentialType = minting.__testables.assertManagedCredentialType ?? null;
const managedTypeSkip = assertManagedPrincipalType && assertManagedCredentialType
  ? false
  : "repo-key-minting.mjs does not expose the managed-type assertions (expected __testables.assertManagedPrincipalType / assertManagedCredentialType)";

test("managed types: only the module's own literals are writable", { skip: managedTypeSkip }, () => {
  assert.equal(assertManagedPrincipalType("repo_service"), "repo_service");
  assert.equal(assertManagedPrincipalType("caged_agent"), "caged_agent");
  assert.equal(assertManagedCredentialType("repo_key"), "repo_key");
  assert.equal(assertManagedCredentialType("agent_key"), "agent_key");
});

test("managed types: anything else throws rather than reaching a column", { skip: managedTypeSkip }, () => {
  const rejected = [
    "person", "human", "admin", "admin_key", "service_key", "legacy_admin_key",
    "", " repo_service", "repo_service ", "REPO_SERVICE", "caged_agent'",
    "__proto__", "constructor", "toString", "hasOwnProperty",
    null, undefined, 0, 1, true, {}, [], new String("caged_agent"),
  ];

  const isError = (error) => error instanceof Error;
  for (const value of rejected) {
    assert.throws(() => assertManagedPrincipalType(value), isError, `principal_type ${JSON.stringify(value)}`);
    assert.throws(() => assertManagedCredentialType(value), isError, `credential_type ${JSON.stringify(value)}`);
  }
});

// The two namespaces must not overlap: a repo key and an agent key on the same
// repo are two principals, and an operator reading brain_principals has only the
// slug prefix to tell them apart.
const prefixes = minting.__testables;
const prefixSkip = prefixes.PRINCIPAL_SLUG_PREFIX && prefixes.AGENT_PRINCIPAL_SLUG_PREFIX
  ? false
  : "repo-key-minting.mjs does not expose the principal slug prefixes (expected __testables.PRINCIPAL_SLUG_PREFIX / AGENT_PRINCIPAL_SLUG_PREFIX)";

test("principal namespaces: the agent prefix is distinct and never a prefix of the other", { skip: prefixSkip }, () => {
  const repo = prefixes.PRINCIPAL_SLUG_PREFIX;
  const agent = prefixes.AGENT_PRINCIPAL_SLUG_PREFIX;
  assert.notEqual(repo, agent);
  assert.ok(!repo.startsWith(agent) && !agent.startsWith(repo), "one prefix must not be a prefix of the other");
  // Both must be rejected by the slug validator, so a caller cannot pass a
  // fully-qualified principal slug as a repo name and land in the other namespace.
  for (const prefix of [repo, agent]) {
    assert.throws(() => validateRepoSlug(`${prefix}ob1`), (error) => error.status === 400);
  }
});
