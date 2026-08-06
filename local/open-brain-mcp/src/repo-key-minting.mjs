import crypto from "node:crypto";
import { pool } from "./db.mjs";
import { HttpError, hashAccessKey } from "./auth.mjs";

// repo-key-minting.mjs — the handlers behind the `mint_repo_key` /
// `rotate_repo_key` tools (docs/53) and the `mint_agent_key` /
// `rotate_agent_key` tools that provision the caged agent.
//
// PURPOSE: let system-config provision a per-repo brain + a cloud_bound repo key
// for each interactive harness, so no harness needs the shared MCP_ACCESS_KEY
// (which is global admin). The capability that gates every handler here —
// can_mint_repo_keys — creates repo brains, repo keys and agent keys and NOTHING
// else.
//
// TWO CREDENTIAL FAMILIES, ONE BRAIN. A key grants the reach of its PRINCIPAL
// (auth.mjs fetchBrainMemberships), so one key = one principal = one membership
// set. The host-side harnesses (claude, codex) share the repo-service principal
// and reach the repo brain only. The caged agent (pi) runs injection-exposed with
// ungated bash, so it gets its OWN principal — repo brain plus the household's
// shared agent brain — and can never be handed the repo-service credential.
// Because both families hold keys on the SAME repo brain, every guard here is
// scoped by principal and credential_type: a brain-wide guard would make the two
// families clobber each other (see handleMintRepoKey / handleRotateRepoKey).
//
// THE RULE THIS FILE EXISTS TO KEEP: every security-relevant column written here
// is a hard-coded literal, never taken from tool arguments. A caller controls
// only `repo_slug` and a display name. It cannot ask for is_admin, for a
// different egress_class, for can_mint_repo_keys, or for a brain kind. A minting
// key that could choose those would be an admin key with extra steps.
//
// Both handlers run in a real transaction with SELECT ... FOR UPDATE on the repo
// brain row, because "check then insert" across two statements is a race: two
// concurrent mints for the same repo would otherwise both pass the
// already-has-an-active-key check and issue two live keys.

// DNS-safe: these slugs become brain slugs and appear in operator tooling. Also
// the reason a slug can never smuggle SQL or a namespace separator.
const REPO_SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// Brains and principals live in separate namespaces (each is unique per
// household), kept visibly distinct so an operator reading a row knows which
// table they are looking at.
const BRAIN_SLUG_PREFIX = "repo:";
const PRINCIPAL_SLUG_PREFIX = "repo-service:";
const AGENT_PRINCIPAL_SLUG_PREFIX = "pi:";

// principal_type / credential_type are plain text with no CHECK constraint
// (migration 005), so 'caged_agent' and 'agent_key' need no migration. Verified
// against ob1_dev: pg_constraint carries no check on either column. They are
// module constants precisely BECAUSE the database will not reject a typo.
const PRINCIPAL_TYPE_REPO_SERVICE = "repo_service";
const PRINCIPAL_TYPE_CAGED_AGENT = "caged_agent";
const CREDENTIAL_TYPE_REPO_KEY = "repo_key";
const CREDENTIAL_TYPE_AGENT_KEY = "agent_key";

const MANAGED_PRINCIPAL_TYPES = new Set([PRINCIPAL_TYPE_REPO_SERVICE, PRINCIPAL_TYPE_CAGED_AGENT]);
const MANAGED_CREDENTIAL_TYPES = new Set([CREDENTIAL_TYPE_REPO_KEY, CREDENTIAL_TYPE_AGENT_KEY]);

// The two generic helpers below take a principal/credential type as a parameter,
// which is one refactor away from a caller passing an argument-derived string
// into a security-relevant column. These make that a crash rather than a grant:
// only the module's own constants are ever writable.
function assertManagedPrincipalType(value) {
  if (!MANAGED_PRINCIPAL_TYPES.has(value)) {
    throw new Error(`refusing to write unmanaged principal_type '${value}'`);
  }
  return value;
}

function assertManagedCredentialType(value) {
  if (!MANAGED_CREDENTIAL_TYPES.has(value)) {
    throw new Error(`refusing to write unmanaged credential_type '${value}'`);
  }
  return value;
}

function requireMintCapability(accessContext) {
  if (accessContext?._policy?.caller?.canMintRepoKeys !== true) {
    throw new HttpError(403, "Not authorized to mint repo keys");
  }
}

function validateRepoSlug(value) {
  const slug = typeof value === "string" ? value.trim() : "";
  if (!REPO_SLUG_PATTERN.test(slug)) {
    throw new HttpError(
      400,
      "repo_slug must be DNS-safe: lowercase letters, digits and hyphens, 1-63 chars, not starting or ending with a hyphen",
    );
  }
  return slug;
}

// The minter is brain-less, so its home estate is the only household it can
// provision into. This is what confines minting to one estate.
function mintingHouseholdId(accessContext) {
  const householdId = accessContext?.householdId ?? null;
  if (!householdId) {
    throw new HttpError(403, "Minting key is not homed in an estate");
  }
  return householdId;
}

// display_name is operator-facing text that lands in a brain listing. Unbounded,
// it accepted a 200,000-character name; unstripped, an ANSI escape or a newline
// in it corrupts whatever terminal or listing the operator reads it in. Bound and
// strip here as well as in the zod schema — the schema guards the tool call, this
// guards every caller.
const DISPLAY_NAME_MAX = 128;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

export function sanitizeDisplayName(value) {
  if (typeof value !== "string") {
    return "";
  }
  // Control characters become spaces rather than vanishing, so "a\nb" stays two
  // words instead of silently becoming "ab".
  return value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim().slice(0, DISPLAY_NAME_MAX).trim();
}

function newRepoKey() {
  return crypto.randomBytes(32).toString("hex");
}

// Lock the candidate repo brain for the length of the transaction. Returns null
// when the slug is free.
async function lockRepoBrain(client, householdId, brainSlug) {
  const result = await client.query(
    `select id, kind, egress_class, is_default_shared
     from brains
     where household_id = $1::uuid and slug = $2
     for update`,
    [householdId, brainSlug],
  );
  return result.rows[0] ?? null;
}

// A brain that is not a repo brain — and above all the default shared brain — is
// never touched by either handler. This is the guard that keeps a minting key
// from being pointed at the household's personal brain by naming it.
function assertIsRepoBrain(row, repoSlug) {
  if (row.is_default_shared || row.kind !== "repo" || row.egress_class !== "repo") {
    throw new HttpError(
      409,
      `Brain '${BRAIN_SLUG_PREFIX}${repoSlug}' exists but is not a repo brain; refusing to touch it`,
    );
  }
}

// Every column but principal/brain/label is a literal here — is_admin false,
// can_mint_repo_keys false, read_egress_class null. credential_type is the one
// varying column and it is checked against the module's own set.
async function insertCredential(client, { principalId, brainId, label, credentialType }) {
  assertManagedCredentialType(credentialType);
  const plaintext = newRepoKey();
  const inserted = await client.query(
    `insert into brain_access_keys
       (principal_id, brain_id, key_hash, label, credential_type,
        is_active, is_admin, read_egress_class, can_mint_repo_keys)
     values ($1::uuid, $2::uuid, $3, $4, $5,
             true, false, null, false)
     returning id`,
    [principalId, brainId, hashAccessKey(plaintext), label, credentialType],
  );
  // read_egress_class null => cloud_bound (fail-closed, docs/45 §6.2): neither a
  // repo key nor an agent key may read private_local brains under enforce.
  return { plaintext, keyId: inserted.rows[0].id };
}

function insertRepoKey(client, { principalId, brainId, repoSlug }) {
  return insertCredential(client, {
    principalId,
    brainId,
    label: `repo key: ${repoSlug}`,
    credentialType: CREDENTIAL_TYPE_REPO_KEY,
  });
}

function insertAgentKey(client, { principalId, brainId, repoSlug }) {
  return insertCredential(client, {
    principalId,
    brainId,
    label: `agent key: ${AGENT_PRINCIPAL_SLUG_PREFIX}${repoSlug}`,
    credentialType: CREDENTIAL_TYPE_AGENT_KEY,
  });
}

// Minting is credential issuance. Without a line here the only trace of a mint is
// a row's created_at, and a rotation that revokes a live credential leaves nothing
// at all — so "who minted what, and when" is unanswerable after a key leak.
// Slugs and ids only: never the plaintext, never a hash, not even a prefix.
function auditCredentialEvent(event, fields) {
  console.warn(JSON.stringify({ event, ...fields }));
}

// A principal whose slug happens to match ours may be something else entirely —
// and brain_access_keys grants the reach of its PRINCIPAL, not of the brain we
// name. Adopting a stranger's principal would silently issue a "repo key" that
// carries that principal's whole membership set, including write on a
// private_local personal brain. So: only ever adopt a principal of the type this
// credential family owns, and only one whose memberships are already confined to
// the brains the credential is meant to grant.
//
// The FOR UPDATE here is also what makes each family's "already has a live key"
// check safe: the principal row is the serialization point for two concurrent
// mints of the same credential.
async function resolveManagedPrincipal(client, {
  householdId,
  principalSlug,
  principalType,
  displayName,
  defaultBrainId,
  allowedBrainIds,
  createIfMissing,
  missingMessage,
}) {
  assertManagedPrincipalType(principalType);
  const existing = await client.query(
    `select id, principal_type from brain_principals
     where household_id = $1::uuid and slug = $2
     for update`,
    [householdId, principalSlug],
  );

  if (existing.rowCount === 0) {
    if (!createIfMissing) {
      throw new HttpError(404, missingMessage);
    }
    const created = await client.query(
      `insert into brain_principals
         (household_id, slug, display_name, principal_type, default_brain_id)
       values ($1::uuid, $2, $3, $4, $5::uuid)
       returning id`,
      [householdId, principalSlug, displayName, principalType, defaultBrainId],
    );
    return created.rows[0].id;
  }

  const row = existing.rows[0];
  if (row.principal_type !== principalType) {
    throw new HttpError(
      409,
      `Principal '${principalSlug}' exists but is a '${row.principal_type}', not a '${principalType}'; refusing to issue a key for it`,
    );
  }

  const foreign = await client.query(
    `select count(*)::int as n from brain_memberships
     where principal_id = $1::uuid and brain_id <> all($2::uuid[])`,
    [row.id, allowedBrainIds],
  );
  if (foreign.rows[0].n > 0) {
    throw new HttpError(
      409,
      `Principal '${principalSlug}' has memberships on brains outside this credential's scope; refusing to issue a key that would inherit them`,
    );
  }

  return row.id;
}

function resolveRepoServicePrincipal(client, { householdId, principalSlug, brainId, repoSlug }) {
  return resolveManagedPrincipal(client, {
    householdId,
    principalSlug,
    principalType: PRINCIPAL_TYPE_REPO_SERVICE,
    displayName: `Repo service: ${repoSlug}`,
    defaultBrainId: brainId,
    allowedBrainIds: [brainId],
    createIfMissing: true,
  });
}

// The caged agent's blast radius IS this brain list: repo brain + the household's
// one shared agent brain, nothing else, ever.
function resolveCagedAgentPrincipal(client, {
  householdId, principalSlug, brainId, sharedBrainId, repoSlug, createIfMissing,
}) {
  return resolveManagedPrincipal(client, {
    householdId,
    principalSlug,
    principalType: PRINCIPAL_TYPE_CAGED_AGENT,
    displayName: `Caged agent: ${repoSlug}`,
    defaultBrainId: brainId,
    allowedBrainIds: [brainId, sharedBrainId],
    createIfMissing,
    missingMessage: `No agent principal '${principalSlug}'; use mint_agent_key to create it`,
  });
}

// The household's shared agent brain is operator-created and NEVER created here:
// it is a cross-repo write surface for an injection-exposed agent, so which brain
// plays that role — and at which egress_class — is a deliberate human decision,
// not a side effect of provisioning a repo. Two of them is equally a human
// decision the code must not make for itself.
async function lockSharedAgentBrain(client, householdId) {
  const result = await client.query(
    `select id, slug, egress_class, is_default_shared, kind
     from brains
     where household_id = $1::uuid and is_shared_agent_brain = true
     order by created_at asc
     for update`,
    [householdId],
  );
  if (result.rowCount === 0) {
    throw new HttpError(
      409,
      "This estate has no shared agent brain (brains.is_shared_agent_brain); create it first — agent keys are never issued against an implicitly created brain",
    );
  }
  if (result.rowCount > 1) {
    throw new HttpError(
      409,
      `This estate has ${result.rowCount} brains marked is_shared_agent_brain; exactly one is required — refusing to guess which one the agent should write to`,
    );
  }

  // The flag alone is not enough authority. It is a plain boolean an operator can
  // set on ANY row, including the household's personal private_local brain — and
  // doing so would hand the caged, injection-exposed pi principal editor rights on
  // it. The shape is checked here, not trusted from the column, for the same
  // reason assertIsRepoBrain re-checks a repo brain rather than trusting its slug.
  const shared = result.rows[0];
  if (shared.is_default_shared || shared.kind !== "repo" || shared.egress_class !== "repo") {
    throw new HttpError(
      409,
      `Brain '${shared.slug}' is flagged is_shared_agent_brain but is not a repo-class brain `
      + `(kind=${shared.kind}, egress_class=${shared.egress_class}, is_default_shared=${shared.is_default_shared}); `
      + "refusing to grant an agent key against it",
    );
  }
  return shared;
}

// Grant editor on exactly the intended brains. ON CONFLICT DO NOTHING and not an
// upsert: an operator who downgraded or denied one of these memberships by hand
// meant it, and a re-mint must not silently restore write.
async function grantEditorMemberships(client, principalId, brainIds) {
  await client.query(
    `insert into brain_memberships (principal_id, brain_id, role)
     select $1::uuid, b, 'editor' from unnest($2::uuid[]) as b
     on conflict (principal_id, brain_id) do nothing`,
    [principalId, brainIds],
  );
}

// mint_repo_key — CREATE-ONLY. It will provision a missing repo brain, but it
// will never replace a live credential: if the repo brain already has an active
// key, the caller is told to rotate instead. Silently issuing a second live key
// would mean a repo has two valid credentials and revoking one revokes nothing.
export async function handleMintRepoKey(args, accessContext) {
  requireMintCapability(accessContext);
  const repoSlug = validateRepoSlug(args?.repo_slug);
  const householdId = mintingHouseholdId(accessContext);
  const brainSlug = `${BRAIN_SLUG_PREFIX}${repoSlug}`;
  const principalSlug = `${PRINCIPAL_SLUG_PREFIX}${repoSlug}`;
  const displayName = sanitizeDisplayName(args?.display_name) || `Repo brain: ${repoSlug}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let brainId;
    const existing = await lockRepoBrain(client, householdId, brainSlug);
    if (existing) {
      assertIsRepoBrain(existing, repoSlug);
      // Scoped to the REPO-SERVICE credential, not to the brain. The caged agent
      // holds an agent_key on this same brain; a brain-wide check would report
      // "already has an active key" for a repo that has never been issued one,
      // making provisioning order (agent before repo) an unrecoverable 409.
      const active = await client.query(
        `select 1
         from brain_access_keys k
         join brain_principals p on p.id = k.principal_id
         where k.brain_id = $1::uuid
           and k.is_active = true
           and k.credential_type = $2
           and p.principal_type = $3
         limit 1`,
        [existing.id, CREDENTIAL_TYPE_REPO_KEY, PRINCIPAL_TYPE_REPO_SERVICE],
      );
      if (active.rowCount > 0) {
        throw new HttpError(
          409,
          `Repo '${repoSlug}' already has an active key; use rotate_repo_key to replace it`,
        );
      }
      brainId = existing.id;
    } else {
      try {
        const created = await client.query(
          `insert into brains (household_id, slug, display_name, kind, egress_class, is_default_shared)
           values ($1::uuid, $2, $3, 'repo', 'repo', false)
           returning id`,
          [householdId, brainSlug, displayName],
        );
        brainId = created.rows[0].id;
      } catch (error) {
        // Losing a create race is the same condition as "already provisioned", and
        // the caller deserves that answer rather than a raw Postgres constraint
        // name. FOR UPDATE cannot cover this case: there is no row to lock yet.
        if (error?.code === "23505") {
          throw new HttpError(
            409,
            `Repo '${repoSlug}' already has an active key; use rotate_repo_key to replace it`,
          );
        }
        throw error;
      }
    }

    // The per-repo service principal is reused across rotations, so the repo's
    // audit trail stays attached to one identity rather than fragmenting per key.
    const principalId = await resolveRepoServicePrincipal(client, {
      householdId, principalSlug, brainId, repoSlug,
    });

    await client.query(
      `insert into brain_memberships (principal_id, brain_id, role)
       values ($1::uuid, $2::uuid, 'editor')
       on conflict (principal_id, brain_id) do nothing`,
      [principalId, brainId],
    );

    const { plaintext, keyId } = await insertRepoKey(client, { principalId, brainId, repoSlug });
    await client.query("COMMIT");

    auditCredentialEvent("repo_key.minted", {
      mintedByPrincipalId: accessContext?.principalId ?? null,
      repoSlug,
      brainId,
      brainSlug,
      principalId,
      keyId,
    });

    // Plaintext is returned exactly once and stored nowhere.
    return {
      repo_slug: repoSlug,
      brain_id: brainId,
      brain_slug: brainSlug,
      principal_id: principalId,
      key: plaintext,
      note: "Store this key now — it is returned once and only its sha256 hash is persisted.",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// rotate_repo_key — REVOKE + REPLACE in one transaction. Without this, mint's
// create-only rule is a deadlock: a compromised or lost repo key could never be
// replaced through the capability, only by hand with the admin secret.
export async function handleRotateRepoKey(args, accessContext) {
  requireMintCapability(accessContext);
  const repoSlug = validateRepoSlug(args?.repo_slug);
  const householdId = mintingHouseholdId(accessContext);
  const brainSlug = `${BRAIN_SLUG_PREFIX}${repoSlug}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const brain = await lockRepoBrain(client, householdId, brainSlug);
    if (!brain) {
      throw new HttpError(404, `No repo brain for '${repoSlug}'`);
    }
    assertIsRepoBrain(brain, repoSlug);

    const principalResult = await client.query(
      `select p.id
       from brain_principals p
       join brain_memberships m on m.principal_id = p.id
       where m.brain_id = $1::uuid
         and p.principal_type = 'repo_service'
         and p.household_id = $2::uuid
       order by p.created_at asc
       limit 1`,
      [brain.id, householdId],
    );
    if (principalResult.rowCount === 0) {
      throw new HttpError(409, `Repo brain '${brainSlug}' has no repo_service principal to rotate`);
    }
    const principalId = principalResult.rows[0].id;

    // Scoped to the repo-service PRINCIPAL and to repo_key, not to the brain.
    // A brain-wide revoke also killed the caged agent's key on this brain, so
    // rotating the harness credential silently took pi offline with no mention of
    // it in the result. The minter's own key is untouched either way: it has
    // brain_id null and a different principal.
    const revoked = await client.query(
      `update brain_access_keys
       set is_active = false, updated_at = now()
       where brain_id = $1::uuid
         and is_active = true
         and principal_id = $2::uuid
         and credential_type = $3`,
      [brain.id, principalId, CREDENTIAL_TYPE_REPO_KEY],
    );

    const { plaintext, keyId } = await insertRepoKey(client, { principalId, brainId: brain.id, repoSlug });
    await client.query("COMMIT");

    auditCredentialEvent("repo_key.rotated", {
      rotatedByPrincipalId: accessContext?.principalId ?? null,
      repoSlug,
      brainId: brain.id,
      brainSlug,
      principalId,
      keyId,
      revokedKeyCount: revoked.rowCount,
    });

    return {
      repo_slug: repoSlug,
      brain_id: brain.id,
      brain_slug: brainSlug,
      principal_id: principalId,
      revoked_key_count: revoked.rowCount,
      key: plaintext,
      note: "Store this key now — it is returned once and only its sha256 hash is persisted. Previous keys for this repo are revoked.",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// mint_agent_key — CREATE-ONLY, like mint_repo_key. Issues the caged agent (pi)
// its OWN principal, because a key carries its principal's memberships: handing
// pi the repo-service key would either give the harnesses the shared agent brain
// or give pi nothing, and there is no third option with one shared principal.
//
// Neither brain is ever created here. The repo brain comes from mint_repo_key;
// the shared agent brain is an operator decision (lockSharedAgentBrain).
export async function handleMintAgentKey(args, accessContext) {
  requireMintCapability(accessContext);
  const repoSlug = validateRepoSlug(args?.repo_slug);
  const householdId = mintingHouseholdId(accessContext);
  const brainSlug = `${BRAIN_SLUG_PREFIX}${repoSlug}`;
  const principalSlug = `${AGENT_PRINCIPAL_SLUG_PREFIX}${repoSlug}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock order is repo brain then shared agent brain in both agent handlers:
    // every concurrent agent mint takes the same brains in the same order, so two
    // repos provisioning at once cannot deadlock on the one shared brain.
    const brain = await lockRepoBrain(client, householdId, brainSlug);
    if (!brain) {
      throw new HttpError(404, `No repo brain for '${repoSlug}'; run mint_repo_key first`);
    }
    assertIsRepoBrain(brain, repoSlug);
    const sharedBrain = await lockSharedAgentBrain(client, householdId);

    const principalId = await resolveCagedAgentPrincipal(client, {
      householdId, principalSlug, brainId: brain.id, sharedBrainId: sharedBrain.id,
      repoSlug, createIfMissing: true,
    });

    // Create-only, scoped to the agent credential: a second live agent key would
    // mean revoking one revokes nothing. The principal row is FOR UPDATE-held by
    // resolveCagedAgentPrincipal, so this check cannot race its own insert.
    const active = await client.query(
      `select 1 from brain_access_keys
       where principal_id = $1::uuid and credential_type = $2 and is_active = true
       limit 1`,
      [principalId, CREDENTIAL_TYPE_AGENT_KEY],
    );
    if (active.rowCount > 0) {
      throw new HttpError(
        409,
        `Agent '${principalSlug}' already has an active key; use rotate_agent_key to replace it`,
      );
    }

    await grantEditorMemberships(client, principalId, [brain.id, sharedBrain.id]);

    const { plaintext, keyId } = await insertAgentKey(client, {
      principalId, brainId: brain.id, repoSlug,
    });
    await client.query("COMMIT");

    auditCredentialEvent("agent_key.minted", {
      mintedByPrincipalId: accessContext?.principalId ?? null,
      repoSlug,
      brainId: brain.id,
      brainSlug,
      sharedBrainId: sharedBrain.id,
      sharedBrainSlug: sharedBrain.slug,
      principalId,
      principalSlug,
      keyId,
    });

    return {
      repo_slug: repoSlug,
      brain_id: brain.id,
      brain_slug: brainSlug,
      shared_brain_id: sharedBrain.id,
      shared_brain_slug: sharedBrain.slug,
      // Surfaced because a cloud_bound agent key cannot read a private_local
      // shared brain under egress enforce: the operator sees here whether the
      // brain they marked shared is actually reachable by the agent.
      shared_brain_egress_class: sharedBrain.egress_class,
      principal_id: principalId,
      principal_slug: principalSlug,
      key: plaintext,
      note: "Store this key now — it is returned once and only its sha256 hash is persisted.",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// rotate_agent_key — REVOKE + REPLACE for the caged agent only. The agent is the
// injection-exposed principal, so this is the credential most likely to need
// burning in a hurry; it must not take the harness keys down with it.
export async function handleRotateAgentKey(args, accessContext) {
  requireMintCapability(accessContext);
  const repoSlug = validateRepoSlug(args?.repo_slug);
  const householdId = mintingHouseholdId(accessContext);
  const brainSlug = `${BRAIN_SLUG_PREFIX}${repoSlug}`;
  const principalSlug = `${AGENT_PRINCIPAL_SLUG_PREFIX}${repoSlug}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const brain = await lockRepoBrain(client, householdId, brainSlug);
    if (!brain) {
      throw new HttpError(404, `No repo brain for '${repoSlug}'`);
    }
    assertIsRepoBrain(brain, repoSlug);
    const sharedBrain = await lockSharedAgentBrain(client, householdId);

    // Rotation re-runs the membership check, not just the type check: a principal
    // that gained reach since it was minted must not have that reach re-issued
    // under a fresh key just because the slug still matches.
    const principalId = await resolveCagedAgentPrincipal(client, {
      householdId, principalSlug, brainId: brain.id, sharedBrainId: sharedBrain.id,
      repoSlug, createIfMissing: false,
    });

    // Scoped to the agent principal AND agent_key: never the repo key on this
    // brain, never the minter's key (different principal, brain_id null).
    const revoked = await client.query(
      `update brain_access_keys
       set is_active = false, updated_at = now()
       where principal_id = $1::uuid and credential_type = $2 and is_active = true`,
      [principalId, CREDENTIAL_TYPE_AGENT_KEY],
    );

    const { plaintext, keyId } = await insertAgentKey(client, {
      principalId, brainId: brain.id, repoSlug,
    });
    await client.query("COMMIT");

    auditCredentialEvent("agent_key.rotated", {
      rotatedByPrincipalId: accessContext?.principalId ?? null,
      repoSlug,
      brainId: brain.id,
      brainSlug,
      sharedBrainId: sharedBrain.id,
      sharedBrainSlug: sharedBrain.slug,
      principalId,
      principalSlug,
      keyId,
      revokedKeyCount: revoked.rowCount,
    });

    return {
      repo_slug: repoSlug,
      brain_id: brain.id,
      brain_slug: brainSlug,
      shared_brain_id: sharedBrain.id,
      shared_brain_slug: sharedBrain.slug,
      shared_brain_egress_class: sharedBrain.egress_class,
      principal_id: principalId,
      principal_slug: principalSlug,
      revoked_key_count: revoked.rowCount,
      key: plaintext,
      note: "Store this key now — it is returned once and only its sha256 hash is persisted. Previous agent keys for this repo are revoked; repo keys are untouched.",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Exported for unit tests: the pure validation surface, without a DB.
export const __testables = {
  REPO_SLUG_PATTERN,
  validateRepoSlug,
  requireMintCapability,
  sanitizeDisplayName,
  DISPLAY_NAME_MAX,
  BRAIN_SLUG_PREFIX,
  PRINCIPAL_SLUG_PREFIX,
  AGENT_PRINCIPAL_SLUG_PREFIX,
  PRINCIPAL_TYPE_REPO_SERVICE,
  PRINCIPAL_TYPE_CAGED_AGENT,
  CREDENTIAL_TYPE_REPO_KEY,
  CREDENTIAL_TYPE_AGENT_KEY,
  assertManagedPrincipalType,
  assertManagedCredentialType,
  assertIsRepoBrain,
};
