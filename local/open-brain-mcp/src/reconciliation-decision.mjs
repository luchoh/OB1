// reconciliation-decision.mjs — PRD docs/39 Package 3, the decision core.
//
// A PURE function (story 19): no DB, no network, no I/O, testable in
// milliseconds. Maps (identity-dedup outcome, the best semantic match with its
// similarity + content lengths, configured thresholds) to one of four
// decisions plus a machine-readable reason. This is the unit the calibration
// eval-harness tunes (the "train.py" analog) before Package 3 is wired to the
// capture path.
//
// Decision semantics (PRD, following upstream smart-ingest):
//   * at/above the skip threshold  -> duplicate, SKIP
//   * in the reconcile band        -> the RICHER side wins:
//       existing richer -> APPEND_EVIDENCE (attach incoming to it)
//       incoming richer -> CREATE_REVISION (new thought superseding existing)
//   * below the band               -> plain ADD
// Failure semantics differ from upstream on purpose: where upstream fails
// closed (skip on error), we fall back to ADD with the error recorded — in a
// personal memory system, storing a duplicate is recoverable; dropping a
// thought is not.

export const DECISION = Object.freeze({
  ADD: "add",
  SKIP: "skip",
  APPEND_EVIDENCE: "append_evidence",
  CREATE_REVISION: "create_revision",
});

// The triple-corroborated Qwen band (docs/39). Kept in ONE place; the
// eval-harness overrides these to search for tuned values. `tie` is the
// reconcile-band equal-richness tie-break (PRD left it open; default to the
// conservative no-new-row outcome).
export const DEFAULT_THRESHOLDS = Object.freeze({
  skip: 0.95,
  reconcile: 0.9,
  tie: DECISION.APPEND_EVIDENCE,
});

// Richness heuristic: raw content length (PRD adopts upstream's initially).
// Pluggable so the harness can try variants (e.g. token count, info density).
export function rawLengthRichness(text) {
  return typeof text === "string" ? text.length : 0;
}

// decideReconciliation(input) -> { decision, reason }
// input:
//   identityDedupHit?: boolean   — exact dedupe-key hit (handled by the capture
//                                  upsert; recorded here as a skip-class outcome)
//   embeddingError?: boolean     — the semantic lookup failed/unavailable
//   match?: { similarity: number, existingContent?: string } | null
//                                — the single best semantic neighbor, or null
//   incomingContent?: string     — the text being captured (for richness)
//   thresholds?: { skip, reconcile, tie }
//   richness?: (text) => number
export function decideReconciliation(input) {
  const {
    identityDedupHit = false,
    embeddingError = false,
    match = null,
    incomingContent = "",
    thresholds = DEFAULT_THRESHOLDS,
    richness = rawLengthRichness,
  } = input ?? {};

  // Fail open: a broken semantic check degrades to plain add, never to a drop.
  if (embeddingError) {
    return { decision: DECISION.ADD, reason: "semantic_check_failed" };
  }

  // Exact identity duplicate (same dedupe key) is the strongest duplicate.
  if (identityDedupHit) {
    return { decision: DECISION.SKIP, reason: "identity_duplicate" };
  }

  // No neighbor at all -> plain add.
  if (!match || typeof match.similarity !== "number" || Number.isNaN(match.similarity)) {
    return { decision: DECISION.ADD, reason: "no_semantic_match" };
  }

  const { similarity } = match;

  if (similarity >= thresholds.skip) {
    return { decision: DECISION.SKIP, reason: "above_skip_threshold" };
  }

  if (similarity >= thresholds.reconcile) {
    const incoming = richness(incomingContent);
    const existing = richness(match.existingContent ?? "");
    if (incoming > existing) {
      return { decision: DECISION.CREATE_REVISION, reason: "reconcile_incoming_richer" };
    }
    if (existing > incoming) {
      return { decision: DECISION.APPEND_EVIDENCE, reason: "reconcile_existing_richer" };
    }
    return {
      decision: thresholds.tie ?? DECISION.APPEND_EVIDENCE,
      reason: "reconcile_equal_richness",
    };
  }

  return { decision: DECISION.ADD, reason: "below_reconcile_band" };
}

// Map an LLM-judge label to the decision the core SHOULD produce, for scoring.
// Labels (eval-harness): duplicate | same_fact_richer_existing |
// same_fact_richer_incoming | distinct.
export const LABEL_TO_DECISION = Object.freeze({
  duplicate: DECISION.SKIP,
  same_fact_richer_existing: DECISION.APPEND_EVIDENCE,
  same_fact_richer_incoming: DECISION.CREATE_REVISION,
  distinct: DECISION.ADD,
});
