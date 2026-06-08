import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "./config.mjs";
import { query } from "./db.mjs";

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

async function loadPrincipalMemberships(principalId) {
  const result = await query(
    `
      select
        p.id as principal_id,
        p.household_id,
        p.default_brain_id,
        b.id as brain_id,
        b.slug as brain_slug,
        bm.role
      from brain_principals p
      left join brain_memberships bm
        on bm.principal_id = p.id
      left join brains b
        on b.id = bm.brain_id
      where p.id = $1::uuid
    `,
    [principalId],
  );

  if (result.rowCount === 0) {
    throw new HttpError(403, "Principal not found");
  }

  const first = result.rows[0];
  const memberships = result.rows
    .filter((row) => row.brain_id)
    .map((row) => ({
      brainId: row.brain_id,
      brainSlug: row.brain_slug,
      role: row.role,
    }));

  return {
    principalId: first.principal_id,
    householdId: first.household_id,
    defaultBrainId: first.default_brain_id,
    memberships,
  };
}

async function resolveBrainBySlugForHousehold(householdId, brainSlug) {
  const result = await query(
    `
      select id, household_id, slug
      from brains
      where household_id = $1::uuid
        and slug = $2
      limit 1
    `,
    [householdId, brainSlug],
  );

  return result.rows[0] ?? null;
}

async function resolveBrainBySlugGlobal(brainSlug) {
  const result = await query(
    `
      select id, household_id, slug
      from brains
      where slug = $1
      order by created_at asc
      limit 2
    `,
    [brainSlug],
  );

  if (result.rowCount > 1) {
    throw new HttpError(409, `Brain slug is ambiguous: ${brainSlug}`);
  }

  return result.rows[0] ?? null;
}

const BRAIN_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// v24 D1/D5: compute the brains a principal can USE (accessible) and the brains
// a principal may NAME (lookup = accessible plus estate brains, including estate
// brains overridden by a brain-level deny so they resolve-then-403 rather than 404).
async function loadBrainScopes(principalId) {
  const accessible = await query(
    `
      select b.id, b.slug
      from brains b
      where case
        when exists (
          select 1 from brain_memberships bm
          where bm.principal_id = $1::uuid and bm.brain_id = b.id
        )
        then exists (
          select 1 from brain_memberships bm
          where bm.principal_id = $1::uuid and bm.brain_id = b.id and bm.is_deny = false
        )
        else exists (
          select 1 from estate_memberships em
          where em.principal_id = $1::uuid and em.estate_id = b.household_id and em.is_deny = false
        )
      end
    `,
    [principalId],
  );

  const lookup = await query(
    `
      select b.id, b.slug
      from brains b
      where exists (
          select 1 from brain_memberships bm
          where bm.principal_id = $1::uuid and bm.brain_id = b.id and bm.is_deny = false
        )
        or exists (
          select 1 from estate_memberships em
          where em.principal_id = $1::uuid and em.estate_id = b.household_id and em.is_deny = false
        )
    `,
    [principalId],
  );

  return {
    accessible: accessible.rows.map((r) => ({ brainId: r.id, brainSlug: r.slug })),
    accessibleIds: new Set(accessible.rows.map((r) => r.id)),
    lookup: lookup.rows.map((r) => ({ id: r.id, slug: r.slug })),
  };
}

// v24 D2/D3/D5: resolve an explicit slug-or-UUID selector for a non-admin,
// non-brain-bound principal. 404 = not nameable (or nonexistent UUID), 403 =
// nameable/exists but denied, 409 = ambiguous slug. No existence-hiding beyond
// the lookup scope; an inaccessible-but-existing UUID is 403, not downgraded to 404.
async function resolveSelectorInScope(selector, scopes) {
  if (BRAIN_UUID_RE.test(selector)) {
    if (scopes.accessibleIds.has(selector)) {
      const hit = scopes.accessible.find((b) => b.brainId === selector);
      return { id: hit.brainId, slug: hit.brainSlug };
    }
    const existing = await query("select id from brains where id = $1::uuid", [selector]);
    if (existing.rowCount === 0) {
      throw new HttpError(404, `Brain not found: ${selector}`);
    }
    throw new HttpError(403, `Not authorized for brain: ${selector}`);
  }

  const matches = scopes.lookup.filter((b) => b.slug === selector);
  if (matches.length === 0) {
    throw new HttpError(404, `Brain not found: ${selector}`);
  }
  if (matches.length > 1) {
    throw new HttpError(409, `Brain slug is ambiguous: ${selector}`);
  }
  const brain = matches[0];
  if (!scopes.accessibleIds.has(brain.id)) {
    throw new HttpError(403, `Not authorized for brain: ${selector}`);
  }
  return brain;
}

async function resolveDefaultAdminBrain() {
  const result = await query(
    `
      select
        p.default_brain_id as brain_id,
        b.household_id
      from brain_principals p
      join brains b
        on b.id = p.default_brain_id
      where p.principal_type = 'person'
        and p.default_brain_id is not null
      order by p.created_at asc
      limit 1
    `,
  );

  return result.rows[0] ?? null;
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

  const memberships = await loadPrincipalMemberships(bindingResult.rows[0].principal_id);
  const scopes = await loadBrainScopes(memberships.principalId);
  // v24 D3: human tokens resolve a selector (route/query/header) uniformly, via
  // the same estate-aware scope logic as service keys.
  const requestedBrain = requestedBrainSlug
    ? await resolveSelectorInScope(requestedBrainSlug, scopes)
    : null;

  return {
    authSource: "human_token",
    principalId: memberships.principalId,
    householdId: memberships.householdId,
    defaultBrainId: memberships.defaultBrainId,
    allowedBrainIds: memberships.memberships.map((entry) => entry.brainId),
    accessibleBrains: scopes.accessible,
    effectiveBrainId: requestedBrain?.id ?? memberships.defaultBrainId,
    effectiveBrainSlug: requestedBrain?.slug
      ?? scopes.accessible.find((entry) => entry.brainId === memberships.defaultBrainId)?.brainSlug
      ?? memberships.memberships.find((entry) => entry.brainId === memberships.defaultBrainId)?.brainSlug
      ?? null,
    requestedBrainId: requestedBrain?.id ?? null,
    requestedBrainSlug: requestedBrain?.slug ?? null,
    isAdmin: false,
  };
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

async function resolveStoredAccessKeyContext(keyHash, requestedBrainSlug) {
  const result = await query(
    `
      select
        k.id as access_key_id,
        k.brain_id as key_brain_id,
        k.is_admin,
        p.id as principal_id,
        p.household_id,
        p.default_brain_id,
        b.id as brain_id,
        b.slug as brain_slug,
        bm.role
      from brain_access_keys k
      join brain_principals p
        on p.id = k.principal_id
      left join brain_memberships bm
        on bm.principal_id = p.id
      left join brains b
        on b.id = bm.brain_id
      where k.key_hash = $1
        and k.is_active = true
    `,
    [keyHash],
  );

  if (result.rowCount === 0) {
    return null;
  }

  await query(
    `
      update brain_access_keys
      set
        last_used_at = now(),
        updated_at = now()
      where key_hash = $1
    `,
    [keyHash],
  );

  const first = result.rows[0];
  const memberships = result.rows
    .filter((row) => row.brain_id)
    .map((row) => ({
      brainId: row.brain_id,
      brainSlug: row.brain_slug,
      role: row.role,
    }));

  const scopes = await loadBrainScopes(first.principal_id);

  let requestedBrain = null;
  if (requestedBrainSlug) {
    if (first.is_admin) {
      // Admin stored keys keep their pre-v24 household-wide slug resolution.
      requestedBrain = await resolveBrainBySlugForHousehold(first.household_id, requestedBrainSlug);
      if (!requestedBrain) {
        throw new HttpError(404, `Brain not found: ${requestedBrainSlug}`);
      }
    } else if (first.key_brain_id) {
      // Brain-bound keys may only name their own brain.
      requestedBrain = await resolveBrainBySlugForHousehold(first.household_id, requestedBrainSlug);
      if (!requestedBrain) {
        throw new HttpError(404, `Brain not found: ${requestedBrainSlug}`);
      }
      if (requestedBrain.id !== first.key_brain_id) {
        throw new HttpError(403, `Access key is bound to a different brain: ${requestedBrainSlug}`);
      }
    } else {
      // v24 estate-aware resolution for non-admin, non-brain-bound principals.
      requestedBrain = await resolveSelectorInScope(requestedBrainSlug, scopes);
    }
  }

  const effectiveBrainId = requestedBrain?.id
    ?? first.key_brain_id
    ?? first.default_brain_id;

  if (!effectiveBrainId) {
    throw new HttpError(403, "Access key is not bound to a usable brain");
  }

  return {
    authSource: "service_key",
    principalId: first.principal_id,
    householdId: first.household_id,
    defaultBrainId: first.default_brain_id,
    allowedBrainIds: memberships.map((entry) => entry.brainId),
    accessibleBrains: scopes.accessible,
    effectiveBrainId,
    effectiveBrainSlug: requestedBrain?.slug
      ?? scopes.accessible.find((entry) => entry.brainId === effectiveBrainId)?.brainSlug
      ?? memberships.find((entry) => entry.brainId === effectiveBrainId)?.brainSlug
      ?? null,
    requestedBrainId: requestedBrain?.id ?? null,
    requestedBrainSlug: requestedBrain?.slug ?? null,
    isAdmin: Boolean(first.is_admin),
  };
}

async function resolveLegacyAdminContext(requestedBrainSlug) {
  const requestedBrain = requestedBrainSlug
    ? await resolveBrainBySlugGlobal(requestedBrainSlug)
    : null;

  if (requestedBrainSlug && !requestedBrain) {
    throw new HttpError(404, `Brain not found: ${requestedBrainSlug}`);
  }

  const defaultBrain = requestedBrain ?? await resolveDefaultAdminBrain();
  if (!defaultBrain?.brain_id && !defaultBrain?.id) {
    throw new HttpError(403, "No default brain is available for legacy admin access");
  }

  const effectiveBrainId = requestedBrain?.id ?? defaultBrain.brain_id ?? defaultBrain.id;
  const householdId = requestedBrain?.household_id ?? defaultBrain.household_id ?? null;

  return {
    authSource: "legacy_admin_key",
    principalId: null,
    householdId,
    defaultBrainId: effectiveBrainId,
    allowedBrainIds: effectiveBrainId ? [effectiveBrainId] : [],
    effectiveBrainId,
    effectiveBrainSlug: requestedBrain?.slug ?? null,
    requestedBrainId: requestedBrain?.id ?? null,
    requestedBrainSlug: requestedBrain?.slug ?? null,
    isAdmin: true,
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

// v24 D3/D4: resolve a body/tool-arg `brain` (slug or UUID) for an already-
// authenticated request. Absent -> the L1/default effective brain. Admins
// (legacy env key or stored is_admin) resolve globally; everyone else resolves
// through their estate-aware scope, reusing the same 403/404/409 logic as L1.
export async function resolveRequestBrain(accessContext, brainArg) {
  const selector = typeof brainArg === "string" ? brainArg.trim() : brainArg;
  if (selector == null || selector === "") {
    return {
      brainId: accessContext.effectiveBrainId,
      brainSlug: accessContext.effectiveBrainSlug ?? null,
    };
  }

  let resolved;
  if (accessContext.isAdmin) {
    if (BRAIN_UUID_RE.test(selector)) {
      const r = await query("select id, slug from brains where id = $1::uuid", [selector]);
      if (r.rowCount === 0) {
        throw new HttpError(404, `Brain not found: ${selector}`);
      }
      resolved = { brainId: r.rows[0].id, brainSlug: r.rows[0].slug };
    } else {
      const r = await query(
        "select id, slug from brains where slug = $1 order by created_at asc limit 2",
        [selector],
      );
      if (r.rowCount === 0) {
        throw new HttpError(404, `Brain not found: ${selector}`);
      }
      if (r.rowCount > 1) {
        throw new HttpError(409, `Brain slug is ambiguous: ${selector}`);
      }
      resolved = { brainId: r.rows[0].id, brainSlug: r.rows[0].slug };
    }
  } else {
    const scopes = await loadBrainScopes(accessContext.principalId);
    const brain = await resolveSelectorInScope(selector, scopes);
    resolved = { brainId: brain.id, brainSlug: brain.slug };
  }

  // v24 D3: a body/tool-arg brain that disagrees with an explicit L1 selector
  // (route/query/header) is a conflicting request, not a silent override.
  if (accessContext.requestedBrainId && resolved.brainId !== accessContext.requestedBrainId) {
    throw new HttpError(400, "Conflicting brain selectors: explicit selector and body brain differ");
  }

  return resolved;
}

// v24 D4/D6: the set of brains a READ spans. An explicit body/tool-arg selector
// or an L1 selector narrows to exactly one brain; an omitted selector fans out
// across every accessible brain. Falls back to the single effective brain for
// legacy-admin (and any principal whose accessible set is empty).
// Ensure a {brainId, brainSlug} pair has a slug (D6 requires per-row brain_slug).
// The legacy-admin / no-membership effective brain carries a null slug, so look
// it up rather than emit null on every read row.
async function brainRef(brainId, brainSlug) {
  if (brainSlug || !brainId) {
    return { brainId, brainSlug: brainSlug ?? null };
  }
  const r = await query("select slug from brains where id = $1::uuid", [brainId]);
  return { brainId, brainSlug: r.rows[0]?.slug ?? null };
}

// M3 D4/D9: authorize a destructive op (delete/restore) on a resolved brain.
// Returns a non-null actor descriptor on allow; throws HttpError(403) on deny.
//
// Allow if EITHER:
//   - accessContext.isAdmin (covers the bare legacy_admin_key AND stored is_admin
//     keys). D9: legacy-admin destructive (delete/restore) is allowed in M3 and
//     documented as blast radius; purge is M5 and out of scope here.
//   - the principal is a brain OWNER of brainId, OR an estate ADMIN of the brain's
//     estate (household). Editors/viewers/non-members are denied.
//
// D4.3 is resolved OWNER-ONLY for M3: there is no `created_by` column on thoughts,
// so a creator-or-owner policy is unbuildable without one and is deferred. Add a
// `created_by` column and widen this predicate when that decision lands.
export async function authorizeDestructive(accessContext, brainId, { action }) {
  const actor = {
    auth_source: accessContext.authSource,
    principal_id: accessContext.principalId ?? null,
    is_admin: Boolean(accessContext.isAdmin),
  };

  if (accessContext.isAdmin === true) {
    return actor;
  }

  if (!accessContext.principalId) {
    throw new HttpError(403, `Not authorized to ${action} in this brain`);
  }

  const result = await query(
    `
      select exists (
        select 1 from brain_memberships bm
        where bm.principal_id = $1::uuid
          and bm.brain_id = $2::uuid
          and bm.role = 'owner'
          and bm.is_deny = false
      ) or exists (
        select 1 from estate_memberships em
        where em.principal_id = $1::uuid
          and em.estate_id = (select household_id from brains where id = $2::uuid)
          and em.role = 'admin'
          and em.is_deny = false
      ) as allowed
    `,
    [accessContext.principalId, brainId],
  );

  if (!result.rows[0]?.allowed) {
    throw new HttpError(403, `Not authorized to ${action} in this brain`);
  }

  return actor;
}

export async function resolveReadBrains(accessContext, brainArg) {
  const selector = typeof brainArg === "string" ? brainArg.trim() : brainArg;
  if (selector) {
    return [await resolveRequestBrain(accessContext, selector)];
  }
  if (accessContext.requestedBrainId) {
    return [await brainRef(accessContext.effectiveBrainId, accessContext.effectiveBrainSlug)];
  }
  const accessible = accessContext.accessibleBrains;
  if (Array.isArray(accessible) && accessible.length > 0) {
    return accessible;
  }
  return [await brainRef(accessContext.effectiveBrainId, accessContext.effectiveBrainSlug)];
}
