import test from "node:test";
import assert from "node:assert/strict";

import { effectiveEgress, deriveCaptureStamp } from "../src/access-policy.mjs";

// --------------------------------------------------------------------------
// deriveCaptureStamp — the PURE write-stamping decision (docs/45 §6.8/§6.11).
// What columns a capture writes, derived from the caller's egress class.
// The persistence (captureThought SQL) is integration-tested separately.
// --------------------------------------------------------------------------

test("stamp: local_trusted caller + standard → local_trusted origin, none review", () => {
  assert.deepEqual(
    deriveCaptureStamp({ caller: { readEgressClass: "local_trusted" }, sensitivityTier: "standard" }),
    { originEgressClass: "local_trusted", sourceTrustClass: "trusted", reviewState: "none" },
  );
});

test("stamp: cloud_bound caller + standard → cloud_origin, none review (materializes, untrusted handled at read)", () => {
  assert.deepEqual(
    deriveCaptureStamp({ caller: { readEgressClass: "cloud_bound" }, sensitivityTier: "standard" }),
    { originEgressClass: "cloud_origin", sourceTrustClass: "trusted", reviewState: "none" },
  );
});

test("stamp: cloud_bound caller + restricted → cloud_origin, QUARANTINED (unreviewed)", () => {
  assert.deepEqual(
    deriveCaptureStamp({ caller: { readEgressClass: "cloud_bound" }, sensitivityTier: "restricted" }),
    { originEgressClass: "cloud_origin", sourceTrustClass: "trusted", reviewState: "unreviewed" },
  );
});

test("stamp: local_trusted caller + restricted → local_trusted, none (not quarantined)", () => {
  assert.deepEqual(
    deriveCaptureStamp({ caller: { readEgressClass: "local_trusted" }, sensitivityTier: "restricted" }),
    { originEgressClass: "local_trusted", sourceTrustClass: "trusted", reviewState: "none" },
  );
});

test("stamp: unknown/absent caller egress → cloud_origin (fail-closed); restricted → quarantined", () => {
  assert.deepEqual(
    deriveCaptureStamp({ caller: {}, sensitivityTier: "restricted" }),
    { originEgressClass: "cloud_origin", sourceTrustClass: "trusted", reviewState: "unreviewed" },
  );
  assert.deepEqual(
    deriveCaptureStamp({ caller: undefined, sensitivityTier: "standard" }),
    { originEgressClass: "cloud_origin", sourceTrustClass: "trusted", reviewState: "none" },
  );
});

// B1: cloud_bound caller reading a restricted-tier row → canMaterialize=false
// Full shape assertion (all seven output fields must be correct).
test("B1: cloud_bound caller + restricted row → canMaterialize=false (full shape)", () => {
  const result = effectiveEgress({
    brain: { egressClass: "public" },
    row: {
      sensitivityTier: "restricted",
      reviewState: "none",
      originEgressClass: "local_trusted",
      sourceTrustClass: "trusted",
    },
    requestedOperation: "read",
    caller: { readEgressClass: "cloud_bound" },
    sink: { type: "response", cloudAgentReachable: true },
  });

  // Confidentiality: local-only (restricted tier) + cloud_bound audience → deny
  assert.equal(result.canMaterialize, false);
  assert.equal(result.redactionLevel, "full");
  assert.equal(result.processorSinkAllowed, false);

  // Trust: local_trusted origin + trusted source → trusted, side-effects allowed
  assert.equal(result.trustLevel, "trusted");
  assert.equal(result.sideEffectAllowed, true);

  // Provenance not required (denied, not materializaing to untrusted audience)
  assert.deepEqual(result.provenanceFieldsRequired, []);

  // Audit required on denial
  assert.equal(result.auditRequired, true);
});

// B1-quarantine: cloud_origin + restricted + unreviewed → canMaterialize=false
// (quarantine rule: overrides audience trust, absolute deny in slice 1)
test("B1-quarantine: cloud_origin + restricted + unreviewed → canMaterialize=false regardless of caller", () => {
  const result = effectiveEgress({
    brain: { egressClass: "public" },
    row: {
      sensitivityTier: "restricted",
      reviewState: "unreviewed",
      originEgressClass: "cloud_origin",
      sourceTrustClass: "trusted",
    },
    requestedOperation: "read",
    caller: { readEgressClass: "local_trusted" },
    sink: { type: "response", cloudAgentReachable: false },
  });

  // Quarantine: cloud_origin + restricted + unreviewed → absolute deny
  assert.equal(result.canMaterialize, false);
  assert.equal(result.redactionLevel, "full");
  assert.equal(result.processorSinkAllowed, false);

  // Trust: cloud_origin taint → untrusted
  assert.equal(result.trustLevel, "untrusted");
  assert.equal(result.sideEffectAllowed, false);

  // Provenance not required (not materializing)
  assert.deepEqual(result.provenanceFieldsRequired, []);

  // Audit required (denied + untrusted)
  assert.equal(result.auditRequired, true);
});

// B1-quarantine-brain: quarantine_review brain + restricted + unreviewed + cloud_origin
// → canMaterialize=false even for local_trusted caller
test("B1-quarantine-brain: quarantine_review brain + restricted + unreviewed + cloud_origin → canMaterialize=false", () => {
  const result = effectiveEgress({
    brain: { egressClass: "quarantine_review" },
    row: {
      sensitivityTier: "restricted",
      reviewState: "unreviewed",
      originEgressClass: "cloud_origin",
      sourceTrustClass: "untrusted",
    },
    requestedOperation: "read",
    caller: { readEgressClass: "local_trusted" },
    sink: { type: "response", cloudAgentReachable: false },
  });

  assert.equal(result.canMaterialize, false);
  assert.equal(result.redactionLevel, "full");
  assert.equal(result.processorSinkAllowed, false);
  assert.equal(result.trustLevel, "untrusted");
  assert.equal(result.sideEffectAllowed, false);
  assert.deepEqual(result.provenanceFieldsRequired, []);
  assert.equal(result.auditRequired, true);
});

// B2: local_trusted caller reading a restricted-tier row (non-quarantine)
// → canMaterialize=true, processorSinkAllowed=true (only when sink is NOT cloud-reachable)
test("B2: local_trusted caller + restricted row (non-quarantine) → canMaterialize=true, processorSinkAllowed=true", () => {
  const result = effectiveEgress({
    brain: { egressClass: "public" },
    row: {
      sensitivityTier: "restricted",
      reviewState: "none",
      originEgressClass: "local_trusted",
      sourceTrustClass: "trusted",
    },
    requestedOperation: "read",
    caller: { readEgressClass: "local_trusted" },
    sink: { type: "response", cloudAgentReachable: false },
  });

  // Confidentiality: local-only (restricted tier) + local_trusted audience → allow
  assert.equal(result.canMaterialize, true);
  assert.equal(result.processorSinkAllowed, true);

  // Trust: local_trusted origin + trusted source → trusted
  assert.equal(result.trustLevel, "trusted");
  assert.equal(result.sideEffectAllowed, true);

  // Redaction: materializing local-only to local audience
  assert.equal(result.redactionLevel, "local_metadata_only");

  // No provenance required (trusted row)
  assert.deepEqual(result.provenanceFieldsRequired, []);

  // No audit required (not denied, not untrusted)
  assert.equal(result.auditRequired, false);
});

// B2-sink-reachable: local_trusted caller but sink IS cloud-reachable
// → canMaterialize=true (caller is local) but processorSinkAllowed=false (sink leaks to cloud)
test("B2-sink-reachable: local_trusted caller + restricted row + cloud-reachable sink → processorSinkAllowed=false", () => {
  const result = effectiveEgress({
    brain: { egressClass: "public" },
    row: {
      sensitivityTier: "restricted",
      reviewState: "none",
      originEgressClass: "local_trusted",
      sourceTrustClass: "trusted",
    },
    requestedOperation: "process",
    caller: { readEgressClass: "local_trusted" },
    sink: { type: "processor", cloudAgentReachable: true },
  });

  // Caller is local_trusted → can materialize
  assert.equal(result.canMaterialize, true);
  // But the processor sink is cloud-reachable → must not allow routing restricted content there
  assert.equal(result.processorSinkAllowed, false);
});

// B1-quarantine-cloud-caller: quarantine rule applies even to a cloud_bound caller
// (absolute deny regardless of audience)
test("B1-quarantine-cloud-caller: cloud_origin + restricted + unreviewed → canMaterialize=false for cloud_bound caller too", () => {
  const result = effectiveEgress({
    brain: { egressClass: "public" },
    row: {
      sensitivityTier: "restricted",
      reviewState: "unreviewed",
      originEgressClass: "cloud_origin",
      sourceTrustClass: "trusted",
    },
    requestedOperation: "read",
    caller: { readEgressClass: "cloud_bound" },
    sink: { type: "response", cloudAgentReachable: true },
  });

  assert.equal(result.canMaterialize, false);
  assert.equal(result.redactionLevel, "full");
  assert.equal(result.processorSinkAllowed, false);
});

// B2-quarantine-absent-reviewState: fail-closed — absent reviewState on cloud_origin+restricted row
// must be treated as 'unreviewed' (most restrictive), not as 'reviewed'
test("B2-quarantine-absent-reviewState: cloud_origin + restricted + absent reviewState → canMaterialize=false (fail-closed)", () => {
  const result = effectiveEgress({
    brain: { egressClass: "public" },
    row: {
      sensitivityTier: "restricted",
      // reviewState intentionally absent
      originEgressClass: "cloud_origin",
      sourceTrustClass: "trusted",
    },
    requestedOperation: "read",
    caller: { readEgressClass: "local_trusted" },
    sink: { type: "response", cloudAgentReachable: false },
  });

  // Unknown reviewState on a quarantine-eligible row → treat as unreviewed → deny
  assert.equal(result.canMaterialize, false);
  assert.equal(result.redactionLevel, "full");
  assert.equal(result.processorSinkAllowed, false);
  assert.equal(result.auditRequired, true);
});

// B3: cloud_bound caller reading a standard-tier row from a public brain
// → canMaterialize=true (standard tier is NOT local-only)
test("B3: cloud_bound caller + standard-tier row (public brain) → canMaterialize=true", () => {
  const result = effectiveEgress({
    brain: { egressClass: "public" },
    row: {
      sensitivityTier: "standard",
      reviewState: "none",
      originEgressClass: "local_trusted",
      sourceTrustClass: "trusted",
    },
    requestedOperation: "read",
    caller: { readEgressClass: "cloud_bound" },
    sink: { type: "response", cloudAgentReachable: true },
  });

  // Standard tier + public brain → not local-only → cloud_bound can read
  assert.equal(result.canMaterialize, true);
  assert.equal(result.redactionLevel, "none");

  // Trust: local_trusted origin + trusted source → trusted
  assert.equal(result.trustLevel, "trusted");
  assert.equal(result.sideEffectAllowed, true);

  // Processor sink allowed (not local-only, cloud_bound audience but standard row)
  // Note: audienceIsCloudBound=true → processorSinkAllowed=false per spec
  // (processorSinkAllowed gates sending to a PROCESSOR; cloud_bound audience means
  //  we already ARE cloud → processorSinkAllowed=false since sink is cloud-reachable)
  assert.equal(result.processorSinkAllowed, false);

  // Provenance not required (trusted row)
  assert.deepEqual(result.provenanceFieldsRequired, []);

  // Audit not required (allow + trusted)
  assert.equal(result.auditRequired, false);
});

// B4: unknown/invalid enum → fail-closed
// Any absent or unrecognised field is treated as the MOST-RESTRICTIVE value, never the most permissive.
// Case A: background job (caller=null) with absent sink.cloudAgentReachable + restricted row
//   → absent cloudAgentReachable is unknown → treat as true (cloud-reachable) → cloud_bound audience
//   → local-only row + cloud_bound audience → canMaterialize=false
test("B4a: background job + absent sink.cloudAgentReachable + restricted row → fail-closed (canMaterialize=false)", () => {
  const result = effectiveEgress({
    brain: { egressClass: "public" },
    row: {
      sensitivityTier: "restricted",
      reviewState: "none",
      originEgressClass: "local_trusted",
      sourceTrustClass: "trusted",
    },
    requestedOperation: "read",
    caller: null,
    sink: { type: "backup" }, // cloudAgentReachable absent → treat as unknown → most-restrictive = true
  });

  // Fail-closed: unknown cloudAgentReachable → treat as cloud-reachable → deny restricted
  assert.equal(result.canMaterialize, false);
  assert.equal(result.redactionLevel, "full");
  assert.equal(result.processorSinkAllowed, false);

  // Trust: local_trusted origin + trusted source → trusted
  assert.equal(result.trustLevel, "trusted");
  assert.equal(result.sideEffectAllowed, true);

  // Provenance: not materializing → none required
  assert.deepEqual(result.provenanceFieldsRequired, []);

  // Audit required on denial
  assert.equal(result.auditRequired, true);
});

// B4b: provenanceFieldsRequired must NOT fire for a cloud_bound audience
//   spec: 'provenanceFieldsRequired: when materializing a cloud_origin or untrusted row to a LOCAL-TRUSTED AUDIENCE'
//   cloud_bound audience → provenanceFieldsRequired=[] even when cloud_origin row materializes
test("B4b: cloud_origin row + cloud_bound audience → provenanceFieldsRequired=[] (spec: local-trusted audience only)", () => {
  const result = effectiveEgress({
    brain: { egressClass: "public" },
    row: {
      sensitivityTier: "standard",
      reviewState: "reviewed",
      originEgressClass: "cloud_origin",
      sourceTrustClass: "trusted",
    },
    requestedOperation: "read",
    caller: { readEgressClass: "cloud_bound" },
    sink: { type: "response", cloudAgentReachable: true },
  });

  // Standard tier + public brain → not local-only → cloud_bound can read
  assert.equal(result.canMaterialize, true);

  // Trust: cloud_origin writer taint → untrusted
  assert.equal(result.trustLevel, "untrusted");
  assert.equal(result.sideEffectAllowed, false);

  // Provenance NOT required: audience is cloud_bound, not local-trusted
  assert.deepEqual(result.provenanceFieldsRequired, []);

  // Audit required (untrusted content)
  assert.equal(result.auditRequired, true);
});

// B4c: brain-class isolation — quarantine_review brain + STANDARD tier + cloud_bound caller
//   → canMaterialize=false. This test is distinct from the row-quarantine path (B1-quarantine-brain
//   uses restricted+unreviewed+cloud_origin, where the ROW quarantine fires regardless of brain class).
//   Here the row itself has no quarantine taint; the denial comes solely from the brain's local-only class.
test("B4c: quarantine_review brain + standard-tier row + cloud_bound caller → canMaterialize=false (brain-driven isolation)", () => {
  const result = effectiveEgress({
    brain: { egressClass: "quarantine_review" },
    row: {
      sensitivityTier: "standard",
      reviewState: "none",
      originEgressClass: "local_trusted",
      sourceTrustClass: "trusted",
    },
    requestedOperation: "read",
    caller: { readEgressClass: "cloud_bound" },
    sink: { type: "response", cloudAgentReachable: true },
  });

  // Brain is local-only; standard row alone would allow cloud_bound, but brain blocks it
  assert.equal(result.canMaterialize, false);
  assert.equal(result.redactionLevel, "full");
  assert.equal(result.processorSinkAllowed, false);

  // Trust: local_trusted origin + trusted source → trusted (separate from confidentiality)
  assert.equal(result.trustLevel, "trusted");
  assert.equal(result.sideEffectAllowed, true);

  // Provenance not required (not materializing)
  assert.deepEqual(result.provenanceFieldsRequired, []);

  // Audit required on denial
  assert.equal(result.auditRequired, true);
});

// B4d: private_local brain + standard-tier row + cloud_bound caller → canMaterialize=false
//   Proves the private_local brain class is also isolated (untested in prior cycles).
test("B4d: private_local brain + standard-tier row + cloud_bound caller → canMaterialize=false (brain-driven isolation)", () => {
  const result = effectiveEgress({
    brain: { egressClass: "private_local" },
    row: {
      sensitivityTier: "standard",
      reviewState: "none",
      originEgressClass: "local_trusted",
      sourceTrustClass: "trusted",
    },
    requestedOperation: "read",
    caller: { readEgressClass: "cloud_bound" },
    sink: { type: "response", cloudAgentReachable: true },
  });

  assert.equal(result.canMaterialize, false);
  assert.equal(result.redactionLevel, "full");
  assert.equal(result.processorSinkAllowed, false);
  assert.equal(result.trustLevel, "trusted");
  assert.equal(result.sideEffectAllowed, true);
  assert.deepEqual(result.provenanceFieldsRequired, []);
  assert.equal(result.auditRequired, true);
});

// B4e: absent sensitivityTier in quarantine path must fail-closed
//   Spec: 'any field may be absent → treat as unknown → MOST-RESTRICTIVE'.
//   For sensitivityTier, most restrictive = restricted. So cloud_origin + absent sensitivityTier
//   + unreviewed must be quarantined → canMaterialize=false.
test("B4e: cloud_origin + absent sensitivityTier + unreviewed → canMaterialize=false (fail-closed quarantine)", () => {
  const result = effectiveEgress({
    brain: { egressClass: "public" },
    row: {
      // sensitivityTier intentionally absent
      reviewState: "unreviewed",
      originEgressClass: "cloud_origin",
      sourceTrustClass: "trusted",
    },
    requestedOperation: "read",
    caller: { readEgressClass: "local_trusted" },
    sink: { type: "response", cloudAgentReachable: false },
  });

  // Unknown sensitivityTier → most-restrictive (restricted) → quarantine applies
  assert.equal(result.canMaterialize, false);
  assert.equal(result.redactionLevel, "full");
  assert.equal(result.processorSinkAllowed, false);
  assert.equal(result.auditRequired, true);
});

// B6: cloud_origin + restricted review gate
//   (a) unreviewed → canMaterialize=false for everyone (absolute deny)
//   (b) reviewed + local_trusted caller → canMaterialize=true, but trustLevel still cloud_origin
//       (reviewState=reviewed LIFTS quarantine for local-trusted audience; does NOT wash trust)
//
// B6a is already covered by B1-quarantine (unreviewed deny). The novel assertion here is
// B6b: reviewed + local_trusted must canMaterialize=true with sideEffectAllowed=false (trust not washed).

test("B6: cloud_origin + restricted + reviewed + local_trusted → canMaterialize=true but trust NOT washed (sideEffectAllowed=false)", () => {
  const result = effectiveEgress({
    brain: { egressClass: "public" },
    row: {
      sensitivityTier: "restricted",
      reviewState: "reviewed",
      originEgressClass: "cloud_origin",
      sourceTrustClass: "trusted",
    },
    requestedOperation: "read",
    caller: { readEgressClass: "local_trusted" },
    sink: { type: "response", cloudAgentReachable: false },
  });

  // Quarantine lifted: reviewed + local_trusted audience → materialization allowed
  assert.equal(result.canMaterialize, true);
  // Local-only (restricted tier) + local-trusted audience → local_metadata_only redaction
  assert.equal(result.redactionLevel, "local_metadata_only");
  // Processor sink: canMaterialize + not audienceCloudBound + sink not cloud-reachable → allowed
  assert.equal(result.processorSinkAllowed, true);

  // Trust NOT washed: cloud_origin writer taint persists after review
  assert.equal(result.trustLevel, "untrusted");
  assert.equal(result.sideEffectAllowed, false);

  // Provenance required: materializing cloud_origin/untrusted row to local-trusted audience
  assert.ok(result.provenanceFieldsRequired.length > 0, "provenanceFieldsRequired must be non-empty");
  assert.ok(result.provenanceFieldsRequired.includes("originEgressClass"));
  assert.ok(result.provenanceFieldsRequired.includes("sourceTrustClass"));

  // Audit required: untrusted content
  assert.equal(result.auditRequired, true);
});

// B5-processorSinkAllowed-fail-closed: caller present + absent sink.cloudAgentReachable
//   → processorSinkAllowed must be false (fail-closed: absent → treat as cloud-reachable)
test("B5-processorSinkAllowed-fail-closed: local_trusted caller + restricted row + absent sink.cloudAgentReachable → processorSinkAllowed=false", () => {
  const result = effectiveEgress({
    brain: { egressClass: "public" },
    row: {
      sensitivityTier: "restricted",
      reviewState: "none",
      originEgressClass: "local_trusted",
      sourceTrustClass: "trusted",
    },
    requestedOperation: "process",
    caller: { readEgressClass: "local_trusted" },
    sink: { type: "processor" }, // cloudAgentReachable absent → fail-closed → must treat as cloud-reachable
  });

  // canMaterialize: local_trusted caller + restricted → true
  assert.equal(result.canMaterialize, true);
  // processorSinkAllowed: sink.cloudAgentReachable absent → most-restrictive (cloud-reachable) → false
  assert.equal(result.processorSinkAllowed, false);
});

// B5-quarantine-absent-origin: absent originEgressClass + restricted + unreviewed
//   → fail-closed: unknown originEgressClass must be treated as cloud_origin (most restrictive)
//   → quarantine fires → canMaterialize=false
test("B5-quarantine-absent-origin: absent originEgressClass + restricted + unreviewed → canMaterialize=false (fail-closed quarantine)", () => {
  const result = effectiveEgress({
    brain: { egressClass: "public" },
    row: {
      sensitivityTier: "restricted",
      reviewState: "unreviewed",
      // originEgressClass intentionally absent → most-restrictive = cloud_origin
      sourceTrustClass: "trusted",
    },
    requestedOperation: "read",
    caller: { readEgressClass: "local_trusted" },
    sink: { type: "response", cloudAgentReachable: false },
  });

  // Unknown originEgressClass on restricted+unreviewed → treat as cloud_origin → quarantine → deny
  assert.equal(result.canMaterialize, false);
  assert.equal(result.redactionLevel, "full");
  assert.equal(result.processorSinkAllowed, false);
  assert.equal(result.auditRequired, true);
});

// B7: background materializer (caller=null) + restricted row + sink.cloudAgentReachable=true
//   → audience is the sink (cloud-reachable) → canMaterialize=false
//   (local-only content must not go to a cloud-reachable sink in a background job)
test("B7: background job (caller=null) + restricted row + cloudAgentReachable=true sink → canMaterialize=false", () => {
  const result = effectiveEgress({
    brain: { egressClass: "public" },
    row: {
      sensitivityTier: "restricted",
      reviewState: "none",
      originEgressClass: "local_trusted",
      sourceTrustClass: "trusted",
    },
    requestedOperation: "process",
    caller: null,
    sink: { type: "graph_projection", cloudAgentReachable: true },
  });

  // Audience is the sink (background job); sink is cloud-reachable → cloud_bound audience
  // Local-only (restricted) + cloud_bound audience → canMaterialize=false
  assert.equal(result.canMaterialize, false);
  assert.equal(result.redactionLevel, "full");
  assert.equal(result.processorSinkAllowed, false);

  // Trust: local_trusted origin + trusted source → trusted (separate from confidentiality)
  assert.equal(result.trustLevel, "trusted");
  assert.equal(result.sideEffectAllowed, true);

  // Provenance not required (not materializing)
  assert.deepEqual(result.provenanceFieldsRequired, []);

  // Audit required on denial
  assert.equal(result.auditRequired, true);
});

// B8: writer≠content trust — separate trust axes
//   standard-tier row, originEgressClass=local_trusted (writer is local, NOT cloud_origin),
//   BUT sourceTrustClass=untrusted (the content/source itself is untrusted — e.g. external import).
//   local_trusted caller. Confidentiality: standard+public → not local-only → canMaterialize=true.
//   Trust: trustLevel = WORST of writer taint and content/source trust.
//   writer is local_trusted (not tainted), but sourceTrustClass=untrusted → trust axis: untrusted.
//   EXPECTED: canMaterialize=true, trustLevel=untrusted, sideEffectAllowed=false.
//   The two trust axes are INDEPENDENT — a local writer importing untrusted content is still untrusted.
test("B8: local_trusted writer + untrusted source + standard-tier + local_trusted caller → canMaterialize=true, trustLevel=untrusted, sideEffectAllowed=false", () => {
  const result = effectiveEgress({
    brain: { egressClass: "public" },
    row: {
      sensitivityTier: "standard",
      reviewState: "none",
      originEgressClass: "local_trusted",   // writer is local (NOT cloud_origin)
      sourceTrustClass: "untrusted",         // content/source is untrusted (external import)
    },
    requestedOperation: "read",
    caller: { readEgressClass: "local_trusted" },
    sink: { type: "response", cloudAgentReachable: false },
  });

  // Confidentiality: standard tier + public brain → not local-only → materialize
  assert.equal(result.canMaterialize, true);
  assert.equal(result.redactionLevel, "none");
  // Processor sink: local_trusted caller + sink not cloud-reachable → allowed
  assert.equal(result.processorSinkAllowed, true);

  // Trust: worst of writer(local_trusted=not tainted) and source(untrusted) → untrusted
  // This verifies the two trust axes are independent: a good writer cannot redeem untrusted content.
  assert.equal(result.trustLevel, "untrusted");
  assert.equal(result.sideEffectAllowed, false);

  // Provenance required: materializing untrusted row to local-trusted audience
  assert.deepEqual(result.provenanceFieldsRequired, ["originEgressClass", "sourceTrustClass"]);

  // Audit required: untrusted content
  assert.equal(result.auditRequired, true);
});

// B9-reviewState-none: 'none' is a distinct enum value (none|unreviewed|reviewed), NOT 'unreviewed'.
//   The quarantine gate fires ONLY on 'unreviewed' (and absent/unknown, fail-closed). A
//   cloud_origin + restricted row whose reviewState is the explicit value 'none' has no
//   quarantine workflow applied and must NOT be quarantined — it materializes for a
//   local_trusted audience (confidentiality), while trust stays untrusted (cloud_origin taint).
//   Spec line 253: quarantine case is exactly 'cloud_origin+restricted+unreviewed'.
test("B9-reviewState-none: cloud_origin + restricted + reviewState='none' + local_trusted → canMaterialize=true, trust not washed", () => {
  const result = effectiveEgress({
    brain: { egressClass: "public" },
    row: {
      sensitivityTier: "restricted",
      reviewState: "none", // explicit 'none' — distinct from 'unreviewed'; no quarantine
      originEgressClass: "cloud_origin",
      sourceTrustClass: "trusted",
    },
    requestedOperation: "read",
    caller: { readEgressClass: "local_trusted" },
    sink: { type: "response", cloudAgentReachable: false },
  });

  // Not quarantined (reviewState is 'none', not 'unreviewed') → local-trusted audience materializes
  assert.equal(result.canMaterialize, true);
  assert.equal(result.redactionLevel, "local_metadata_only");
  assert.equal(result.processorSinkAllowed, true);

  // Trust NOT washed: cloud_origin writer taint persists
  assert.equal(result.trustLevel, "untrusted");
  assert.equal(result.sideEffectAllowed, false);

  // Provenance required: materializing cloud_origin row to a local-trusted audience
  assert.deepEqual(result.provenanceFieldsRequired, ["originEgressClass", "sourceTrustClass"]);

  // Audit required: untrusted content
  assert.equal(result.auditRequired, true);
});

// B5: standard-tier row with cloud_origin materialized to local_trusted caller
//   → canMaterialize=true (not local-only), but trustLevel=untrusted and sideEffectAllowed=false
//   → provenanceFieldsRequired is non-empty (materializing cloud_origin to local-trusted audience)
test("B5: standard-tier + cloud_origin + local_trusted caller → canMaterialize=true, untrusted, provenanceFieldsRequired non-empty", () => {
  const result = effectiveEgress({
    brain: { egressClass: "public" },
    row: {
      sensitivityTier: "standard",
      reviewState: "none",
      originEgressClass: "cloud_origin",
      sourceTrustClass: "trusted",
    },
    requestedOperation: "read",
    caller: { readEgressClass: "local_trusted" },
    sink: { type: "response", cloudAgentReachable: false },
  });

  // Confidentiality: standard tier + public brain → not local-only → materializes
  assert.equal(result.canMaterialize, true);
  // Standard tier, not local-only → no metadata redaction
  assert.equal(result.redactionLevel, "none");
  // Processor sink allowed (local_trusted audience + sink not cloud-reachable)
  assert.equal(result.processorSinkAllowed, true);

  // Trust: cloud_origin writer taint → untrusted on TRUST axis (separate from confidentiality)
  assert.equal(result.trustLevel, "untrusted");
  assert.equal(result.sideEffectAllowed, false);

  // Provenance fields required: materializing cloud_origin to a local-trusted audience
  assert.ok(result.provenanceFieldsRequired.length > 0, "provenanceFieldsRequired must be non-empty");
  assert.ok(result.provenanceFieldsRequired.includes("originEgressClass"));
  assert.ok(result.provenanceFieldsRequired.includes("sourceTrustClass"));

  // Audit required: untrusted content
  assert.equal(result.auditRequired, true);
});
