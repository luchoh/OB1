import crypto from "node:crypto";
import { pool } from "./db.mjs";
import { HttpError, hashAccessKey } from "./auth.mjs";

// repo-key-minting.mjs — the two handlers behind the `mint_repo_key` and
// `rotate_repo_key` tools (docs/53).
//
// PURPOSE: let system-config provision a per-repo brain + a cloud_bound repo key
// for each interactive harness, so no harness needs the shared MCP_ACCESS_KEY
// (which is global admin). The capability that gates both handlers —
// can_mint_repo_keys — creates repo brains and repo keys and NOTHING else.
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

async function insertRepoKey(client, { principalId, brainId, repoSlug }) {
  const plaintext = newRepoKey();
  const inserted = await client.query(
    `insert into brain_access_keys
       (principal_id, brain_id, key_hash, label, credential_type,
        is_active, is_admin, read_egress_class, can_mint_repo_keys)
     values ($1::uuid, $2::uuid, $3, $4, 'repo_key',
             true, false, null, false)
     returning id`,
    [principalId, brainId, hashAccessKey(plaintext), `repo key: ${repoSlug}`],
  );
  // read_egress_class null => cloud_bound (fail-closed, docs/45 §6.2): a repo key
  // must never read private_local brains under enforce.
  return { plaintext, keyId: inserted.rows[0].id };
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
// private_local personal brain. Only ever adopt a repo_service principal, and only
// one whose memberships do not already reach beyond this repo's brain.
async function resolveRepoServicePrincipal(client, { householdId, principalSlug, brainId, repoSlug }) {
  const existing = await client.query(
    `select id, principal_type from brain_principals
     where household_id = $1::uuid and slug = $2
     for update`,
    [householdId, principalSlug],
  );

  if (existing.rowCount === 0) {
    const created = await client.query(
      `insert into brain_principals
         (household_id, slug, display_name, principal_type, default_brain_id)
       values ($1::uuid, $2, $3, 'repo_service', $4::uuid)
       returning id`,
      [householdId, principalSlug, `Repo service: ${repoSlug}`, brainId],
    );
    return created.rows[0].id;
  }

  const row = existing.rows[0];
  if (row.principal_type !== "repo_service") {
    throw new HttpError(
      409,
      `Principal '${principalSlug}' exists but is a '${row.principal_type}', not a repo service; refusing to issue a key for it`,
    );
  }

  const foreign = await client.query(
    `select count(*)::int as n from brain_memberships
     where principal_id = $1::uuid and brain_id <> $2::uuid`,
    [row.id, brainId],
  );
  if (foreign.rows[0].n > 0) {
    throw new HttpError(
      409,
      `Principal '${principalSlug}' has memberships on other brains; refusing to issue a repo key that would inherit them`,
    );
  }

  return row.id;
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
      const active = await client.query(
        "select 1 from brain_access_keys where brain_id = $1::uuid and is_active = true limit 1",
        [existing.id],
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

    // Scoped to this brain: the minter's own key has brain_id null and can never
    // be caught by this UPDATE, so rotation cannot revoke the minting authority.
    const revoked = await client.query(
      `update brain_access_keys
       set is_active = false, updated_at = now()
       where brain_id = $1::uuid and is_active = true`,
      [brain.id],
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

// Exported for unit tests: the pure validation surface, without a DB.
export const __testables = {
  REPO_SLUG_PATTERN,
  validateRepoSlug,
  requireMintCapability,
  sanitizeDisplayName,
  DISPLAY_NAME_MAX,
};
