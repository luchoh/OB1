import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "./config.mjs";
import { query } from "./db.mjs";
import {
  ACTIONS,
  CALLER_KINDS,
  VERDICTS,
  isBrainUuid,
  deriveScope,
  resolveSelector,
  resolveSelectorGlobal,
  detectSelectorConflict,
  authorizeAction,
  planReadFanout,
} from "./access-policy.mjs";

// auth.mjs is the ADAPTER around the pure Access policy module (src/access-policy.mjs).
// It does two impure things the policy refuses to: (1) FETCH the rows the policy
// decides over — brain/estate memberships, the brain catalog, the existsGlobally
// hint — and (2) MAP the policy's verdict data onto HTTP outcomes (HttpError /
// returned data). All decision logic — scope derivation, selector resolution,
// action authorization, read fanout, the v24/ADR-0002/ADR-0003 semantics — lives
// in the policy module and is exercised by its 73-test pure suite. Nothing in
// this file decides; it fetches, calls the policy, and translates.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

function authKey(c) {
  return c.req.query("key")
    || c.req.header("x-access-key")
    || c.req.header("x-brain-key");
}

function humanToken(c) {
  const forwarded = c.req.header("x-auth-request-access-token");
  if (forwarded?.trim()) {
    return forwarded.trim();
  }

  const authorization = c.req.header("authorization");
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function hashAccessKey(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

let jwks;

function remoteJwks() {
  if (!config.auth.humanTokenAuth.enabled) {
    throw new HttpError(401, "Human token authentication is disabled");
  }

  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(config.auth.humanTokenAuth.jwksUrl));
  }

  return jwks;
}

async function verifyHumanJwt(token) {
  try {
    const { payload } = await jwtVerify(token, remoteJwks(), {
      issuer: config.auth.humanTokenAuth.issuer,
      audience: config.auth.humanTokenAuth.audience,
    });
    return payload;
  } catch (error) {
    throw new HttpError(401, error instanceof Error ? error.message : "Invalid human access token");
  }
}

function explicitServiceBrainSlug(c) {
  const queryValue = c.req.query("brain");
  if (queryValue?.trim()) {
    return queryValue.trim();
  }

  const headerValue = c.req.header("x-brain-slug");
  if (headerValue?.trim()) {
    return headerValue.trim();
  }

  return null;
}

// ---------------------------------------------------------------------------
// Row adapters — the only place SQL meets the policy. Each returns plain data
// shaped exactly as the policy module's inputs expect.
// ---------------------------------------------------------------------------

async function fetchBrainMemberships(principalId) {
  const result = await query(
    `select brain_id, role, is_deny from brain_memberships where principal_id = $1::uuid`,
    [principalId],
  );
  return result.rows.map((r) => ({ brainId: r.brain_id, role: r.role, isDeny: r.is_deny }));
}

async function fetchEstateMemberships(principalId) {
  const result = await query(
    `select estate_id, role, is_deny from estate_memberships where principal_id = $1::uuid`,
    [principalId],
  );
  return result.rows.map((r) => ({ estateId: r.estate_id, role: r.role, isDeny: r.is_deny }));
}

// The candidate brain set the policy derives scope over: every brain reachable
// via a brain membership (incl. deny rows — the policy classifies them), via a
// non-deny estate membership, or — for an admin key (ADR-0003) — by living in
// the caller's home estate.
async function fetchBrainCatalog(principalId, { isAdmin, homeEstateId }) {
  const result = await query(
    `
      select b.id as brain_id, b.slug as brain_slug, b.household_id as estate_id
      from brains b
      where exists (
          select 1 from brain_memberships bm
          where bm.principal_id = $1::uuid and bm.brain_id = b.id
        )
        or exists (
          select 1 from estate_memberships em
          where em.principal_id = $1::uuid and em.estate_id = b.household_id and em.is_deny = false
        )
        or ($2::boolean and b.household_id = $3::uuid)
    `,
    [principalId, Boolean(isAdmin), homeEstateId],
  );
  return result.rows.map((r) => ({ brainId: r.brain_id, brainSlug: r.brain_slug, estateId: r.estate_id }));
}

async function brainExists(brainId) {
  const r = await query("select 1 from brains where id = $1::uuid limit 1", [brainId]);
  return r.rowCount > 0;
}

async function resolveDefaultAdminBrain() {
  const result = await query(
    `
      select p.default_brain_id as brain_id, b.household_id
      from brain_principals p
      join brains b on b.id = p.default_brain_id
      where p.principal_type = 'person'
        and p.default_brain_id is not null
      order by p.created_at asc
      limit 1
    `,
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Verdict → HTTP translation. The policy returns verdict data with semantic
// kinds; the transport owns the status mapping (the ADRs/PRD fix the mapping,
// not the policy).
// ---------------------------------------------------------------------------

// resolved -> {brainId, brainSlug}; not_found -> 404; denied -> 403; ambiguous -> 409.
function selectorVerdictToBrain(verdict, selector) {
  switch (verdict.kind) {
    case VERDICTS.RESOLVED:
      return verdict.brain;
    case VERDICTS.NOT_FOUND:
      throw new HttpError(404, `Brain not found: ${selector}`);
    case VERDICTS.DENIED:
      throw new HttpError(403, `Not authorized for brain: ${selector}`);
    case VERDICTS.AMBIGUOUS:
      throw new HttpError(409, `Brain slug is ambiguous: ${selector}`);
    default:
      throw new HttpError(500, `Unexpected selector verdict: ${verdict.kind}`);
  }
}

// allow -> actor descriptor; denied -> 403.
function actionVerdictToActor(verdict, action) {
  if (verdict.kind === VERDICTS.ALLOW) {
    return verdict.actor;
  }
  throw new HttpError(403, `Not authorized to ${action} in this brain`);
}

// Resolve a selector through a principal's derived scope (human / service /
// stored-admin — the unified ADR-0003 path). Supplies the existsGlobally hint
// the policy needs to tell a known-but-out-of-scope UUID (403) from a
// nonexistent one (404).
async function resolveScopedSelector(selector, scope) {
  const existsGlobally = isBrainUuid(selector) ? await brainExists(selector) : false;
  const verdict = resolveSelector({ selector, scope, existsGlobally });
  return selectorVerdictToBrain(verdict, selector);
}

// Resolve a selector for the bare legacy env key (global reach, never denied).
// Returns {brainId, brainSlug, estateId}; throws 404/409 via the policy verdict.
async function resolveGlobalSelector(selector) {
  let rows;
  if (isBrainUuid(selector)) {
    rows = (await query("select id, slug, household_id from brains where id = $1::uuid", [selector])).rows;
  } else {
    rows = (await query(
      "select id, slug, household_id from brains where slug = $1 order by created_at asc limit 2",
      [selector],
    )).rows;
  }
  const candidates = rows.map((r) => ({ brainId: r.id, brainSlug: r.slug, estateId: r.household_id }));
  const verdict = resolveSelectorGlobal({ candidates });
  if (verdict.kind === VERDICTS.RESOLVED) {
    return candidates[0]; // keep estateId the policy strips off
  }
  return selectorVerdictToBrain(verdict, selector); // throws for not_found / ambiguous
}

// ---------------------------------------------------------------------------
// Access context assembly
// ---------------------------------------------------------------------------

async function slugForBrain(brainId, scope) {
  if (!brainId) return null;
  const hit = [...scope.accessible, ...scope.lookup].find((b) => b.brainId === brainId);
  if (hit) return hit.brainSlug;
  const r = await query("select slug from brains where id = $1::uuid", [brainId]);
  return r.rows[0]?.slug ?? null;
}

// Build the request access context for a principal-backed caller (human token
// or stored service key, incl. stored admin). `defaultBrainOverride` is the
// key's brain_id hint when present (ADR-0003: a default hint, never a clamp).
async function buildPrincipalContext(
  principalId,
  { authSource, isAdmin, defaultBrainOverride = null, requireUsableBrain },
  requestedBrainSlug,
) {
  const base = await query(
    "select household_id, default_brain_id from brain_principals where id = $1::uuid",
    [principalId],
  );
  if (base.rowCount === 0) {
    throw new HttpError(403, "Principal not found");
  }
  const homeEstateId = base.rows[0].household_id;
  const defaultBrainId = defaultBrainOverride ?? base.rows[0].default_brain_id;

  const caller = {
    kind: authSource,
    principalId,
    homeEstateId,
    isAdmin: Boolean(isAdmin),
    defaultBrainId,
  };

  const [brainMemberships, estateMemberships, catalog] = await Promise.all([
    fetchBrainMemberships(principalId),
    fetchEstateMemberships(principalId),
    fetchBrainCatalog(principalId, caller),
  ]);

  const scope = deriveScope({ caller, brainMemberships, estateMemberships, catalog });

  let requestedBrain = null;
  if (requestedBrainSlug) {
    requestedBrain = await resolveScopedSelector(requestedBrainSlug, scope);
  }

  const effectiveBrainId = requestedBrain?.brainId ?? defaultBrainId ?? null;
  if (requireUsableBrain && !effectiveBrainId) {
    throw new HttpError(403, "Access key is not bound to a usable brain");
  }
  const effectiveBrainSlug = requestedBrain?.brainSlug ?? (await slugForBrain(effectiveBrainId, scope));

  return makeContext({
    caller,
    scope,
    brainMemberships,
    estateMemberships,
    catalog,
    requestedBrain,
    effectiveBrainId,
    effectiveBrainSlug,
  });
}

// Assemble the accessContext server.mjs consumes, plus the `_policy` bundle the
// authorize/resolve helpers reuse so a single request fetches rows once.
function makeContext({
  caller,
  scope,
  brainMemberships,
  estateMemberships,
  catalog,
  requestedBrain,
  effectiveBrainId,
  effectiveBrainSlug,
}) {
  const brainMembershipById = new Map(
    brainMemberships.map((m) => [m.brainId, { role: m.role, isDeny: m.isDeny }]),
  );
  const estateMembershipByEstate = new Map(
    estateMemberships.map((m) => [m.estateId, { role: m.role, isDeny: m.isDeny }]),
  );
  const brainEstateById = new Map(catalog.map((b) => [b.brainId, b.estateId]));

  return {
    authSource: caller.kind,
    principalId: caller.principalId,
    householdId: caller.homeEstateId,
    defaultBrainId: caller.defaultBrainId,
    allowedBrainIds: brainMemberships.filter((m) => !m.isDeny).map((m) => m.brainId),
    accessibleBrains: scope.accessible,
    effectiveBrainId,
    effectiveBrainSlug,
    requestedBrainId: requestedBrain?.brainId ?? null,
    requestedBrainSlug: requestedBrain?.brainSlug ?? null,
    isAdmin: caller.isAdmin,
    _policy: { caller, scope, brainMembershipById, estateMembershipByEstate, brainEstateById },
  };
}

async function resolveHumanAccessContext(c, requestedBrainSlug) {
  if (!config.auth.humanTokenAuth.enabled) {
    return null;
  }

  const token = humanToken(c);
  if (!token) {
    return null;
  }

  const payload = await verifyHumanJwt(token);
  const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!subject) {
    throw new HttpError(401, "Human access token is missing sub");
  }

  const bindingResult = await query(
    `
      update principal_identity_bindings
      set
        preferred_username = coalesce($3, preferred_username),
        email = coalesce($4, email),
        last_seen_at = now(),
        updated_at = now()
      where provider = 'keycloak'
        and subject = $1
        and is_active = true
      returning principal_id
    `,
    [
      subject,
      subject,
      typeof payload.preferred_username === "string" ? payload.preferred_username : null,
      typeof payload.email === "string" ? payload.email : null,
    ],
  );

  if (bindingResult.rowCount !== 1) {
    throw new HttpError(403, "Authenticated user is not bound to an OB1 principal");
  }

  // Human tokens are never admin keys; reach is purely membership-derived.
  return buildPrincipalContext(
    bindingResult.rows[0].principal_id,
    { authSource: CALLER_KINDS.HUMAN_TOKEN, isAdmin: false, requireUsableBrain: false },
    requestedBrainSlug,
  );
}

async function resolveStoredAccessKeyContext(keyHash, requestedBrainSlug) {
  const result = await query(
    `
      select k.brain_id as key_brain_id, k.is_admin, p.id as principal_id
      from brain_access_keys k
      join brain_principals p on p.id = k.principal_id
      where k.key_hash = $1 and k.is_active = true
    `,
    [keyHash],
  );

  if (result.rowCount === 0) {
    return null;
  }

  await query(
    "update brain_access_keys set last_used_at = now(), updated_at = now() where key_hash = $1",
    [keyHash],
  );

  const row = result.rows[0];
  // ADR-0003: the key's brain_id is a default-brain hint only — NOT a naming
  // clamp. The old brain-bound restriction is retired; capability comes from
  // roles, reach from memberships + (for admin keys) the home estate.
  return buildPrincipalContext(
    row.principal_id,
    {
      authSource: CALLER_KINDS.SERVICE_KEY,
      isAdmin: Boolean(row.is_admin),
      defaultBrainOverride: row.key_brain_id,
      requireUsableBrain: true,
    },
    requestedBrainSlug,
  );
}

// The bare legacy env key: the only global actor (documented blast radius,
// docs/32 D9). Global selector resolution; full CRUD but never purge
// (authorizeAction enforces the no-purge rule); reads do not fan out.
async function resolveLegacyAdminContext(requestedBrainSlug) {
  const caller = {
    kind: CALLER_KINDS.LEGACY_ADMIN_KEY,
    principalId: null,
    homeEstateId: null,
    isAdmin: true,
    defaultBrainId: null,
  };

  let requestedBrain = null;
  if (requestedBrainSlug) {
    requestedBrain = await resolveGlobalSelector(requestedBrainSlug);
  }

  let effectiveBrainId = requestedBrain?.brainId ?? null;
  let householdId = requestedBrain?.estateId ?? null;
  if (!effectiveBrainId) {
    const def = await resolveDefaultAdminBrain();
    if (!def?.brain_id) {
      throw new HttpError(403, "No default brain is available for legacy admin access");
    }
    effectiveBrainId = def.brain_id;
    householdId = def.household_id ?? null;
  }

  return {
    authSource: caller.kind,
    principalId: null,
    householdId,
    defaultBrainId: effectiveBrainId,
    allowedBrainIds: effectiveBrainId ? [effectiveBrainId] : [],
    // No accessible set: the legacy key does not fan out (planReadFanout's
    // legacy branch reads the single effective brain).
    accessibleBrains: undefined,
    effectiveBrainId,
    effectiveBrainSlug: requestedBrain?.brainSlug ?? null,
    requestedBrainId: requestedBrain?.brainId ?? null,
    requestedBrainSlug: requestedBrain?.brainSlug ?? null,
    isAdmin: true,
    _policy: {
      caller,
      scope: { accessible: [], accessibleIds: new Set(), lookup: [] },
      brainMembershipById: new Map(),
      estateMembershipByEstate: new Map(),
      brainEstateById: new Map(),
    },
  };
}

export async function resolveAccessContext(c, { routeBrainSlug = null } = {}) {
  const requestedBrainSlug = routeBrainSlug ?? explicitServiceBrainSlug(c);

  const humanContext = await resolveHumanAccessContext(c, requestedBrainSlug);
  if (humanContext) {
    return humanContext;
  }

  const key = authKey(c);
  if (!key) {
    throw new HttpError(401, "Unauthorized");
  }

  if (key === config.accessKey) {
    return resolveLegacyAdminContext(requestedBrainSlug);
  }

  const storedContext = await resolveStoredAccessKeyContext(hashAccessKey(key), requestedBrainSlug);
  if (!storedContext) {
    throw new HttpError(401, "Unauthorized");
  }

  return storedContext;
}

// ---------------------------------------------------------------------------
// Per-request resolution + authorization (the stable server.mjs-facing surface)
// ---------------------------------------------------------------------------

// Resolve a body/tool-arg `brain` selector for an authenticated request. Absent
// -> the effective (default/L1) brain. A body selector that disagrees with an
// explicit L1 selector is a conflict (400), not a silent override (v24 D3).
export async function resolveRequestBrain(accessContext, brainArg) {
  const selector = typeof brainArg === "string" ? brainArg.trim() : brainArg;
  if (selector == null || selector === "") {
    return {
      brainId: accessContext.effectiveBrainId,
      brainSlug: accessContext.effectiveBrainSlug ?? null,
    };
  }

  const { caller, scope } = accessContext._policy;
  let resolved;
  if (caller.kind === CALLER_KINDS.LEGACY_ADMIN_KEY) {
    const r = await resolveGlobalSelector(selector);
    resolved = { brainId: r.brainId, brainSlug: r.brainSlug };
  } else {
    resolved = await resolveScopedSelector(selector, scope);
  }

  const conflict = detectSelectorConflict(
    accessContext.requestedBrainId ? { brainId: accessContext.requestedBrainId } : null,
    { brainId: resolved.brainId },
  );
  if (conflict) {
    throw new HttpError(400, "Conflicting brain selectors: explicit selector and body brain differ");
  }

  return resolved;
}

// The set of brains a READ spans (v24 D4/D6). An explicit selector narrows to
// one; otherwise the policy plans the fanout (all accessible, single effective
// for an L1-narrowed or legacy caller).
export async function resolveReadBrains(accessContext, brainArg) {
  const selector = typeof brainArg === "string" ? brainArg.trim() : brainArg;
  if (selector) {
    return [await resolveRequestBrain(accessContext, selector)];
  }

  const { caller, scope } = accessContext._policy;
  const effectiveBrain = {
    brainId: accessContext.effectiveBrainId,
    brainSlug: accessContext.effectiveBrainSlug ?? null,
  };
  return planReadFanout({
    caller,
    scope,
    // An L1 selector (route/query/header) narrows the read to that one brain.
    explicitBrain: accessContext.requestedBrainId ? effectiveBrain : null,
    effectiveBrain,
  });
}

// Look up the caller's brain/estate membership for a resolved brain, from the
// rows fetched at context-assembly time.
function membershipForBrain(accessContext, brainId) {
  const { brainMembershipById, estateMembershipByEstate, brainEstateById } = accessContext._policy;
  const brainMembership = brainMembershipById.get(brainId) ?? null;
  const estateId = brainEstateById.get(brainId) ?? null;
  const estateMembership = estateId ? (estateMembershipByEstate.get(estateId) ?? null) : null;
  return { brainMembership, estateMembership };
}

function authorizeVerb(accessContext, brainId, action) {
  const { caller } = accessContext._policy;
  const { brainMembership, estateMembership } = membershipForBrain(accessContext, brainId);
  const verdict = authorizeAction({ caller, action, brainMembership, estateMembership });
  return actionVerdictToActor(verdict, action);
}

// Authorize a WRITE (capture/upsert) on a resolved brain (ADR-0002 ladder:
// editor/owner, or estate admin; viewer and estate member are read-only).
// Returns the audit actor descriptor on allow; throws HttpError(403) on deny.
export async function authorizeWrite(accessContext, brainId) {
  return authorizeVerb(accessContext, brainId, ACTIONS.WRITE);
}

// Authorize a destructive op (delete/restore) on a resolved brain. Returns the
// audit actor on allow; throws HttpError(403) on deny.
export async function authorizeDestructive(accessContext, brainId, { action }) {
  return authorizeVerb(accessContext, brainId, action);
}

// Authorize a PURGE (hard erasure). Stricter than delete/restore: a named admin
// service key only — the bare legacy key and role-based principals are refused
// (the policy enforces the shape). Synchronous: all rows are prefetched.
export function authorizePurge(accessContext, brainId) {
  return authorizeVerb(accessContext, brainId, ACTIONS.PURGE);
}
