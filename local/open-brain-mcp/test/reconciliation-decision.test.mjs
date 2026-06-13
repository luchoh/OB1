// Reconciliation decision core — pure decision-table tests (PRD docs/39).
// Covers the full matrix from the PRD Testing section: identity hit, no match,
// above skip, reconcile band (existing richer / incoming richer / equal),
// below band, embedding failure (must yield add), and threshold boundaries.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  decideReconciliation,
  DECISION,
  DEFAULT_THRESHOLDS,
  rawLengthRichness,
  LABEL_TO_DECISION,
} from "../src/reconciliation-decision.mjs";

const longer = "x".repeat(200);
const shorter = "x".repeat(50);

describe("decideReconciliation — failure and identity", () => {
  it("fails open to add when the semantic check errors (never drops)", () => {
    const r = decideReconciliation({ embeddingError: true, incomingContent: "anything" });
    assert.equal(r.decision, DECISION.ADD);
    assert.equal(r.reason, "semantic_check_failed");
  });

  it("treats an exact identity-dedup hit as a skip-class duplicate", () => {
    const r = decideReconciliation({ identityDedupHit: true, incomingContent: "x" });
    assert.equal(r.decision, DECISION.SKIP);
    assert.equal(r.reason, "identity_duplicate");
  });

  it("error wins over identity (both set -> add, not skip)", () => {
    const r = decideReconciliation({ embeddingError: true, identityDedupHit: true });
    assert.equal(r.decision, DECISION.ADD);
  });
});

describe("decideReconciliation — no / weak match", () => {
  it("adds when there is no semantic match", () => {
    assert.equal(decideReconciliation({ match: null }).decision, DECISION.ADD);
    assert.equal(decideReconciliation({ match: null }).reason, "no_semantic_match");
  });

  it("adds when the best match sits below the reconcile floor", () => {
    const r = decideReconciliation({
      match: { similarity: 0.89, existingContent: longer },
      incomingContent: shorter,
    });
    assert.equal(r.decision, DECISION.ADD);
    assert.equal(r.reason, "below_reconcile_band");
  });

  it("guards against NaN similarity (-> add, not a throw)", () => {
    assert.equal(decideReconciliation({ match: { similarity: NaN } }).decision, DECISION.ADD);
  });
});

describe("decideReconciliation — skip band", () => {
  it("skips at/above the skip threshold regardless of richness", () => {
    const r = decideReconciliation({
      match: { similarity: 0.97, existingContent: shorter },
      incomingContent: longer, // incoming richer, but above skip => still skip
    });
    assert.equal(r.decision, DECISION.SKIP);
    assert.equal(r.reason, "above_skip_threshold");
  });

  it("boundary: exactly at the skip threshold is a skip", () => {
    const r = decideReconciliation({
      match: { similarity: DEFAULT_THRESHOLDS.skip, existingContent: shorter },
      incomingContent: longer,
    });
    assert.equal(r.decision, DECISION.SKIP);
  });
});

describe("decideReconciliation — reconcile band (richer side wins)", () => {
  it("existing richer -> append_evidence", () => {
    const r = decideReconciliation({
      match: { similarity: 0.92, existingContent: longer },
      incomingContent: shorter,
    });
    assert.equal(r.decision, DECISION.APPEND_EVIDENCE);
    assert.equal(r.reason, "reconcile_existing_richer");
  });

  it("incoming richer -> create_revision", () => {
    const r = decideReconciliation({
      match: { similarity: 0.92, existingContent: shorter },
      incomingContent: longer,
    });
    assert.equal(r.decision, DECISION.CREATE_REVISION);
    assert.equal(r.reason, "reconcile_incoming_richer");
  });

  it("equal richness -> the configured tie outcome (default append_evidence)", () => {
    const r = decideReconciliation({
      match: { similarity: 0.92, existingContent: shorter },
      incomingContent: shorter,
    });
    assert.equal(r.decision, DECISION.APPEND_EVIDENCE);
    assert.equal(r.reason, "reconcile_equal_richness");
  });

  it("tie outcome is configurable (create_revision)", () => {
    const r = decideReconciliation({
      match: { similarity: 0.92, existingContent: shorter },
      incomingContent: shorter,
      thresholds: { ...DEFAULT_THRESHOLDS, tie: DECISION.CREATE_REVISION },
    });
    assert.equal(r.decision, DECISION.CREATE_REVISION);
  });

  it("boundary: exactly at the reconcile floor enters the band", () => {
    const r = decideReconciliation({
      match: { similarity: DEFAULT_THRESHOLDS.reconcile, existingContent: longer },
      incomingContent: shorter,
    });
    assert.equal(r.decision, DECISION.APPEND_EVIDENCE);
  });
});

describe("decideReconciliation — tunable thresholds (harness contract)", () => {
  it("honors overridden skip/reconcile bands", () => {
    // With a conservative band, a 0.92 match that was reconcile under defaults
    // now falls below the floor -> add.
    const conservative = { skip: 0.97, reconcile: 0.94, tie: DECISION.APPEND_EVIDENCE };
    const r = decideReconciliation({
      match: { similarity: 0.92, existingContent: longer },
      incomingContent: shorter,
      thresholds: conservative,
    });
    assert.equal(r.decision, DECISION.ADD);
  });

  it("honors a custom richness heuristic", () => {
    // word-count richness flips the verdict vs raw-length on the same pair
    const wordCount = (t) => (t ? t.trim().split(/\s+/).length : 0);
    const r = decideReconciliation({
      match: { similarity: 0.92, existingContent: "aaaaaaaaaaaaaaaaaaaa" }, // 1 long word
      incomingContent: "a b c", // 3 words, fewer chars
      richness: wordCount,
    });
    assert.equal(r.decision, DECISION.CREATE_REVISION); // incoming richer by words
  });
});

describe("LABEL_TO_DECISION mapping (scorer contract)", () => {
  it("maps each judge label to the decision the core should produce", () => {
    assert.equal(LABEL_TO_DECISION.duplicate, DECISION.SKIP);
    assert.equal(LABEL_TO_DECISION.same_fact_richer_existing, DECISION.APPEND_EVIDENCE);
    assert.equal(LABEL_TO_DECISION.same_fact_richer_incoming, DECISION.CREATE_REVISION);
    assert.equal(LABEL_TO_DECISION.distinct, DECISION.ADD);
  });

  it("rawLengthRichness counts characters", () => {
    assert.equal(rawLengthRichness("hello"), 5);
    assert.equal(rawLengthRichness(""), 0);
    assert.equal(rawLengthRichness(null), 0);
  });
});
