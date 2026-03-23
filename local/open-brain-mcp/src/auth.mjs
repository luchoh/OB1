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
    throw new HttpError(400, `Brain slug is ambiguous: ${brainSlug}`);
  }

  return result.rows[0] ?? null;
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
  const requestedBrain = requestedBrainSlug
    ? await resolveBrainBySlugForHousehold(memberships.householdId, requestedBrainSlug)
    : null;

  if (requestedBrainSlug && !requestedBrain) {
    throw new HttpError(404, `Brain not found: ${requestedBrainSlug}`);
  }

  if (requestedBrain && !memberships.memberships.some((entry) => entry.brainId === requestedBrain.id)) {
    throw new HttpError(403, `Not authorized for brain: ${requestedBrainSlug}`);
  }

  return {
    authSource: "human_token",
    principalId: memberships.principalId,
    householdId: memberships.householdId,
    defaultBrainId: memberships.defaultBrainId,
    allowedBrainIds: memberships.memberships.map((entry) => entry.brainId),
    effectiveBrainId: requestedBrain?.id ?? memberships.defaultBrainId,
    effectiveBrainSlug: requestedBrain?.slug ?? memberships.memberships.find((entry) => entry.brainId === memberships.defaultBrainId)?.brainSlug ?? null,
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

  let requestedBrain = null;
  if (requestedBrainSlug) {
    requestedBrain = await resolveBrainBySlugForHousehold(first.household_id, requestedBrainSlug);
    if (!requestedBrain) {
      throw new HttpError(404, `Brain not found: ${requestedBrainSlug}`);
    }
  }

  if (
    requestedBrain
    && first.key_brain_id
    && !first.is_admin
    && requestedBrain.id !== first.key_brain_id
  ) {
    throw new HttpError(403, `Access key is bound to a different brain: ${requestedBrainSlug}`);
  }

  if (requestedBrain && !first.is_admin && !memberships.some((entry) => entry.brainId === requestedBrain.id)) {
    throw new HttpError(403, `Not authorized for brain: ${requestedBrainSlug}`);
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
    effectiveBrainId,
    effectiveBrainSlug: requestedBrain?.slug
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
  const humanContext = await resolveHumanAccessContext(c, routeBrainSlug);
  if (humanContext) {
    return humanContext;
  }

  const key = authKey(c);
  if (!key) {
    throw new HttpError(401, "Unauthorized");
  }

  const requestedBrainSlug = routeBrainSlug ?? explicitServiceBrainSlug(c);

  if (key === config.accessKey) {
    return resolveLegacyAdminContext(requestedBrainSlug);
  }

  const storedContext = await resolveStoredAccessKeyContext(hashAccessKey(key), requestedBrainSlug);
  if (!storedContext) {
    throw new HttpError(401, "Unauthorized");
  }

  return storedContext;
}
