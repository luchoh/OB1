// Access policy — the pure rules deciding what a principal may do.
//
// This module is the single home for OB1's permission *decisions*: which brains
// a caller may name, which they may use, and which actions (read, write, delete,
// restore, purge) they may perform on a resolved brain. It encodes the v24
// decision surface as amended by ADR-0002 (the enforced monotone role ladder)
// and ADR-0003 (estate-bound admin reach; retirement of the brain-bound-key
// naming clamp).
//
// PURITY CONTRACT (the whole point of the module): no config/db/pg/jose import,
// no I/O, no throw-for-control-flow. Inputs are plain data an adapter fetches;
// outputs are verdict data. Refusals are returned as `denied`/`not_found`/...
// verdicts, never thrown — throwing is reserved for programmer error (a bad
// argument shape), which is a bug, not a control-flow path. This is what lets
// the suite run with zero infrastructure.
//
// Mapping verdicts to HTTP statuses, fetching membership rows, and reading the
// caller off the wire are the Stage-2 adapter's jobs, not this module's.

// ---------------------------------------------------------------------------
// Vocabulary (CONTEXT.md-bound)
// ---------------------------------------------------------------------------

// The five concrete actions. Rules behind the seam may coarsen, but the verbs a
// caller authorizes against are exactly these (PRD docs/34).
export const ACTIONS = Object.freeze({
  READ: "read",
  WRITE: "write",
  DELETE: "delete",
  RESTORE: "restore",
  PURGE: "purge",
});

// Brain membership roles form a monotone ladder: viewer ⊂ editor ⊂ owner
// (ADR-0002). Purge is outside the ladder entirely.
export const BRAIN_ROLES = Object.freeze({
  VIEWER: "viewer",
  EDITOR: "editor",
  OWNER: "owner",
});

// Estate membership roles: member ⊂ admin (ADR-0002).
export const ESTATE_ROLES = Object.freeze({
  MEMBER: "member",
  ADMIN: "admin",
});

// Caller shapes, mirroring the auth module's authSource values.
export const CALLER_KINDS = Object.freeze({
  HUMAN_TOKEN: "human_token",
  SERVICE_KEY: "service_key",
  LEGACY_ADMIN_KEY: "legacy_admin_key",
});

// Verdict kinds. Action authorization yields ALLOW or DENIED; selector
// resolution yields RESOLVED / NOT_FOUND / DENIED / AMBIGUOUS; comparing two
// selectors yields SELECTOR_CONFLICT.
export const VERDICTS = Object.freeze({
  ALLOW: "allow",
  DENIED: "denied",
  RESOLVED: "resolved",
  NOT_FOUND: "not_found",
  AMBIGUOUS: "ambiguous",
  SELECTOR_CONFLICT: "selector_conflict",
});

// The `reason` carried by a DENIED verdict. The Stage-2 adapter switches on
// these to choose an HTTP status and an audit annotation, so they are a
// contract, not free text — frozen here and asserted in the suite.
export const DENY_REASONS = Object.freeze({
  BRAIN_DENY: "brain_deny",
  INSUFFICIENT_ROLE: "insufficient_role",
  NOT_AUTHORIZED: "not_authorized",
  LEGACY_ADMIN_CANNOT_PURGE: "legacy_admin_cannot_purge",
  PURGE_REQUIRES_NAMED_ADMIN_SERVICE_KEY: "purge_requires_named_admin_service_key",
});

// ---------------------------------------------------------------------------
// Verdict constructors
// ---------------------------------------------------------------------------

// `actor` is the audit descriptor a Stage-2 adapter stamps onto the write it
// performs. Same shape the auth module's authorize* functions return today.
function allow(actor) {
  return { kind: VERDICTS.ALLOW, actor };
}
function denied(reason) {
  return { kind: VERDICTS.DENIED, reason };
}
function resolved(brain) {
  return { kind: VERDICTS.RESOLVED, brain: { brainId: brain.brainId, brainSlug: brain.brainSlug ?? null } };
}
function notFound() {
  return { kind: VERDICTS.NOT_FOUND };
}
function ambiguous() {
  return { kind: VERDICTS.AMBIGUOUS };
}
function selectorConflict() {
  return { kind: VERDICTS.SELECTOR_CONFLICT };
}

// The audit actor descriptor for an allow verdict.
function makeActor(caller) {
  return {
    auth_source: caller.kind,
    principal_id: caller.principalId ?? null,
    is_admin: Boolean(caller.isAdmin),
  };
}

// ---------------------------------------------------------------------------
// Selector classification
// ---------------------------------------------------------------------------

const BRAIN_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A selector is either a brain UUID or a brain slug. UUID-ness governs the
// not-found-vs-denied asymmetry (see resolveSelector): a known UUID is proof
// enough to learn a brain exists; a guessed slug is not.
export function isBrainUuid(selector) {
  return typeof selector === "string" && BRAIN_UUID_RE.test(selector);
}

// ---------------------------------------------------------------------------
// Caller-shape predicates
// ---------------------------------------------------------------------------

function isLegacyAdmin(caller) {
  return caller.kind === CALLER_KINDS.LEGACY_ADMIN_KEY;
}

// A stored is_admin key whose reach (ADR-0003) is its home estate ∪ its
// membership-derived scope. Covers both legacy and stored admin via caller.isAdmin
// elsewhere; this names the stored-admin case for clarity.
function isStoredAdmin(caller) {
  return Boolean(caller.isAdmin) && caller.kind !== CALLER_KINDS.LEGACY_ADMIN_KEY;
}

// Purge is key-shape-gated (ADR-0002 D9 / ADR-0003): a NAMED admin service key
// only — stored is_admin, service_key shape, attributable principal. The bare
// legacy env key (unattributable) is forbidden; estate-admin/owner roles never
// confer purge.
function isNamedAdminServiceKey(caller) {
  return (
    Boolean(caller.isAdmin) &&
    caller.kind === CALLER_KINDS.SERVICE_KEY &&
    caller.principalId != null
  );
}

// ---------------------------------------------------------------------------
// Action authorization — the exhaustive decision core
// ---------------------------------------------------------------------------

// Capability of a principal (non-admin) on a single resolved brain, given the
// brain role and estate role that apply to it. Roles are additive (OR), not
// clamping: a brain `viewer` who is also estate `admin` gets the admin
// capability. Only a brain-level DENY clamps, and that is handled before this
// runs. estate `member` is read-only (ADR-0002).
function principalCan(action, brainRole, estateRole) {
  switch (action) {
    case ACTIONS.READ:
      return (
        brainRole === BRAIN_ROLES.VIEWER ||
        brainRole === BRAIN_ROLES.EDITOR ||
        brainRole === BRAIN_ROLES.OWNER ||
        estateRole === ESTATE_ROLES.MEMBER ||
        estateRole === ESTATE_ROLES.ADMIN
      );
    case ACTIONS.WRITE:
      return (
        brainRole === BRAIN_ROLES.EDITOR ||
        brainRole === BRAIN_ROLES.OWNER ||
        estateRole === ESTATE_ROLES.ADMIN
      );
    case ACTIONS.DELETE:
    case ACTIONS.RESTORE:
      return brainRole === BRAIN_ROLES.OWNER || estateRole === ESTATE_ROLES.ADMIN;
    case ACTIONS.PURGE:
      // Never via a role. A principal cannot purge.
      return false;
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// Authorize a single action on an already-resolved brain. The brain is assumed
// in the caller's reach (selector resolution enforced that); this decides
// *capability*. `brainMembership` / `estateMembership` describe the caller's
// relationship to THIS brain and THIS brain's estate (or null when none).
//
// Inputs:
//   caller           : { kind, principalId, isAdmin, ... }
//   action           : one of ACTIONS
//   brainMembership  : { role, isDeny } | null
//   estateMembership : { role, isDeny } | null
// Returns: allow(actor) | denied(reason)
export function authorizeAction({ caller, action, brainMembership = null, estateMembership = null }) {
  if (!Object.values(ACTIONS).includes(action)) {
    throw new Error(`Unknown action: ${action}`);
  }

  const actor = makeActor(caller);

  // Brain-level DENY overrides EVERYTHING (ADR-0002), including admin keys. A
  // DENY row on the caller's own principal blocks the action even for a stored
  // admin key. (Legacy admin has no memberships, so this never fires for it.)
  if (brainMembership?.isDeny) {
    return denied(DENY_REASONS.BRAIN_DENY);
  }

  // Legacy env key: the only global actor (documented blast radius). Full CRUD
  // on its resolved brain, but NEVER purge — it is unattributable (D9).
  if (isLegacyAdmin(caller)) {
    if (action === ACTIONS.PURGE) {
      return denied(DENY_REASONS.LEGACY_ADMIN_CANNOT_PURGE);
    }
    return allow(actor);
  }

  // Stored admin key: full CRUD within its reach (read/write/delete/restore).
  // Purge requires the named-admin-service-key shape, which a stored admin key
  // satisfies — but we re-check the shape so the gate lives in one predicate.
  if (isStoredAdmin(caller)) {
    if (action === ACTIONS.PURGE) {
      return isNamedAdminServiceKey(caller)
        ? allow(actor)
        : denied(DENY_REASONS.PURGE_REQUIRES_NAMED_ADMIN_SERVICE_KEY);
    }
    return allow(actor);
  }

  // Principal: the role ladder. Estate DENY rows are treated as ABSENT
  // membership (fail-closed, ADR-0002) — collapse them to null here.
  const brainRole = brainMembership && !brainMembership.isDeny ? brainMembership.role : null;
  const estateRole = estateMembership && !estateMembership.isDeny ? estateMembership.role : null;

  return principalCan(action, brainRole, estateRole)
    ? allow(actor)
    : denied(DENY_REASONS.INSUFFICIENT_ROLE);
}

// ---------------------------------------------------------------------------
// Scope derivation
// ---------------------------------------------------------------------------

// Derive the two brain sets a caller has, from membership rows and a brain
// catalog. The catalog is the candidate set the adapter fetched: every brain
// reachable via a brain membership, an estate membership, or (for an admin key)
// the caller's home estate. Each catalog entry is { brainId, brainSlug, estateId }.
//
//   accessible — brains the caller may USE (the fanout target for an unscoped
//                read; the set an action may operate on).
//   lookup     — brains the caller may NAME. A superset of accessible: it also
//                includes estate-granted brains hidden by a brain-level DENY, so
//                naming them resolves-then-denies (403) rather than 404s.
//
// Inputs:
//   caller            : { isAdmin, homeEstateId, kind, readEgressClass, ... }
//   brainMemberships  : [{ brainId, role, isDeny }]
//   estateMemberships : [{ estateId, role, isDeny }]
//   catalog           : [{ brainId, brainSlug, estateId, egressClass? }]
//   egressMode        : 'off' | 'observe' | 'enforce'  (absent → 'off')
// Returns: { accessible: [{brainId,brainSlug}], accessibleIds: Set, lookup: [{brainId,brainSlug}], egressExcluded: [{brainId,brainSlug}] }
export function deriveScope({ caller, brainMemberships = [], estateMemberships = [], catalog = [], egressMode }) {
  const estateAllowed = new Set(
    estateMemberships.filter((m) => !m.isDeny).map((m) => m.estateId),
  );

  const accessible = [];
  const accessibleIds = new Set();
  const lookup = [];
  const seen = new Set();

  for (const brain of catalog) {
    if (seen.has(brain.brainId)) continue; // dedupe a catalog with repeats
    seen.add(brain.brainId);

    const rows = brainMemberships.filter((m) => m.brainId === brain.brainId);
    const hasDenyBrain = rows.some((m) => m.isDeny);
    const hasGrantBrain = rows.some((m) => !m.isDeny);
    const estateOk = estateAllowed.has(brain.estateId);
    // ADR-0003: a stored admin key reaches every brain in its home estate, even
    // without an explicit membership row.
    const adminHomeReach = Boolean(caller.isAdmin) && brain.estateId === caller.homeEstateId;

    const ref = { brainId: brain.brainId, brainSlug: brain.brainSlug ?? null };

    // DENY overrides every grant path (ADR-0002, fail-closed).
    const isAccessible = !hasDenyBrain && (hasGrantBrain || adminHomeReach || estateOk);
    // Nameable if any grant path exists. A brain-DENY does not strip
    // nameability that an estate grant / admin reach provides (resolve-then-403);
    // but a pure brain-DENY with no other grant is NOT nameable (404).
    const isNameable = hasGrantBrain || adminHomeReach || estateOk;

    if (isAccessible) {
      accessible.push(ref);
      accessibleIds.add(brain.brainId);
    }
    if (isNameable) {
      lookup.push(ref);
    }
  }

  // --- Layer-A egress enforcement (§6.13/§6.2/§9) ---
  // egressMode absent or 'off': NO filtering. Return as-is.
  // egressMode 'observe': compute egressExcluded but leave accessible/lookup unchanged.
  // egressMode 'enforce': remove local-only brains from accessible, accessibleIds, AND lookup
  //                       for a cloud-bound caller; populate egressExcluded.
  //
  // A brain is LOCAL-ONLY when its egressClass ∉ {public, repo} (fail-closed: absent/unknown → local-only).
  // A caller is cloud-bound when readEgressClass !== 'local_trusted' (fail-closed: absent/unknown → cloud-bound).

  const mode = egressMode ?? "off";
  if (mode === "off") {
    return { accessible, accessibleIds, lookup, egressExcluded: [] };
  }

  const callerIsCloudBound = caller.readEgressClass !== CALLER_EGRESS_CLASS.LOCAL_TRUSTED;
  if (!callerIsCloudBound) {
    // Local-trusted caller: no exclusion regardless of mode.
    return { accessible, accessibleIds, lookup, egressExcluded: [] };
  }

  // Collect ALL nameable (lookup) brains that are local-only — not just accessible ones.
  // A DENY-shadowed brain lands in lookup but not accessible; it must also be stripped
  // from lookup to prevent existence leaks (spec: 'so a cloud-bound caller naming a
  // local-only brain resolves NOT_FOUND, never a denied/exists leak').
  const egressExcluded = [];
  const seenEgress = new Set();
  for (const ref of lookup) {
    if (seenEgress.has(ref.brainId)) continue;
    seenEgress.add(ref.brainId);
    // Find the catalog entry to check egressClass.
    const entry = catalog.find((b) => b.brainId === ref.brainId);
    const ec = entry?.egressClass;
    const localOnly =
      ec !== BRAIN_EGRESS_CLASS.PUBLIC && ec !== BRAIN_EGRESS_CLASS.REPO;
    if (localOnly) {
      egressExcluded.push({ brainId: ref.brainId, brainSlug: ref.brainSlug });
    }
  }

  if (mode === "observe" || egressExcluded.length === 0) {
    // observe: report but don't alter accessible/lookup.
    return { accessible, accessibleIds, lookup, egressExcluded };
  }

  // enforce: remove excluded brains from accessible, accessibleIds, and lookup.
  const excludedIds = new Set(egressExcluded.map((b) => b.brainId));
  const filteredAccessible = accessible.filter((b) => !excludedIds.has(b.brainId));
  const filteredAccessibleIds = new Set([...accessibleIds].filter((id) => !excludedIds.has(id)));
  const filteredLookup = lookup.filter((b) => !excludedIds.has(b.brainId));

  return {
    accessible: filteredAccessible,
    accessibleIds: filteredAccessibleIds,
    lookup: filteredLookup,
    egressExcluded,
  };
}

// ---------------------------------------------------------------------------
// Selector resolution
// ---------------------------------------------------------------------------

// Resolve a slug-or-UUID selector against a derived scope (the unified path for
// human tokens, service keys, and stored admin keys per ADR-0003).
//
// Verdicts:
//   resolved   — selector names an accessible brain.
//   denied     — selector names a brain the caller may not use:
//                  * a UUID/slug in `lookup` but not `accessible`
//                    (estate-granted, brain-DENY-shadowed), OR
//                  * a UUID that exists somewhere out of scope (existsGlobally).
//   ambiguous  — a slug matching more than one nameable brain.
//   not_found  — selector matches nothing nameable. For a slug this hides
//                existence (a guessed slug learns nothing); for a UUID it means
//                the brain does not exist at all.
//
// `existsGlobally` (UUID selectors only) tells whether the UUID names a real
// brain outside the caller's scope; the adapter supplies it. It is the only
// existence fact the pure module cannot derive from scope alone, and it drives
// the deliberate UUID-vs-slug asymmetry above.
export function resolveSelector({ selector, scope, existsGlobally = false }) {
  if (isBrainUuid(selector)) {
    const hit = scope.accessible.find((b) => b.brainId === selector);
    if (hit) return resolved(hit);

    const shadowed = scope.lookup.find((b) => b.brainId === selector);
    if (shadowed) return denied(DENY_REASONS.NOT_AUTHORIZED);

    // If the UUID was stripped by egress enforcement (§6.13/§9), treat as not_found.
    // A cloud-bound caller must never learn a local-only brain exists via the UUID path.
    if (scope.egressExcluded?.some((b) => b.brainId === selector)) return notFound();

    // Knowing the UUID is proof enough to learn it exists — reveal as 403, not 404.
    if (existsGlobally) return denied(DENY_REASONS.NOT_AUTHORIZED);

    return notFound();
  }

  // Slug: ambiguity and existence are scope-relative. Dedupe by brainId so a
  // catalog that lists the same brain twice does not read as ambiguous.
  const seen = new Set();
  const matches = scope.lookup.filter((b) => {
    if (b.brainSlug !== selector) return false;
    if (seen.has(b.brainId)) return false;
    seen.add(b.brainId);
    return true;
  });

  if (matches.length === 0) return notFound();
  if (matches.length > 1) return ambiguous();

  const match = matches[0];
  return scope.accessibleIds.has(match.brainId) ? resolved(match) : denied(DENY_REASONS.NOT_AUTHORIZED);
}

// Resolve a selector for the bare legacy env key, which has GLOBAL reach and so
// never produces a `denied` resolution verdict — only resolved / not_found /
// ambiguous. `candidates` are the brains matching the selector globally, which
// the adapter supplies (it cannot be derived from a scope, the legacy key having
// none). Each candidate is { brainId, brainSlug }.
export function resolveSelectorGlobal({ candidates = [] }) {
  if (candidates.length === 0) return notFound();
  if (candidates.length > 1) return ambiguous();
  return resolved(candidates[0]);
}

// Compare an L1 selector resolution (route/query/header) with a body/tool-arg
// resolution. If both resolved to brains and they differ, the request carries
// conflicting selectors — a 400, not a silent override (v24 D3). Returns the
// conflict verdict, or null when there is no conflict. Inputs are the resolved
// brain refs ({ brainId } each) or null.
export function detectSelectorConflict(l1Brain, bodyBrain) {
  if (l1Brain && bodyBrain && l1Brain.brainId !== bodyBrain.brainId) {
    return selectorConflict();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Effective egress — §6.15 cloud-egress boundary (pure, slice 1)
// ---------------------------------------------------------------------------

// Egress classifications for brains (brain.egressClass).
export const BRAIN_EGRESS_CLASS = Object.freeze({
  PUBLIC: "public",
  REPO: "repo",
  PRIVATE_LOCAL: "private_local",
  QUARANTINE_REVIEW: "quarantine_review",
});

// Sensitivity tiers for rows (row.sensitivityTier).
export const SENSITIVITY_TIER = Object.freeze({
  STANDARD: "standard",
  RESTRICTED: "restricted",
});

// Caller egress classifications (caller.readEgressClass).
export const CALLER_EGRESS_CLASS = Object.freeze({
  LOCAL_TRUSTED: "local_trusted",
  CLOUD_BOUND: "cloud_bound",
});

// Writer-taint classification (row.originEgressClass) — the WRITE path that
// contributed the row. Monotonic taint; never washed by review (§6.11).
export const ORIGIN_EGRESS_CLASS = Object.freeze({
  LOCAL_TRUSTED: "local_trusted",
  CLOUD_ORIGIN: "cloud_origin",
});

// Content/source-trust classification (row.sourceTrustClass) — whether the
// row's *content* is trusted for instructions, independent of who wrote it
// (§6.11 Codex v7 F8: a local-trusted importer can ingest adversarial text).
export const SOURCE_TRUST_CLASS = Object.freeze({
  TRUSTED: "trusted",
  UNTRUSTED: "untrusted",
});

// Quarantine review states (row.reviewState) — a three-valued enum. Quarantine
// fires only on UNREVIEWED; NONE (no workflow applied) and REVIEWED (lifted)
// clear it. Absent/unknown fails closed to unreviewed (§6.11).
export const REVIEW_STATE = Object.freeze({
  NONE: "none",
  UNREVIEWED: "unreviewed",
  REVIEWED: "reviewed",
});

// Integrity verdict (trustLevel) on the §6.15 vector — separate axis from
// confidentiality.
export const TRUST_LEVEL = Object.freeze({
  TRUSTED: "trusted",
  UNTRUSTED: "untrusted",
});

// Confidentiality redaction levels (redactionLevel) on the §6.15 vector.
export const REDACTION_LEVEL = Object.freeze({
  NONE: "none",
  LOCAL_METADATA_ONLY: "local_metadata_only",
  FULL: "full",
});

// The provenance fields a materialized cloud-origin/untrusted row must carry to
// a local-trusted audience (§6.11: provenance on every read plane).
const PROVENANCE_FIELDS = Object.freeze(["originEgressClass", "sourceTrustClass"]);

// ---------------------------------------------------------------------------
// Effective-egress helpers (pure; fail-closed on every unknown enum value)
// ---------------------------------------------------------------------------

// The AUDIENCE these bytes would reach. With a caller it is the caller's read
// egress; for a background job (caller=null) it is the SINK's reachability.
// Fail-closed both ways: an unknown caller egress is cloud_bound; an absent
// sink.cloudAgentReachable is cloud-reachable (only an explicit `false` clears).
function audienceIsCloudBound(caller, sink) {
  if (caller !== null && caller !== undefined) {
    return caller.readEgressClass !== CALLER_EGRESS_CLASS.LOCAL_TRUSTED;
  }
  return sink?.cloudAgentReachable !== false;
}

// A row is LOCAL-ONLY when its effective egress is restricted: a restricted
// sensitivity tier, or a private_local / quarantine_review brain. Fail-closed:
// an unknown brain egress class or sensitivity tier is treated as local-only.
function isLocalOnlyRow(brainEgressClass, sensitivityTier) {
  const brainConfines =
    brainEgressClass !== BRAIN_EGRESS_CLASS.PUBLIC &&
    brainEgressClass !== BRAIN_EGRESS_CLASS.REPO;
  const tierConfines = sensitivityTier !== SENSITIVITY_TIER.STANDARD;
  return brainConfines || tierConfines;
}

// QUARANTINE: a cloud-origin + restricted + unreviewed row is absent on every
// plane except an explicit review endpoint (out of scope for slice 1 → deny).
// Each predicate fails closed on an unknown value: absent originEgressClass is
// not local_trusted (eligible), absent sensitivityTier is not standard
// (restricted), and only the explicit NONE/REVIEWED states clear the review gate.
function isQuarantinedRow(originEgressClass, sensitivityTier, reviewState) {
  const writerEligible = originEgressClass !== ORIGIN_EGRESS_CLASS.LOCAL_TRUSTED;
  const tierEligible = sensitivityTier !== SENSITIVITY_TIER.STANDARD;
  const reviewClears =
    reviewState === REVIEW_STATE.REVIEWED || reviewState === REVIEW_STATE.NONE;
  return writerEligible && tierEligible && !reviewClears;
}

// TRUST is the WORST of writer taint (originEgressClass) and content/source
// trust (sourceTrustClass) — two independent axes (§6.11 F8). Either being
// non-clean yields untrusted, which forbids side effects. Fail-closed: an
// unknown value on either axis is untrusted.
function assessTrust(originEgressClass, sourceTrustClass) {
  const writerTainted = originEgressClass !== ORIGIN_EGRESS_CLASS.LOCAL_TRUSTED;
  const contentUntrusted = sourceTrustClass !== SOURCE_TRUST_CLASS.TRUSTED;
  const untrusted = writerTainted || contentUntrusted;
  return {
    untrusted,
    trustLevel: untrusted ? TRUST_LEVEL.UNTRUSTED : TRUST_LEVEL.TRUSTED,
    sideEffectAllowed: !untrusted,
  };
}

// Determine effective egress decision for a row materialization request.
//
// Inputs (plain objects; any field may be absent → treated as most restrictive):
//   brain               : { egressClass }
//   row                 : { sensitivityTier, reviewState, originEgressClass, sourceTrustClass, maxEgressReached }
//   requestedOperation  : 'read' | 'mutate' | 'process'
//   caller              : { readEgressClass } | null   (null = background job)
//   sink                : { type, cloudAgentReachable }
//
// Returns a plain decision object (never throws for business logic).
//
// `requestedOperation` is part of the interface (above) but is not yet read:
// the read/mutate/process branch lands in a later slice with its own tests, so
// per TDD it is not destructured here until a behavior demands it.
export function effectiveEgress({ brain, row, caller, sink }) {
  // Resolve input fields; every predicate below defaults to most-restrictive on
  // an absent/unknown value, so no normalization is needed here.
  const brainEgressClass = brain?.egressClass;
  const sensitivityTier = row?.sensitivityTier;

  // The audience these bytes would reach (caller, else background-job sink).
  const cloudBoundAudience = audienceIsCloudBound(caller, sink);

  // --- Confidentiality axis ---
  const localOnly = isLocalOnlyRow(brainEgressClass, sensitivityTier);
  const quarantined = isQuarantinedRow(
    row?.originEgressClass,
    sensitivityTier,
    row?.reviewState,
  );
  // Local-only content may materialize only for a local-trusted audience.
  // Quarantine is an additional absolute deny that overrides audience trust.
  const canMaterialize = !quarantined && !(localOnly && cloudBoundAudience);

  // Local-only rows reaching a (necessarily local-trusted) audience are carried
  // as metadata only; non-local-only rows are unredacted; denials are full.
  const redactionLevel = !canMaterialize
    ? REDACTION_LEVEL.FULL
    : localOnly
      ? REDACTION_LEVEL.LOCAL_METADATA_ONLY
      : REDACTION_LEVEL.NONE;

  // A processor sink is allowed only when the content materializes and NEITHER
  // the audience nor the sink itself is cloud-reachable (checked independently).
  // Fail-closed: an absent sink.cloudAgentReachable is treated as cloud-reachable.
  const processorSinkAllowed =
    canMaterialize && !cloudBoundAudience && sink?.cloudAgentReachable === false;

  // --- Trust (integrity) axis — SEPARATE from confidentiality ---
  const { untrusted, trustLevel, sideEffectAllowed } = assessTrust(
    row?.originEgressClass,
    row?.sourceTrustClass,
  );

  // Provenance must accompany a cloud-origin/untrusted row only when it actually
  // materializes to a LOCAL-TRUSTED audience (not for cloud-bound audiences).
  const provenanceFieldsRequired =
    canMaterialize && untrusted && !cloudBoundAudience ? [...PROVENANCE_FIELDS] : [];

  // Audit whenever materialization is denied OR the content is untrusted.
  const auditRequired = !canMaterialize || untrusted;

  return {
    canMaterialize,
    redactionLevel,
    processorSinkAllowed,
    trustLevel,
    sideEffectAllowed,
    provenanceFieldsRequired,
    auditRequired,
  };
}

// ---------------------------------------------------------------------------
// Capture stamping (write side)
// ---------------------------------------------------------------------------

// deriveCaptureStamp — the PURE write-stamping decision for a capture
// (docs/45 §6.8/§6.11). Derives the trust/quarantine columns a capture writes
// from the WRITER's egress class (the caller's readEgressClass doubles as writer
// egress). Fail-closed: an unknown/absent caller egress is cloud_origin. A
// cloud_origin + restricted capture is QUARANTINED (unreviewed) at creation —
// the hidden-injection guard. Direct capture is agent-authored, so source is
// 'trusted' here; external ingest pipelines stamp source_trust_class='untrusted'
// on their own path (§6.11 F8). Persistence (the SQL insert + monotonic conflict)
// is the store's job, not this module's.
export function deriveCaptureStamp({ caller, sensitivityTier } = {}) {
  const originEgressClass =
    caller?.readEgressClass === CALLER_EGRESS_CLASS.LOCAL_TRUSTED
      ? ORIGIN_EGRESS_CLASS.LOCAL_TRUSTED
      : ORIGIN_EGRESS_CLASS.CLOUD_ORIGIN;
  const sourceTrustClass = SOURCE_TRUST_CLASS.TRUSTED;
  const reviewState =
    originEgressClass === ORIGIN_EGRESS_CLASS.CLOUD_ORIGIN &&
    sensitivityTier === SENSITIVITY_TIER.RESTRICTED
      ? REVIEW_STATE.UNREVIEWED
      : REVIEW_STATE.NONE;
  return { originEgressClass, sourceTrustClass, reviewState };
}

// ---------------------------------------------------------------------------
// Read fanout
// ---------------------------------------------------------------------------

// The set of brains a READ spans (v24 D4/D6).
//   * an explicit (body or L1) selector narrows to exactly that one brain;
//   * otherwise the legacy env key reads only its single effective brain
//     (it does not fan out — it has no accessible set);
//   * otherwise an unscoped read fans out across every accessible brain;
//   * with no accessible brains, it falls back to the single effective brain.
//
// Inputs:
//   caller         : { kind, ... }
//   scope          : result of deriveScope
//   explicitBrain  : resolved { brainId, brainSlug } | null  (a selector was given)
//   effectiveBrain : { brainId, brainSlug } | null           (default/L1 brain)
// Returns: [{ brainId, brainSlug }]
export function planReadFanout({ caller, scope, explicitBrain = null, effectiveBrain = null, egressMode = "off" }) {
  const ref = (b) => ({ brainId: b.brainId, brainSlug: b.brainSlug ?? null });
  // An egress-excluded brain (docs/45 §6.13) must never re-enter the fanout via
  // the default/effective-brain fallback (or an explicit selector) — otherwise
  // the stripped default brain leaks through the unscoped read planes. This
  // suppression applies ONLY under enforce: `scope.egressExcluded` is also
  // populated in OBSERVE (for logging), but observe must be a behavioural no-op,
  // so off/observe use an empty set and behave identically to pre-egress.
  const egressExcludedIds = egressMode === "enforce"
    ? new Set((scope.egressExcluded ?? []).map((b) => b.brainId))
    : new Set();
  const fallback = (b) => (b && !egressExcludedIds.has(b.brainId) ? [ref(b)] : []);
  if (explicitBrain) {
    return egressExcludedIds.has(explicitBrain.brainId) ? [] : [ref(explicitBrain)];
  }
  if (isLegacyAdmin(caller)) {
    return fallback(effectiveBrain);
  }
  if (scope.accessible.length > 0) {
    // Return a copy: the result must not alias (and let a caller mutate) the scope.
    return scope.accessible.map(ref);
  }
  return fallback(effectiveBrain);
}
