import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTIONS,
  CALLER_KINDS,
  VERDICTS,
  DENY_REASONS,
  BRAIN_EGRESS_CLASS,
  CALLER_EGRESS_CLASS,
  isBrainUuid,
  authorizeAction,
  deriveScope,
  resolveSelector,
  resolveSelectorGlobal,
  detectSelectorConflict,
  planReadFanout,
} from "../src/access-policy.mjs";

// Action order used by every hand-authored expectation row below.
const ACTION_ORDER = [ACTIONS.READ, ACTIONS.WRITE, ACTIONS.DELETE, ACTIONS.RESTORE, ACTIONS.PURGE];

// A=allow, .=deny — readable five-char strings, one char per action in
// ACTION_ORDER. These are HAND-AUTHORED from ADR-0002/ADR-0003, never computed
// by calling the policy. A self-deriving table would only prove the code agrees
// with itself.
function expectRow(str) {
  assert.equal(str.length, ACTION_ORDER.length, `bad expectation literal: ${str}`);
  return [...str].map((ch) => {
    if (ch === "A") return true;
    if (ch === ".") return false;
    throw new Error(`expectation chars must be 'A' or '.', got '${ch}'`);
  });
}

// --------------------------------------------------------------------------
// Exhaustive principal table: brain role × estate role × action.
//
// A principal is a non-admin caller (human token or non-admin service key).
// Capability is the additive (OR) max of the brain-role and estate-role
// ladders; a brain DENY clamps everything; estate `member` is read-only;
// nothing but a named admin service key may purge.
// --------------------------------------------------------------------------

// brain membership values, including "deny" and "none"
const B = { none: null, viewer: { role: "viewer", isDeny: false }, editor: { role: "editor", isDeny: false }, owner: { role: "owner", isDeny: false }, deny: { role: "owner", isDeny: true } };
// estate membership values, including a deny-row (treated as absent) and "none"
const E = { none: null, member: { role: "member", isDeny: false }, admin: { role: "admin", isDeny: false }, denyrow: { role: "member", isDeny: true } };

//                                            read write del restore purge
const PRINCIPAL_TABLE = [
  { brain: "none",   estate: "none",    expect: "....." },
  { brain: "none",   estate: "member",  expect: "A...." },
  { brain: "none",   estate: "admin",   expect: "AAAA." },
  { brain: "none",   estate: "denyrow", expect: "....." },

  { brain: "viewer", estate: "none",    expect: "A...." },
  { brain: "viewer", estate: "member",  expect: "A...." },
  { brain: "viewer", estate: "admin",   expect: "AAAA." },
  { brain: "viewer", estate: "denyrow", expect: "A...." },

  { brain: "editor", estate: "none",    expect: "AA..." },
  { brain: "editor", estate: "member",  expect: "AA..." },
  { brain: "editor", estate: "admin",   expect: "AAAA." },
  { brain: "editor", estate: "denyrow", expect: "AA..." },

  { brain: "owner",  estate: "none",    expect: "AAAA." },
  { brain: "owner",  estate: "member",  expect: "AAAA." },
  { brain: "owner",  estate: "admin",   expect: "AAAA." },
  { brain: "owner",  estate: "denyrow", expect: "AAAA." },

  { brain: "deny",   estate: "none",    expect: "....." },
  { brain: "deny",   estate: "member",  expect: "....." },
  { brain: "deny",   estate: "admin",   expect: "....." },
  { brain: "deny",   estate: "denyrow", expect: "....." },
];

for (const kind of [CALLER_KINDS.HUMAN_TOKEN, CALLER_KINDS.SERVICE_KEY]) {
  for (const row of PRINCIPAL_TABLE) {
    const expected = expectRow(row.expect);
    test(`principal[${kind}] brain=${row.brain} estate=${row.estate}`, () => {
      const caller = { kind, principalId: "p-1", isAdmin: false, homeEstateId: "est-home" };
      ACTION_ORDER.forEach((action, i) => {
        const verdict = authorizeAction({
          caller,
          action,
          brainMembership: B[row.brain],
          estateMembership: E[row.estate],
        });
        const got = verdict.kind === VERDICTS.ALLOW;
        assert.equal(got, expected[i], `${action}: expected ${expected[i] ? "allow" : "denied"}, got ${verdict.kind}`);
        if (got) {
          assert.deepEqual(verdict.actor, { auth_source: kind, principal_id: "p-1", is_admin: false });
        }
      });
    });
  }
}

// --------------------------------------------------------------------------
// Stored admin service key: full CRUD + purge within reach; estate-independent;
// only a brain DENY on its own principal clamps it (ADR-0002 "overrides
// everything"). Hand-authored per brain role.
// --------------------------------------------------------------------------

//                                read write del restore purge
const ADMIN_TABLE = [
  { brain: "none",   expect: "AAAAA" },
  { brain: "viewer", expect: "AAAAA" },
  { brain: "editor", expect: "AAAAA" },
  { brain: "owner",  expect: "AAAAA" },
  { brain: "deny",   expect: "....." },
];

for (const row of ADMIN_TABLE) {
  const expected = expectRow(row.expect);
  test(`admin-service-key brain=${row.brain}`, () => {
    const caller = { kind: CALLER_KINDS.SERVICE_KEY, principalId: "p-admin", isAdmin: true, homeEstateId: "est-home" };
    ACTION_ORDER.forEach((action, i) => {
      const verdict = authorizeAction({ caller, action, brainMembership: B[row.brain], estateMembership: null });
      const got = verdict.kind === VERDICTS.ALLOW;
      assert.equal(got, expected[i], `${action}: expected ${expected[i] ? "allow" : "denied"}, got ${verdict.kind}`);
      if (got) {
        assert.deepEqual(verdict.actor, { auth_source: CALLER_KINDS.SERVICE_KEY, principal_id: "p-admin", is_admin: true });
      }
    });
  });
}

// --------------------------------------------------------------------------
// Legacy env key: global reach, full CRUD, NEVER purge (unattributable, D9).
// principalId is null; it carries no memberships.
// --------------------------------------------------------------------------

test("legacy-admin-key: full CRUD, purge denied", () => {
  const caller = { kind: CALLER_KINDS.LEGACY_ADMIN_KEY, principalId: null, isAdmin: true, homeEstateId: null };
  const expected = expectRow("AAAA."); // read write delete restore purge
  ACTION_ORDER.forEach((action, i) => {
    const verdict = authorizeAction({ caller, action });
    const got = verdict.kind === VERDICTS.ALLOW;
    assert.equal(got, expected[i], `${action}: expected ${expected[i] ? "allow" : "denied"}`);
    if (got) {
      assert.deepEqual(verdict.actor, { auth_source: CALLER_KINDS.LEGACY_ADMIN_KEY, principal_id: null, is_admin: true });
    }
  });
});

// --------------------------------------------------------------------------
// Edge case: an is_admin flag without the service-key shape cannot purge.
// (A purge gate keyed on isAdmin alone would wrongly allow this.)
// --------------------------------------------------------------------------

test("admin flag without service-key shape: purge denied, CRUD allowed", () => {
  // Human token that somehow carries isAdmin: still not a NAMED admin service key.
  const caller = { kind: CALLER_KINDS.HUMAN_TOKEN, principalId: "p-1", isAdmin: true, homeEstateId: "est-home" };
  assert.equal(authorizeAction({ caller, action: ACTIONS.PURGE }).kind, VERDICTS.DENIED);
  assert.equal(authorizeAction({ caller, action: ACTIONS.DELETE }).kind, VERDICTS.ALLOW);
});

test("admin service key with null principal: purge denied (unattributable)", () => {
  const caller = { kind: CALLER_KINDS.SERVICE_KEY, principalId: null, isAdmin: true, homeEstateId: "est-home" };
  assert.equal(authorizeAction({ caller, action: ACTIONS.PURGE }).kind, VERDICTS.DENIED);
});

test("authorizeAction throws on unknown action (programmer error, not a verdict)", () => {
  const caller = { kind: CALLER_KINDS.SERVICE_KEY, principalId: "p-1", isAdmin: false };
  assert.throws(() => authorizeAction({ caller, action: "frobnicate" }), /Unknown action/);
});

// --------------------------------------------------------------------------
// isBrainUuid
// --------------------------------------------------------------------------

test("isBrainUuid distinguishes UUIDs from slugs", () => {
  assert.equal(isBrainUuid("11111111-2222-3333-4444-555555555555"), true);
  assert.equal(isBrainUuid("ob1"), false);
  assert.equal(isBrainUuid("common"), false);
  assert.equal(isBrainUuid(""), false);
  assert.equal(isBrainUuid(null), false);
});

// --------------------------------------------------------------------------
// Fixtures for scope / selector scenarios
// --------------------------------------------------------------------------

const EST_AGENT = "est-agent";
const EST_SPOUSE = "est-spouse";
const EST_OTHER = "est-other";

// brainIds are real UUIDs so the UUID-vs-slug selector path is exercised faithfully.
const BRAIN = {
  ob1:    { brainId: "0b100000-0000-4000-8000-000000000001", brainSlug: "ob1",    estateId: EST_AGENT },
  common: { brainId: "0b100000-0000-4000-8000-000000000002", brainSlug: "common", estateId: EST_AGENT },
  secret: { brainId: "0b100000-0000-4000-8000-000000000003", brainSlug: "secret", estateId: EST_AGENT },
  spouse: { brainId: "0b100000-0000-4000-8000-000000000004", brainSlug: "spouse", estateId: EST_SPOUSE },
  other:  { brainId: "0b100000-0000-4000-8000-000000000005", brainSlug: "ext",    estateId: EST_OTHER },
};

// --------------------------------------------------------------------------
// Scenario: spouse privacy (ADR-0001 founding property).
// The operator is estate-admin on the agent estate and has NO relationship with
// the spouse estate. The spouse brain must be neither usable nor nameable.
// --------------------------------------------------------------------------

test("scenario: spouse privacy — spouse brain is not nameable by slug (404)", () => {
  const caller = { kind: CALLER_KINDS.HUMAN_TOKEN, principalId: "p-op", isAdmin: false, homeEstateId: EST_AGENT };
  const scope = deriveScope({
    caller,
    brainMemberships: [],
    estateMemberships: [{ estateId: EST_AGENT, role: "admin", isDeny: false }],
    catalog: [BRAIN.ob1, BRAIN.common, BRAIN.spouse],
  });
  // agent brains are in scope; spouse is not
  assert.equal(scope.accessibleIds.has(BRAIN.ob1.brainId), true);
  assert.equal(scope.accessibleIds.has(BRAIN.spouse.brainId), false);

  assert.equal(resolveSelector({ selector: "spouse", scope }).kind, VERDICTS.NOT_FOUND);
});

test("scenario: spouse privacy — spouse brain UUID is 403, not 404, when the UUID is known to exist", () => {
  const caller = { kind: CALLER_KINDS.HUMAN_TOKEN, principalId: "p-op", isAdmin: false, homeEstateId: EST_AGENT };
  const scope = deriveScope({
    caller,
    brainMemberships: [],
    estateMemberships: [{ estateId: EST_AGENT, role: "admin", isDeny: false }],
    catalog: [BRAIN.ob1, BRAIN.spouse],
  });
  const verdict = resolveSelector({ selector: BRAIN.spouse.brainId, scope, existsGlobally: true });
  assert.equal(verdict.kind, VERDICTS.DENIED);
});

// --------------------------------------------------------------------------
// Scenario: operator visibility — estate admin reaches and may act on all
// estate brains.
// --------------------------------------------------------------------------

test("scenario: operator visibility — estate admin resolves and may delete an estate brain", () => {
  const caller = { kind: CALLER_KINDS.HUMAN_TOKEN, principalId: "p-op", isAdmin: false, homeEstateId: EST_AGENT };
  const estateMemberships = [{ estateId: EST_AGENT, role: "admin", isDeny: false }];
  const scope = deriveScope({ caller, brainMemberships: [], estateMemberships, catalog: [BRAIN.ob1, BRAIN.common] });

  const resolvedV = resolveSelector({ selector: "common", scope });
  assert.equal(resolvedV.kind, VERDICTS.RESOLVED);
  assert.equal(resolvedV.brain.brainId, BRAIN.common.brainId);

  // estate admin → delete allowed
  const del = authorizeAction({ caller, action: ACTIONS.DELETE, brainMembership: null, estateMembership: estateMemberships[0] });
  assert.equal(del.kind, VERDICTS.ALLOW);
});

// --------------------------------------------------------------------------
// Scenario: brain-level DENY overrides an estate ALLOW.
// The principal is an estate MEMBER (reads all estate brains) but has an
// explicit brain DENY on `secret`. `secret` must be nameable (resolve-then-403)
// yet not usable.
// --------------------------------------------------------------------------

test("scenario: deny override — estate member + brain DENY ⇒ nameable but denied", () => {
  const caller = { kind: CALLER_KINDS.SERVICE_KEY, principalId: "p-m", isAdmin: false, homeEstateId: EST_AGENT };
  const brainMemberships = [{ brainId: BRAIN.secret.brainId, role: "owner", isDeny: true }];
  const estateMemberships = [{ estateId: EST_AGENT, role: "member", isDeny: false }];
  const scope = deriveScope({ caller, brainMemberships, estateMemberships, catalog: [BRAIN.ob1, BRAIN.secret] });

  // nameable (in lookup) but not accessible
  assert.equal(scope.accessibleIds.has(BRAIN.secret.brainId), false);
  assert.equal(scope.lookup.some((b) => b.brainId === BRAIN.secret.brainId), true);

  // selector resolves-then-denies, not 404
  assert.equal(resolveSelector({ selector: "secret", scope }).kind, VERDICTS.DENIED);

  // and the action itself is denied by the DENY override even though estate allows read
  const read = authorizeAction({
    caller,
    action: ACTIONS.READ,
    brainMembership: brainMemberships[0],
    estateMembership: estateMemberships[0],
  });
  assert.equal(read.kind, VERDICTS.DENIED);
  assert.equal(read.reason, "brain_deny");
});

// --------------------------------------------------------------------------
// Scenario: pure brain DENY with no other grant ⇒ NOT nameable (404), not 403.
// --------------------------------------------------------------------------

test("scenario: pure brain DENY (no estate grant) ⇒ not nameable (404)", () => {
  const caller = { kind: CALLER_KINDS.SERVICE_KEY, principalId: "p-x", isAdmin: false, homeEstateId: EST_AGENT };
  const brainMemberships = [{ brainId: BRAIN.secret.brainId, role: "owner", isDeny: true }];
  const scope = deriveScope({ caller, brainMemberships, estateMemberships: [], catalog: [BRAIN.secret] });
  assert.equal(scope.lookup.length, 0);
  assert.equal(resolveSelector({ selector: "secret", scope }).kind, VERDICTS.NOT_FOUND);
});

// --------------------------------------------------------------------------
// Scenario: ADR-0003 admin reach — home-estate brains are reachable without a
// membership row; cross-estate membership brains widen reach; estates with
// neither home nor membership remain out of reach.
// --------------------------------------------------------------------------

test("scenario: ADR-0003 — admin key reaches home estate ∪ membership, nothing else", () => {
  const caller = { kind: CALLER_KINDS.SERVICE_KEY, principalId: "p-admin", isAdmin: true, homeEstateId: EST_AGENT };
  const scope = deriveScope({
    caller,
    // an explicit owner membership on a brain in ANOTHER estate widens reach
    brainMemberships: [{ brainId: BRAIN.other.brainId, role: "owner", isDeny: false }],
    estateMemberships: [],
    catalog: [BRAIN.ob1, BRAIN.common, BRAIN.other, BRAIN.spouse],
  });

  // home-estate brains: reachable with no membership row
  assert.equal(resolveSelector({ selector: "ob1", scope }).kind, VERDICTS.RESOLVED);
  assert.equal(resolveSelector({ selector: "common", scope }).kind, VERDICTS.RESOLVED);
  // cross-estate membership brain: reachable
  assert.equal(resolveSelector({ selector: "ext", scope }).kind, VERDICTS.RESOLVED);
  // unrelated estate (no home, no membership): not nameable
  assert.equal(resolveSelector({ selector: "spouse", scope }).kind, VERDICTS.NOT_FOUND);
});

test("scenario: ADR-0003 — admin estate deny-row does not block the admin", () => {
  // Even with an estate deny-row, the admin key still reaches its home estate
  // and acts. (estate deny-row = absent membership; admin reach is estate-based.)
  const caller = { kind: CALLER_KINDS.SERVICE_KEY, principalId: "p-admin", isAdmin: true, homeEstateId: EST_AGENT };
  const verdict = authorizeAction({
    caller,
    action: ACTIONS.READ,
    brainMembership: null,
    estateMembership: { estateId: EST_AGENT, role: "member", isDeny: true },
  });
  assert.equal(verdict.kind, VERDICTS.ALLOW);
});

// --------------------------------------------------------------------------
// Scenario: legacy blast radius — global resolution, ambiguity, full CRUD,
// no purge.
// --------------------------------------------------------------------------

test("scenario: legacy key resolves slugs globally; ambiguous when >1 match", () => {
  assert.equal(resolveSelectorGlobal({ candidates: [BRAIN.ob1] }).kind, VERDICTS.RESOLVED);
  assert.equal(resolveSelectorGlobal({ candidates: [] }).kind, VERDICTS.NOT_FOUND);
  assert.equal(resolveSelectorGlobal({ candidates: [BRAIN.ob1, BRAIN.common] }).kind, VERDICTS.AMBIGUOUS);
});

// --------------------------------------------------------------------------
// Selector resolution edge cases
// --------------------------------------------------------------------------

test("resolveSelector: in-scope UUID resolves; out-of-scope unknown UUID is not_found", () => {
  const caller = { kind: CALLER_KINDS.SERVICE_KEY, principalId: "p-1", isAdmin: false, homeEstateId: EST_AGENT };
  const scope = deriveScope({
    caller,
    brainMemberships: [{ brainId: BRAIN.ob1.brainId, role: "viewer", isDeny: false }],
    estateMemberships: [],
    catalog: [BRAIN.ob1],
  });
  assert.equal(resolveSelector({ selector: BRAIN.ob1.brainId, scope }).kind, VERDICTS.RESOLVED);
  // a syntactically valid UUID that doesn't exist anywhere
  assert.equal(
    resolveSelector({ selector: "99999999-8888-7777-6666-555555555555", scope, existsGlobally: false }).kind,
    VERDICTS.NOT_FOUND,
  );
});

test("resolveSelector: ambiguous slug across two different brains", () => {
  const caller = { kind: CALLER_KINDS.SERVICE_KEY, principalId: "p-1", isAdmin: false, homeEstateId: EST_AGENT };
  // two distinct brains both nameable, same slug
  const dupA = { brainId: "0b1d0000-0000-4000-8000-00000000000a", brainSlug: "dup", estateId: EST_AGENT };
  const dupB = { brainId: "0b1d0000-0000-4000-8000-00000000000b", brainSlug: "dup", estateId: EST_AGENT };
  const scope = deriveScope({
    caller,
    brainMemberships: [
      { brainId: dupA.brainId, role: "viewer", isDeny: false },
      { brainId: dupB.brainId, role: "viewer", isDeny: false },
    ],
    estateMemberships: [],
    catalog: [dupA, dupB],
  });
  assert.equal(resolveSelector({ selector: "dup", scope }).kind, VERDICTS.AMBIGUOUS);
});

test("resolveSelector: a catalog listing the same brain twice is NOT ambiguous", () => {
  const caller = { kind: CALLER_KINDS.SERVICE_KEY, principalId: "p-1", isAdmin: false, homeEstateId: EST_AGENT };
  const scope = deriveScope({
    caller,
    brainMemberships: [{ brainId: BRAIN.ob1.brainId, role: "viewer", isDeny: false }],
    estateMemberships: [],
    catalog: [BRAIN.ob1, BRAIN.ob1], // duplicated row
  });
  assert.equal(resolveSelector({ selector: "ob1", scope }).kind, VERDICTS.RESOLVED);
});

// --------------------------------------------------------------------------
// Selector conflict (v24 D3)
// --------------------------------------------------------------------------

test("detectSelectorConflict: differing brains conflict; matching or missing do not", () => {
  assert.equal(detectSelectorConflict({ brainId: "a" }, { brainId: "b" }).kind, VERDICTS.SELECTOR_CONFLICT);
  assert.equal(detectSelectorConflict({ brainId: "a" }, { brainId: "a" }), null);
  assert.equal(detectSelectorConflict({ brainId: "a" }, null), null);
  assert.equal(detectSelectorConflict(null, { brainId: "b" }), null);
  assert.equal(detectSelectorConflict(null, null), null);
});

// --------------------------------------------------------------------------
// Read fanout (v24 D4/D6)
// --------------------------------------------------------------------------

test("planReadFanout: explicit selector narrows to one brain", () => {
  const caller = { kind: CALLER_KINDS.SERVICE_KEY, principalId: "p-1", isAdmin: false };
  const scope = { accessible: [BRAIN.ob1, BRAIN.common], accessibleIds: new Set(), lookup: [] };
  const out = planReadFanout({ caller, scope, explicitBrain: BRAIN.common, effectiveBrain: BRAIN.ob1 });
  assert.deepEqual(out, [{ brainId: BRAIN.common.brainId, brainSlug: "common" }]);
});

// fanout output is normalized to the canonical {brainId, brainSlug} ref shape
// (no estateId leakage), matching every other brain ref the module emits.
const ref = (b) => ({ brainId: b.brainId, brainSlug: b.brainSlug });

test("planReadFanout: unscoped read fans out across all accessible brains", () => {
  const caller = { kind: CALLER_KINDS.SERVICE_KEY, principalId: "p-1", isAdmin: false };
  const scope = { accessible: [BRAIN.ob1, BRAIN.common], accessibleIds: new Set(), lookup: [] };
  const out = planReadFanout({ caller, scope, explicitBrain: null, effectiveBrain: BRAIN.ob1 });
  assert.deepEqual(out, [ref(BRAIN.ob1), ref(BRAIN.common)]);
});

test("planReadFanout: legacy key reads only its single effective brain", () => {
  const caller = { kind: CALLER_KINDS.LEGACY_ADMIN_KEY, principalId: null, isAdmin: true };
  const scope = { accessible: [BRAIN.ob1, BRAIN.common], accessibleIds: new Set(), lookup: [] };
  const out = planReadFanout({ caller, scope, explicitBrain: null, effectiveBrain: BRAIN.ob1 });
  assert.deepEqual(out, [ref(BRAIN.ob1)]);
});

test("planReadFanout: empty accessible set falls back to effective brain", () => {
  const caller = { kind: CALLER_KINDS.SERVICE_KEY, principalId: "p-1", isAdmin: false };
  const scope = { accessible: [], accessibleIds: new Set(), lookup: [] };
  const out = planReadFanout({ caller, scope, explicitBrain: null, effectiveBrain: BRAIN.ob1 });
  assert.deepEqual(out, [ref(BRAIN.ob1)]);
});

// Regression (found by live ob1_dev integration, enforce mode): when egress
// strips every accessible brain for a cloud-bound caller, the empty-accessible
// fallback must NOT re-inject the default/effective brain if that brain was the
// thing egress excluded — otherwise the private_local default leaks through the
// unscoped read planes (stats/search/list) that fan out via planReadFanout.
// Suppression is ENFORCE-only.
test("planReadFanout: under enforce, an egress-excluded effective brain is not used as fallback", () => {
  const caller = { kind: CALLER_KINDS.SERVICE_KEY, principalId: "p-1", isAdmin: false };
  const scope = { accessible: [], accessibleIds: new Set(), lookup: [], egressExcluded: [BRAIN.ob1] };
  const out = planReadFanout({ caller, scope, explicitBrain: null, effectiveBrain: BRAIN.ob1, egressMode: "enforce" });
  assert.deepEqual(out, [], "the egress-excluded default brain must not leak back into the fanout under enforce");
});

// Regression C1 (audit, found by adversarial review): OBSERVE must be a
// behavioural no-op. egressExcluded is populated in observe (for logging) but
// planReadFanout must NOT suppress on it — else explicit-brain reads to a
// private_local brain return [] in the DEFAULT (observe) config. The off/observe
// fanout must be byte-identical to pre-egress behaviour.
test("planReadFanout: observe/off does NOT suppress an egress-excluded brain (no-op)", () => {
  const caller = { kind: CALLER_KINDS.SERVICE_KEY, principalId: "p-1", isAdmin: false };
  const scope = { accessible: [], accessibleIds: new Set(), lookup: [], egressExcluded: [BRAIN.ob1] };
  // observe + explicit brain that is "would-be-excluded" → still returned
  assert.deepEqual(
    planReadFanout({ caller, scope, explicitBrain: BRAIN.ob1, effectiveBrain: BRAIN.ob1, egressMode: "observe" }),
    [ref(BRAIN.ob1)],
    "observe must not suppress an explicit brain",
  );
  // observe + empty-accessible fallback to a would-be-excluded brain → still returned
  assert.deepEqual(
    planReadFanout({ caller, scope, explicitBrain: null, effectiveBrain: BRAIN.ob1, egressMode: "observe" }),
    [ref(BRAIN.ob1)],
    "observe must not suppress the fallback brain",
  );
  // off (default) likewise
  assert.deepEqual(
    planReadFanout({ caller, scope, explicitBrain: BRAIN.ob1, effectiveBrain: BRAIN.ob1 }),
    [ref(BRAIN.ob1)],
    "off must not suppress",
  );
});

test("planReadFanout: result does not alias scope.accessible (no shared mutable state)", () => {
  const caller = { kind: CALLER_KINDS.SERVICE_KEY, principalId: "p-1", isAdmin: false };
  const scope = { accessible: [BRAIN.ob1, BRAIN.common], accessibleIds: new Set(), lookup: [] };
  const out = planReadFanout({ caller, scope, explicitBrain: null, effectiveBrain: BRAIN.ob1 });
  out.pop();
  assert.equal(scope.accessible.length, 2, "mutating the result must not shrink scope.accessible");
});

test("planReadFanout: legacy branch normalizes a slugless effective brain to null, not undefined", () => {
  const caller = { kind: CALLER_KINDS.LEGACY_ADMIN_KEY, principalId: null, isAdmin: true };
  const scope = { accessible: [], accessibleIds: new Set(), lookup: [] };
  const out = planReadFanout({ caller, scope, explicitBrain: null, effectiveBrain: { brainId: "b-x" } });
  assert.deepEqual(out, [{ brainId: "b-x", brainSlug: null }]);
});

// --------------------------------------------------------------------------
// Coverage closing the gaps the review flagged: documented asymmetries that
// were asserted in comments/PRD prose but not crossed by a test.
// --------------------------------------------------------------------------

test("resolveSelector: a deny-shadowed brain resolved by its UUID is denied (not 404)", () => {
  // estate member grants the brain into `lookup`; a brain DENY keeps it out of
  // `accessible`. Supplying the UUID must resolve-then-deny via the `shadowed`
  // branch — distinct from the existsGlobally branch.
  const caller = { kind: CALLER_KINDS.SERVICE_KEY, principalId: "p-m", isAdmin: false, homeEstateId: EST_AGENT };
  const scope = deriveScope({
    caller,
    brainMemberships: [{ brainId: BRAIN.secret.brainId, role: "owner", isDeny: true }],
    estateMemberships: [{ estateId: EST_AGENT, role: "member", isDeny: false }],
    catalog: [BRAIN.secret],
  });
  // existsGlobally:false proves the denial comes from `shadowed` (in lookup), not from global existence.
  const verdict = resolveSelector({ selector: BRAIN.secret.brainId, scope, existsGlobally: false });
  assert.equal(verdict.kind, VERDICTS.DENIED);
  assert.equal(verdict.reason, DENY_REASONS.NOT_AUTHORIZED);
});

test("resolveSelector: a UUID absent from scope but existing globally is denied, isolated from the shadowed path", () => {
  const caller = { kind: CALLER_KINDS.SERVICE_KEY, principalId: "p-1", isAdmin: false, homeEstateId: EST_AGENT };
  // scope contains only ob1; the queried UUID is in neither accessible nor lookup.
  const scope = deriveScope({
    caller,
    brainMemberships: [{ brainId: BRAIN.ob1.brainId, role: "viewer", isDeny: false }],
    estateMemberships: [],
    catalog: [BRAIN.ob1],
  });
  assert.equal(scope.lookup.some((b) => b.brainId === BRAIN.spouse.brainId), false);
  const verdict = resolveSelector({ selector: BRAIN.spouse.brainId, scope, existsGlobally: true });
  assert.equal(verdict.kind, VERDICTS.DENIED);
});

test("deriveScope: admin home-estate brain carrying a DENY is nameable but not accessible", () => {
  // ADR-0002: brain DENY overrides everything, including a stored admin key's
  // home-estate reach. The scope half must agree with authorizeAction's clamp.
  const caller = { kind: CALLER_KINDS.SERVICE_KEY, principalId: "p-admin", isAdmin: true, homeEstateId: EST_AGENT };
  const scope = deriveScope({
    caller,
    brainMemberships: [{ brainId: BRAIN.secret.brainId, role: "owner", isDeny: true }],
    estateMemberships: [],
    catalog: [BRAIN.ob1, BRAIN.secret],
  });
  assert.equal(scope.accessibleIds.has(BRAIN.secret.brainId), false, "DENY removes accessibility even for admin home reach");
  assert.equal(scope.lookup.some((b) => b.brainId === BRAIN.secret.brainId), true, "still nameable → resolve-then-403");
  // ob1 (home estate, no membership) remains reachable
  assert.equal(scope.accessibleIds.has(BRAIN.ob1.brainId), true);
});

test("scenario: legacy/admin global resolution composes with conflict detection (the 400 seam)", () => {
  // The Stage-2 adapter resolves an L1 selector globally, a body selector
  // globally, then compares. Differing brains must surface as a conflict.
  const l1 = resolveSelectorGlobal({ candidates: [BRAIN.ob1] });
  const body = resolveSelectorGlobal({ candidates: [BRAIN.common] });
  assert.equal(l1.kind, VERDICTS.RESOLVED);
  assert.equal(body.kind, VERDICTS.RESOLVED);
  assert.equal(detectSelectorConflict(l1.brain, body.brain).kind, VERDICTS.SELECTOR_CONFLICT);
  // same brain on both sides → no conflict
  const same = resolveSelectorGlobal({ candidates: [BRAIN.ob1] });
  assert.equal(detectSelectorConflict(l1.brain, same.brain), null);
});

test("deny reason vocabulary is the frozen contract the adapter switches on", () => {
  const principal = { kind: CALLER_KINDS.SERVICE_KEY, principalId: "p-1", isAdmin: false };
  const legacy = { kind: CALLER_KINDS.LEGACY_ADMIN_KEY, principalId: null, isAdmin: true };
  assert.equal(
    authorizeAction({ caller: principal, action: ACTIONS.WRITE, brainMembership: B.viewer }).reason,
    DENY_REASONS.INSUFFICIENT_ROLE,
  );
  assert.equal(
    authorizeAction({ caller: principal, action: ACTIONS.READ, brainMembership: B.deny }).reason,
    DENY_REASONS.BRAIN_DENY,
  );
  assert.equal(
    authorizeAction({ caller: legacy, action: ACTIONS.PURGE }).reason,
    DENY_REASONS.LEGACY_ADMIN_CANNOT_PURGE,
  );
  assert.equal(
    authorizeAction({ caller: { kind: CALLER_KINDS.SERVICE_KEY, principalId: null, isAdmin: true }, action: ACTIONS.PURGE }).reason,
    DENY_REASONS.PURGE_REQUIRES_NAMED_ADMIN_SERVICE_KEY,
  );
});

// --------------------------------------------------------------------------
// Layer-A egress enforcement (§6.13/§6.2/§9 — slice 3)
// --------------------------------------------------------------------------

// B1: enforce × cloud_bound caller × private_local brain (otherwise granted)
// The brain must be ABSENT from accessible + accessibleIds, and PRESENT in egressExcluded.
test("egress B1: enforce — cloud_bound caller, private_local brain → excluded from accessible, present in egressExcluded", () => {
  const privateLocalBrain = {
    brainId: "0b1e0000-0000-4000-8000-000000000010",
    brainSlug: "priv-local",
    estateId: EST_AGENT,
    egressClass: BRAIN_EGRESS_CLASS.PRIVATE_LOCAL,
  };
  const caller = {
    kind: CALLER_KINDS.SERVICE_KEY,
    principalId: "p-cloud",
    isAdmin: false,
    homeEstateId: EST_AGENT,
    readEgressClass: CALLER_EGRESS_CLASS.CLOUD_BOUND,
  };
  const scope = deriveScope({
    caller,
    brainMemberships: [{ brainId: privateLocalBrain.brainId, role: "viewer", isDeny: false }],
    estateMemberships: [],
    catalog: [privateLocalBrain],
    egressMode: "enforce",
  });

  // Must NOT be accessible
  assert.equal(scope.accessibleIds.has(privateLocalBrain.brainId), false,
    "private_local brain must not be in accessibleIds for a cloud_bound caller under enforce");
  assert.equal(scope.accessible.some((b) => b.brainId === privateLocalBrain.brainId), false,
    "private_local brain must not be in accessible for a cloud_bound caller under enforce");

  // Must be in egressExcluded
  assert.ok(Array.isArray(scope.egressExcluded), "egressExcluded must be an array");
  assert.equal(scope.egressExcluded.some((b) => b.brainId === privateLocalBrain.brainId), true,
    "private_local brain must appear in egressExcluded");

  // Must NOT be in lookup (spec: 'AND from lookup' — no existence leak)
  assert.equal(scope.lookup.some((b) => b.brainId === privateLocalBrain.brainId), false,
    "private_local brain must not be in lookup for a cloud_bound caller under enforce");
});

// B2: enforce × cloud_bound caller × quarantine_review brain
// quarantine_review is LOCAL-ONLY; cloud-bound callers must have it excluded from
// accessible, accessibleIds, AND lookup (no existence leak — must resolve NOT_FOUND).
// Also covers the DENY-shadowed existence-leak bug: a quarantine_review brain that
// has a brain-DENY row (landing only in lookup, not accessible) must also be stripped
// from lookup so resolveSelector returns NOT_FOUND, not denied (existence leak).
test("egress B2: enforce — cloud_bound caller, quarantine_review brain → excluded from accessible + lookup, present in egressExcluded", () => {
  const quarantineBrain = {
    brainId: "0b1e0000-0000-4000-8000-000000000020",
    brainSlug: "quarantine-q",
    estateId: EST_AGENT,
    egressClass: BRAIN_EGRESS_CLASS.QUARANTINE_REVIEW,
  };
  const caller = {
    kind: CALLER_KINDS.SERVICE_KEY,
    principalId: "p-cloud",
    isAdmin: false,
    homeEstateId: EST_AGENT,
    readEgressClass: CALLER_EGRESS_CLASS.CLOUD_BOUND,
  };

  // Case A: brain is granted (accessible path) — standard B2
  const scopeA = deriveScope({
    caller,
    brainMemberships: [{ brainId: quarantineBrain.brainId, role: "viewer", isDeny: false }],
    estateMemberships: [],
    catalog: [quarantineBrain],
    egressMode: "enforce",
  });

  assert.equal(scopeA.accessibleIds.has(quarantineBrain.brainId), false,
    "quarantine_review brain must not be in accessibleIds for cloud_bound caller");
  assert.equal(scopeA.accessible.some((b) => b.brainId === quarantineBrain.brainId), false,
    "quarantine_review brain must not be in accessible for cloud_bound caller");
  assert.equal(scopeA.lookup.some((b) => b.brainId === quarantineBrain.brainId), false,
    "quarantine_review brain must not be in lookup for cloud_bound caller (no existence leak)");
  assert.equal(scopeA.egressExcluded.some((b) => b.brainId === quarantineBrain.brainId), true,
    "quarantine_review brain must appear in egressExcluded");

  // resolveSelector must return NOT_FOUND (not denied) — no existence leak via slug
  const slugVerdict = resolveSelector({ selector: quarantineBrain.brainSlug, scope: scopeA });
  assert.equal(slugVerdict.kind, VERDICTS.NOT_FOUND,
    "slug lookup of quarantine_review brain must be NOT_FOUND for cloud_bound (no existence leak)");

  // Case B: DENY-shadowed quarantine_review brain (brain-DENY + estate grant → in lookup but not accessible)
  // This is the high-severity existence-leak: without the fix, the brain stays in lookup and
  // resolveSelector returns denied (existence leak). With the fix it must return NOT_FOUND.
  const scopeB = deriveScope({
    caller,
    brainMemberships: [{ brainId: quarantineBrain.brainId, role: "viewer", isDeny: true }],
    estateMemberships: [{ estateId: EST_AGENT, role: "member", isDeny: false }],
    catalog: [quarantineBrain],
    egressMode: "enforce",
  });

  assert.equal(scopeB.lookup.some((b) => b.brainId === quarantineBrain.brainId), false,
    "DENY-shadowed quarantine_review brain must not be in lookup for cloud_bound caller (existence leak fix)");
  assert.equal(scopeB.egressExcluded.some((b) => b.brainId === quarantineBrain.brainId), true,
    "DENY-shadowed quarantine_review brain must appear in egressExcluded");

  const denyShadowedSlugVerdict = resolveSelector({ selector: quarantineBrain.brainSlug, scope: scopeB });
  assert.equal(denyShadowedSlugVerdict.kind, VERDICTS.NOT_FOUND,
    "DENY-shadowed quarantine_review brain slug must resolve NOT_FOUND for cloud_bound (existence leak fix)");
});

// B4: enforce × local_trusted caller × private_local brain → KEPT in accessible
// A local_trusted caller must never be restricted by egress enforcement.
// private_local brains must remain fully accessible and nameable for them.
test("egress B4: enforce — local_trusted caller, private_local brain → stays in accessible, egressExcluded empty", () => {
  const privateLocalBrain = {
    brainId: "0b1e0000-0000-4000-8000-000000000040",
    brainSlug: "priv-local-trusted",
    estateId: EST_AGENT,
    egressClass: BRAIN_EGRESS_CLASS.PRIVATE_LOCAL,
  };
  const caller = {
    kind: CALLER_KINDS.SERVICE_KEY,
    principalId: "p-local",
    isAdmin: false,
    homeEstateId: EST_AGENT,
    readEgressClass: CALLER_EGRESS_CLASS.LOCAL_TRUSTED,
  };
  const scope = deriveScope({
    caller,
    brainMemberships: [{ brainId: privateLocalBrain.brainId, role: "viewer", isDeny: false }],
    estateMemberships: [],
    catalog: [privateLocalBrain],
    egressMode: "enforce",
  });

  // local_trusted caller: no exclusion — brain stays accessible
  assert.equal(scope.accessible.some((b) => b.brainId === privateLocalBrain.brainId), true,
    "private_local brain must remain in accessible for a local_trusted caller under enforce");
  assert.equal(scope.accessibleIds.has(privateLocalBrain.brainId), true,
    "private_local brain must remain in accessibleIds for a local_trusted caller under enforce");
  assert.equal(scope.lookup.some((b) => b.brainId === privateLocalBrain.brainId), true,
    "private_local brain must remain in lookup for a local_trusted caller under enforce");

  // egressExcluded must be empty (no brain was excluded)
  assert.ok(Array.isArray(scope.egressExcluded), "egressExcluded must be an array");
  assert.equal(scope.egressExcluded.length, 0,
    "egressExcluded must be empty for a local_trusted caller under enforce");

  // resolveSelector must resolve the brain successfully
  const verdict = resolveSelector({ selector: privateLocalBrain.brainSlug, scope });
  assert.equal(verdict.kind, VERDICTS.RESOLVED,
    "private_local brain slug must resolve RESOLVED for local_trusted caller under enforce");
});

// B5: enforce × absent/unknown caller readEgressClass → fail-closed (treated as cloud_bound) → excluded
// The spec says: 'absent/unknown ⇒ cloud_bound' (fail-closed). A caller with NO readEgressClass
// field must be treated as cloud_bound and have local-only brains excluded, not leaked.
test("egress B5: enforce — absent caller readEgressClass → fail-closed as cloud_bound → private_local brain excluded", () => {
  const privateLocalBrain = {
    brainId: "0b1e0000-0000-4000-8000-000000000050",
    brainSlug: "priv-absent-ec",
    estateId: EST_AGENT,
    egressClass: BRAIN_EGRESS_CLASS.PRIVATE_LOCAL,
  };
  // Caller with NO readEgressClass field at all (absent, not 'cloud_bound' nor 'local_trusted')
  const caller = {
    kind: CALLER_KINDS.SERVICE_KEY,
    principalId: "p-unknown-ec",
    isAdmin: false,
    homeEstateId: EST_AGENT,
    // readEgressClass deliberately omitted
  };
  const scope = deriveScope({
    caller,
    brainMemberships: [{ brainId: privateLocalBrain.brainId, role: "viewer", isDeny: false }],
    estateMemberships: [],
    catalog: [privateLocalBrain],
    egressMode: "enforce",
  });

  // Absent readEgressClass → fail-closed → cloud_bound → brain excluded
  assert.equal(scope.accessibleIds.has(privateLocalBrain.brainId), false,
    "absent readEgressClass must fail-closed to cloud_bound: brain excluded from accessibleIds");
  assert.equal(scope.accessible.some((b) => b.brainId === privateLocalBrain.brainId), false,
    "absent readEgressClass must fail-closed to cloud_bound: brain excluded from accessible");
  assert.equal(scope.lookup.some((b) => b.brainId === privateLocalBrain.brainId), false,
    "absent readEgressClass must fail-closed to cloud_bound: brain excluded from lookup (no existence leak)");
  assert.equal(scope.egressExcluded.some((b) => b.brainId === privateLocalBrain.brainId), true,
    "absent readEgressClass must fail-closed to cloud_bound: brain present in egressExcluded");

  // resolveSelector must return NOT_FOUND (not denied) — no existence leak
  const slugVerdict = resolveSelector({ selector: privateLocalBrain.brainSlug, scope });
  assert.equal(slugVerdict.kind, VERDICTS.NOT_FOUND,
    "absent readEgressClass → fail-closed: slug must resolve NOT_FOUND (no existence leak)");
});

// B7: observe × cloud_bound caller × private_local brain → accessible/lookup UNCHANGED, egressExcluded reports it
// egressMode='observe' must NOT filter accessible, accessibleIds, or lookup — only populate egressExcluded.
test("egress B7: observe — cloud_bound caller, private_local brain → accessible/lookup unchanged, egressExcluded reports it", () => {
  const privateLocalBrain = {
    brainId: "0b1e0000-0000-4000-8000-000000000070",
    brainSlug: "priv-observe",
    estateId: EST_AGENT,
    egressClass: BRAIN_EGRESS_CLASS.PRIVATE_LOCAL,
  };
  const caller = {
    kind: CALLER_KINDS.SERVICE_KEY,
    principalId: "p-cloud-obs",
    isAdmin: false,
    homeEstateId: EST_AGENT,
    readEgressClass: CALLER_EGRESS_CLASS.CLOUD_BOUND,
  };
  const scope = deriveScope({
    caller,
    brainMemberships: [{ brainId: privateLocalBrain.brainId, role: "viewer", isDeny: false }],
    estateMemberships: [],
    catalog: [privateLocalBrain],
    egressMode: "observe",
  });

  // accessible/accessibleIds/lookup must be UNCHANGED — brain still present
  assert.equal(scope.accessible.some((b) => b.brainId === privateLocalBrain.brainId), true,
    "observe mode must NOT remove the brain from accessible");
  assert.equal(scope.accessibleIds.has(privateLocalBrain.brainId), true,
    "observe mode must NOT remove the brain from accessibleIds");
  assert.equal(scope.lookup.some((b) => b.brainId === privateLocalBrain.brainId), true,
    "observe mode must NOT remove the brain from lookup");

  // egressExcluded must report the brain that WOULD be excluded under enforce
  assert.ok(Array.isArray(scope.egressExcluded), "egressExcluded must be an array");
  assert.equal(scope.egressExcluded.some((b) => b.brainId === privateLocalBrain.brainId), true,
    "observe mode must list the private_local brain in egressExcluded (for logging)");

  // resolveSelector must still resolve the brain (observe mode — no actual filtering)
  const verdict = resolveSelector({ selector: privateLocalBrain.brainSlug, scope });
  assert.equal(verdict.kind, VERDICTS.RESOLVED,
    "observe mode: slug must resolve RESOLVED (no filtering, brain still in scope)");
});

// B3: enforce × cloud_bound caller × repo brain and × public brain → kept in accessible
// Cloud-readable egress classes (repo, public) must NOT be excluded, even in enforce mode.
// This is the negative guard: enforce only strips local-only brains, not cloud-readable ones.
test("egress B3: enforce — cloud_bound caller, repo and public brains → remain in accessible", () => {
  const repoBrain = {
    brainId: "0b1e0000-0000-4000-8000-000000000030",
    brainSlug: "repo-brain",
    estateId: EST_AGENT,
    egressClass: BRAIN_EGRESS_CLASS.REPO,
  };
  const publicBrain = {
    brainId: "0b1e0000-0000-4000-8000-000000000031",
    brainSlug: "public-brain",
    estateId: EST_AGENT,
    egressClass: BRAIN_EGRESS_CLASS.PUBLIC,
  };
  const caller = {
    kind: CALLER_KINDS.SERVICE_KEY,
    principalId: "p-cloud",
    isAdmin: false,
    homeEstateId: EST_AGENT,
    readEgressClass: CALLER_EGRESS_CLASS.CLOUD_BOUND,
  };
  const scope = deriveScope({
    caller,
    brainMemberships: [
      { brainId: repoBrain.brainId, role: "viewer", isDeny: false },
      { brainId: publicBrain.brainId, role: "viewer", isDeny: false },
    ],
    estateMemberships: [],
    catalog: [repoBrain, publicBrain],
    egressMode: "enforce",
  });

  // Both cloud-readable brains must stay in accessible
  assert.equal(scope.accessible.some((b) => b.brainId === repoBrain.brainId), true,
    "repo brain must remain in accessible for cloud_bound caller under enforce");
  assert.equal(scope.accessible.some((b) => b.brainId === publicBrain.brainId), true,
    "public brain must remain in accessible for cloud_bound caller under enforce");

  // Both must stay in accessibleIds
  assert.equal(scope.accessibleIds.has(repoBrain.brainId), true,
    "repo brain must remain in accessibleIds for cloud_bound caller under enforce");
  assert.equal(scope.accessibleIds.has(publicBrain.brainId), true,
    "public brain must remain in accessibleIds for cloud_bound caller under enforce");

  // Neither must appear in egressExcluded
  assert.equal(scope.egressExcluded.some((b) => b.brainId === repoBrain.brainId), false,
    "repo brain must NOT appear in egressExcluded");
  assert.equal(scope.egressExcluded.some((b) => b.brainId === publicBrain.brainId), false,
    "public brain must NOT appear in egressExcluded");

  // Both must remain in lookup so resolveSelector can find them
  assert.equal(scope.lookup.some((b) => b.brainId === repoBrain.brainId), true,
    "repo brain must remain in lookup for cloud_bound caller under enforce");
  assert.equal(scope.lookup.some((b) => b.brainId === publicBrain.brainId), true,
    "public brain must remain in lookup for cloud_bound caller under enforce");

  // resolveSelector must resolve both successfully
  const repoVerdict = resolveSelector({ selector: repoBrain.brainSlug, scope });
  assert.equal(repoVerdict.kind, VERDICTS.RESOLVED,
    "repo brain slug must resolve RESOLVED for cloud_bound under enforce");
  const publicVerdict = resolveSelector({ selector: publicBrain.brainSlug, scope });
  assert.equal(publicVerdict.kind, VERDICTS.RESOLVED,
    "public brain slug must resolve RESOLVED for cloud_bound under enforce");
});

// B6: enforce × cloud_bound caller × brain with absent/unknown egressClass → fail-closed (local-only) → excluded
// Spec: 'An absent/unknown brain egressClass is treated as LOCAL-ONLY (FAIL-CLOSED).'
// A cloud_bound caller querying a brain with NO egressClass field must have it excluded from
// accessible, accessibleIds, AND lookup (no existence leak), and it must appear in egressExcluded.
test("egress B6: enforce — cloud_bound caller, absent brain egressClass → fail-closed as local-only → excluded", () => {
  // Brain with NO egressClass field (absent — not even undefined, just omitted)
  const unknownEgressBrain = {
    brainId: "0b1e0000-0000-4000-8000-000000000060",
    brainSlug: "unknown-egress",
    estateId: EST_AGENT,
    // egressClass deliberately omitted — fail-closed must treat as local-only
  };
  const caller = {
    kind: CALLER_KINDS.SERVICE_KEY,
    principalId: "p-cloud",
    isAdmin: false,
    homeEstateId: EST_AGENT,
    readEgressClass: CALLER_EGRESS_CLASS.CLOUD_BOUND,
  };
  const scope = deriveScope({
    caller,
    brainMemberships: [{ brainId: unknownEgressBrain.brainId, role: "viewer", isDeny: false }],
    estateMemberships: [],
    catalog: [unknownEgressBrain],
    egressMode: "enforce",
  });

  // Absent egressClass → fail-closed → treated as local-only → excluded for cloud_bound
  assert.equal(scope.accessibleIds.has(unknownEgressBrain.brainId), false,
    "absent egressClass must fail-closed: brain excluded from accessibleIds for cloud_bound caller");
  assert.equal(scope.accessible.some((b) => b.brainId === unknownEgressBrain.brainId), false,
    "absent egressClass must fail-closed: brain excluded from accessible for cloud_bound caller");
  assert.equal(scope.lookup.some((b) => b.brainId === unknownEgressBrain.brainId), false,
    "absent egressClass must fail-closed: brain excluded from lookup for cloud_bound caller (no existence leak)");
  assert.equal(scope.egressExcluded.some((b) => b.brainId === unknownEgressBrain.brainId), true,
    "absent egressClass must fail-closed: brain present in egressExcluded");

  // resolveSelector must return NOT_FOUND (not denied) — no existence leak via slug
  const slugVerdict = resolveSelector({ selector: unknownEgressBrain.brainSlug, scope });
  assert.equal(slugVerdict.kind, VERDICTS.NOT_FOUND,
    "absent egressClass → fail-closed: slug must resolve NOT_FOUND for cloud_bound (no existence leak)");

  // UUID + existsGlobally:true must also resolve NOT_FOUND — no existence leak via UUID
  // (existsGlobally path must not reveal the brain if it was egress-excluded)
  const uuidVerdict = resolveSelector({ selector: unknownEgressBrain.brainId, scope, existsGlobally: true });
  assert.equal(uuidVerdict.kind, VERDICTS.NOT_FOUND,
    "absent egressClass → fail-closed: UUID+existsGlobally must resolve NOT_FOUND for cloud_bound (no existence leak)");
});

// B8: off/absent egressMode → byte-identical back-compat for local-only brains.
// With egressMode='off' (or param entirely absent), a private_local brain that would
// be excluded under enforce must remain fully accessible; egressExcluded must be [].
// This guarantees zero regression for callers that don't pass egressMode.
test("egress B8: egressMode='off' — private_local brain remains accessible (byte-identical back-compat)", () => {
  const privateLocalBrain = {
    brainId: "0b1e0000-0000-4000-8000-000000000080",
    brainSlug: "priv-off-mode",
    estateId: EST_AGENT,
    egressClass: BRAIN_EGRESS_CLASS.PRIVATE_LOCAL,
  };
  const caller = {
    kind: CALLER_KINDS.SERVICE_KEY,
    principalId: "p-cloud-off",
    isAdmin: false,
    homeEstateId: EST_AGENT,
    readEgressClass: CALLER_EGRESS_CLASS.CLOUD_BOUND,
  };

  // Case A: egressMode explicitly 'off'
  const scopeOff = deriveScope({
    caller,
    brainMemberships: [{ brainId: privateLocalBrain.brainId, role: "viewer", isDeny: false }],
    estateMemberships: [],
    catalog: [privateLocalBrain],
    egressMode: "off",
  });

  assert.equal(scopeOff.accessible.some((b) => b.brainId === privateLocalBrain.brainId), true,
    "egressMode='off': private_local brain must remain in accessible (no egress filter)");
  assert.equal(scopeOff.accessibleIds.has(privateLocalBrain.brainId), true,
    "egressMode='off': private_local brain must remain in accessibleIds");
  assert.equal(scopeOff.lookup.some((b) => b.brainId === privateLocalBrain.brainId), true,
    "egressMode='off': private_local brain must remain in lookup");
  assert.ok(Array.isArray(scopeOff.egressExcluded),
    "egressMode='off': egressExcluded must be an array");
  assert.equal(scopeOff.egressExcluded.length, 0,
    "egressMode='off': egressExcluded must be [] (no filtering)");

  // Case B: egressMode param entirely absent
  const scopeAbsent = deriveScope({
    caller,
    brainMemberships: [{ brainId: privateLocalBrain.brainId, role: "viewer", isDeny: false }],
    estateMemberships: [],
    catalog: [privateLocalBrain],
    // egressMode deliberately omitted
  });

  assert.equal(scopeAbsent.accessible.some((b) => b.brainId === privateLocalBrain.brainId), true,
    "absent egressMode: private_local brain must remain in accessible (no egress filter)");
  assert.equal(scopeAbsent.accessibleIds.has(privateLocalBrain.brainId), true,
    "absent egressMode: private_local brain must remain in accessibleIds");
  assert.equal(scopeAbsent.lookup.some((b) => b.brainId === privateLocalBrain.brainId), true,
    "absent egressMode: private_local brain must remain in lookup");
  assert.ok(Array.isArray(scopeAbsent.egressExcluded),
    "absent egressMode: egressExcluded must be an array");
  assert.equal(scopeAbsent.egressExcluded.length, 0,
    "absent egressMode: egressExcluded must be [] (no filtering)");

  // resolveSelector must resolve the brain successfully in both cases
  const verdictOff = resolveSelector({ selector: privateLocalBrain.brainSlug, scope: scopeOff });
  assert.equal(verdictOff.kind, VERDICTS.RESOLVED,
    "egressMode='off': slug must resolve RESOLVED (no egress filter)");

  const verdictAbsent = resolveSelector({ selector: privateLocalBrain.brainSlug, scope: scopeAbsent });
  assert.equal(verdictAbsent.kind, VERDICTS.RESOLVED,
    "absent egressMode: slug must resolve RESOLVED (no egress filter)");
});

// B9: enforce × cloud_bound caller × DENY-shadowed private_local brain + UUID + existsGlobally:true
// → resolveSelector must return NOT_FOUND (no existence leak via UUID path).
//
// Scenario: estate-member grant puts the brain in lookup (nameable); a brain-DENY row keeps it
// out of accessible (not usable). Under egressMode='enforce' the egress loop iterates ALL lookup
// entries (including DENY-shadowed ones) and adds local-only brains to egressExcluded + strips
// them from lookup. When the adapter then calls resolveSelector with the UUID and existsGlobally:true
// (the DB confirmed the UUID exists), the module must check egressExcluded BEFORE the existsGlobally
// branch, so it returns NOT_FOUND instead of denied(NOT_AUTHORIZED) — which would leak existence.
//
// This is the composite gap: B1 tests private_local (non-DENY) but not UUID+existsGlobally;
// B2 tests quarantine_review DENY-shadowed but not UUID+existsGlobally; B6 tests UUID+existsGlobally
// but for absent egressClass only. B9 closes the private_local + DENY-shadowed + UUID path.
test("egress B9: enforce — cloud_bound caller, DENY-shadowed private_local brain, UUID + existsGlobally:true → NOT_FOUND (no existence leak)", () => {
  const privateLocalBrain = {
    brainId: "0b1e0000-0000-4000-8000-0000000000b9",
    brainSlug: "priv-deny-b9",
    estateId: EST_AGENT,
    egressClass: BRAIN_EGRESS_CLASS.PRIVATE_LOCAL,
  };
  const caller = {
    kind: CALLER_KINDS.SERVICE_KEY,
    principalId: "p-cloud-b9",
    isAdmin: false,
    homeEstateId: EST_AGENT,
    readEgressClass: CALLER_EGRESS_CLASS.CLOUD_BOUND,
  };

  // DENY-shadowed: estate-member grant → isNameable=true (in lookup), brain-DENY → isAccessible=false.
  // Under enforce the egress loop must still catch this brain (it iterates lookup, not accessible)
  // and strip it from both lookup and egressExcluded-filter scope.
  const scope = deriveScope({
    caller,
    brainMemberships: [{ brainId: privateLocalBrain.brainId, role: "owner", isDeny: true }],
    estateMemberships: [{ estateId: EST_AGENT, role: "member", isDeny: false }],
    catalog: [privateLocalBrain],
    egressMode: "enforce",
  });

  // Brain must be stripped from lookup (no existence leak path via lookup/shadowed branch).
  assert.equal(scope.lookup.some((b) => b.brainId === privateLocalBrain.brainId), false,
    "DENY-shadowed private_local brain must not be in lookup for cloud_bound caller under enforce");

  // Brain must be recorded in egressExcluded (audit trail).
  assert.equal(scope.egressExcluded.some((b) => b.brainId === privateLocalBrain.brainId), true,
    "DENY-shadowed private_local brain must appear in egressExcluded under enforce");

  // Slug resolveSelector must return NOT_FOUND (brain stripped from lookup).
  const slugVerdict = resolveSelector({ selector: privateLocalBrain.brainSlug, scope });
  assert.equal(slugVerdict.kind, VERDICTS.NOT_FOUND,
    "DENY-shadowed private_local brain slug must resolve NOT_FOUND for cloud_bound (no existence leak)");

  // UUID + existsGlobally:true resolveSelector must also return NOT_FOUND.
  // The egressExcluded check in resolveSelector must fire BEFORE the existsGlobally branch,
  // preventing the 'denied(NOT_AUTHORIZED)' existence leak the adapter cannot filter.
  const uuidVerdict = resolveSelector({
    selector: privateLocalBrain.brainId,
    scope,
    existsGlobally: true,
  });
  assert.equal(uuidVerdict.kind, VERDICTS.NOT_FOUND,
    "DENY-shadowed private_local brain UUID+existsGlobally must resolve NOT_FOUND for cloud_bound (no existence leak)");
});
