import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTIONS,
  CALLER_KINDS,
  VERDICTS,
  DENY_REASONS,
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
