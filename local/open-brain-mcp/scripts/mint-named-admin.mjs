#!/usr/bin/env node
// mint-named-admin.mjs — create the NAMED ADMIN principal and install (or
// rotate) its stored admin key (ADR-0005).
//
// READ THIS BEFORE RUNNING. The credential this installs is STRICTLY MORE
// POWERFUL than the legacy `MCP_ACCESS_KEY` it replaces. A stored admin key
// satisfies the named-admin-service-key shape, so it CAN purge (hard-erase
// thoughts, irreversibly) — access-policy.mjs:145-151 and :226-233. The legacy
// env key never could: authorizeAction denies PURGE for it outright
// (access-policy.mjs:216-221). Everything else the legacy key did — full CRUD,
// the four /graph/* routes, graph_assisted ask, graph stats — this key also
// does, within its reach.
//
// WHY IT MUST EXIST: once ob1-stable holds its own undistributed
// `MCP_ACCESS_KEY` (ADR-0004), auth.mjs:581 is unreachable by any caller,
// nothing in the repo mints a stored admin key (every other minting path writes
// is_admin=false as a literal), and roles never confer purge (ADR-0002). Purge
// and the whole graph admin plane would become permanently unreachable. This
// script is the ONLY grantor of is_admin=true that does not bless the server's
// own boot secret — bootstrap-open-brain-household.sh:268-299 is the other one,
// and that is exactly the path ADR-0004 gates off.
//
// WHY THE SLUG IS `system:admin`: the `system:` namespace is reserved for
// secret-backed machine principals (`system:minter`, docs/53) and cannot
// collide with a person (`luchoh`) or a repo service (`repo-service:<slug>`).
// One fixed slug — not `admin:<name>` — because idempotent rotation needs a
// stable identity to rotate, and a second named admin would be a second
// skeleton key, which is the thing being retired.
//
// The raw key is read from a TTY WITHOUT ECHO, stored only as sha256(key), and
// never logged, never written to disk, never passed as argv (which would land
// in shell history and ps). It goes into the operator's password manager and
// NOWHERE else: not a .env file, not an agenix secret consumed by an agent, not
// a cage. An agent that holds it holds everything the withdrawal was meant to
// take away, plus purge.
//
// Idempotent: re-running deactivates any active key of this principal and
// installs the new one in the same transaction, so this doubles as the rotation
// path.
//
// Usage:
//   node scripts/mint-named-admin.mjs                          # detect + confirm, no echo
//   node scripts/mint-named-admin.mjs --household local-household --brain luchoh
//   OB1_NAMED_ADMIN_KEY=... node scripts/mint-named-admin.mjs --household <uuid|slug> --yes
//
// Flags / env:
//   --household <uuid|slug>  OB1_NAMED_ADMIN_HOUSEHOLD      estate to home the admin in
//   --brain <slug|uuid>      OB1_NAMED_ADMIN_BRAIN          default-brain hint for the key
//   --local-trusted          OB1_NAMED_ADMIN_LOCAL_TRUSTED  mark the key local_trusted
//   --yes                    OB1_NAMED_ADMIN_ASSUME_YES     skip the confirmation prompt
//   (key)                    OB1_NAMED_ADMIN_KEY            raw key, for automation

import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db.mjs";
import { hashAccessKey } from "../src/auth.mjs";

const MIN_KEY_LENGTH = 32;
const ADMIN_SLUG = "system:admin";

function fail(message) {
  console.error(`mint-named-admin: ${message}`);
  process.exitCode = 1;
}

class UsageError extends Error {}

function parseArgs(argv) {
  let household = process.env.OB1_NAMED_ADMIN_HOUSEHOLD?.trim() || null;
  let brain = process.env.OB1_NAMED_ADMIN_BRAIN?.trim() || null;
  let localTrusted = process.env.OB1_NAMED_ADMIN_LOCAL_TRUSTED === "1";
  let assumeYes = process.env.OB1_NAMED_ADMIN_ASSUME_YES === "1";

  const valueOf = (arg, next, flag) => {
    const value = arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1).trim() : next?.trim();
    if (!value) throw new UsageError(`${flag} needs a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") {
      assumeYes = true;
    } else if (arg === "--local-trusted") {
      localTrusted = true;
    } else if (arg === "--household" || arg.startsWith("--household=")) {
      household = valueOf(arg, argv[i + 1], "--household");
      if (!arg.includes("=")) i += 1;
    } else if (arg === "--brain" || arg.startsWith("--brain=")) {
      brain = valueOf(arg, argv[i + 1], "--brain");
      if (!arg.includes("=")) i += 1;
    } else {
      throw new UsageError(`unknown argument '${arg}'`);
    }
  }

  return { household, brain, localTrusted, assumeYes };
}

// No-echo TTY read. Falls back to a plain stdin read when stdin is a pipe, so the
// script still works under automation — there is nothing to hide from in a pipe.
function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;

    if (!stdin.isTTY) {
      let piped = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk) => { piped += chunk; });
      stdin.on("end", () => resolve(piped.trim()));
      stdin.on("error", reject);
      return;
    }

    process.stderr.write(prompt);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();

    // Raw mode means WE handle the control characters the line discipline would
    // normally interpret: Enter, Ctrl-C, Ctrl-D, backspace. Nothing is echoed,
    // which is the entire point — the key must not reach the scrollback.
    const ETX = "\u0003";       // Ctrl-C
    const EOT = "\u0004";       // Ctrl-D
    const DEL = "\u007f";       // backspace on most terminals

    let buffer = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r" || ch === EOT) {
          finish(resolve, buffer.trim());
          return;
        }
        if (ch === ETX) {
          finish(reject, new Error("aborted"));
          return;
        }
        if (ch === DEL || ch === "\b") {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += ch;
      }
    };

    function finish(settle, value) {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
      settle(value);
    }

    stdin.on("data", onData);
  });
}

// Echoing line read for the confirmation. Only ever used on a TTY: with no
// terminal there is no human to confirm, and this script refuses rather than
// assuming consent.
function readLine(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setEncoding("utf8");
    stdin.resume();
    const onData = (chunk) => {
      stdin.pause();
      stdin.removeListener("data", onData);
      resolve(chunk.trim());
    };
    stdin.on("data", onData);
    stdin.once("error", reject);
  });
}

function describeHousehold(row) {
  return `${row.slug} (${row.id}) — ${Number(row.personal_brains)} personal brain(s), ${Number(row.total_brains)} brain(s) total`;
}

// Every household with the brain counts that decide the auto-detection. The
// signal for an ADMIN estate is different from the minter's (docs/53): a stored
// admin key reaches its HOME ESTATE plus its memberships (ADR-0003), so the
// right home is the operator's own estate — the one holding their personal
// brain, which is the estate purge is actually needed in.
async function loadHouseholdCandidates(client) {
  const result = await client.query(
    `select h.id, h.slug, h.display_name,
            count(b.id) filter (where b.kind = 'personal') as personal_brains,
            count(b.id) as total_brains
     from households h
     left join brains b on b.household_id = h.id
     group by h.id, h.slug, h.display_name, h.created_at
     order by count(b.id) filter (where b.kind = 'personal') desc,
              count(b.id) desc,
              h.created_at asc`,
  );
  return result.rows;
}

async function resolveNamedHousehold(client, name) {
  const result = await client.query(
    `select h.id, h.slug, h.display_name,
            count(b.id) filter (where b.kind = 'personal') as personal_brains,
            count(b.id) as total_brains
     from households h
     left join brains b on b.household_id = h.id
     where h.slug = $1 or h.id::text = $1
     group by h.id, h.slug, h.display_name`,
    [name],
  );
  if (result.rowCount === 0) {
    throw new Error(`no household matches '${name}' (pass a household slug or uuid).`);
  }
  return result.rows[0];
}

// Fail closed: pick a household only when the evidence points at exactly one.
// Anything else is reported as a choice for the operator to make explicitly —
// homing an admin in the wrong estate installs a purge-capable credential that
// cannot see the brains it was created to erase from.
function autoDetectHousehold(candidates) {
  const withPersonalBrains = candidates.filter((row) => Number(row.personal_brains) > 0);
  const plausible = withPersonalBrains.length > 0
    ? withPersonalBrains
    : candidates.filter((row) => Number(row.total_brains) > 0);

  if (plausible.length === 0) {
    throw new Error(
      "no household holds any brain, so there is nothing to detect. Bootstrap the estate first, "
      + "or name the household with --household <uuid|slug>.",
    );
  }
  if (plausible.length > 1) {
    const listing = plausible.map((row) => `  - ${describeHousehold(row)}`).join("\n");
    throw new Error(
      `more than one household could be the admin's home estate; refusing to guess. Re-run with --household <uuid|slug>:\n${listing}`,
    );
  }
  return plausible[0];
}

async function listBrains(client, householdId) {
  const result = await client.query(
    "select id, slug, kind, egress_class from brains where household_id = $1::uuid order by kind, slug",
    [householdId],
  );
  return result.rows;
}

// The key needs a default brain. Unlike the minter, this key does NOT set
// can_mint_repo_keys, so auth.mjs keeps requireUsableBrain on
// (auth.mjs:493, :333): a key that lands on no brain is rejected with 403 on
// every request that does not name one explicitly. The hint is a DEFAULT, never
// a clamp (ADR-0003) — admin reach is still the whole home estate.
function pickDefaultBrain(brains, requested) {
  if (requested) {
    const hit = brains.find((b) => b.slug === requested || b.id === requested);
    if (!hit) {
      throw new Error(`no brain '${requested}' in this household; pass a brain slug or uuid that lives here.`);
    }
    return hit;
  }
  const personal = brains.filter((b) => b.kind === "personal");
  if (personal.length === 1) return personal[0];
  if (personal.length === 0 && brains.length === 1) return brains[0];

  const listing = brains.map((b) => `  - ${b.slug} [kind=${b.kind}]`).join("\n") || "  (none)";
  throw new Error(
    `cannot tell which brain should be the admin key's default; refusing to guess. Re-run with --brain <slug|uuid>:\n${listing}`,
  );
}

// An admin principal left over in another estate is a second purge-capable
// identity in a place this run is not touching. Not fatal here, but the
// operator has to go and remove it by hand.
async function warnAboutForeignAdmins(client, householdId) {
  const result = await client.query(
    `select h.slug as household_slug, h.id as household_id,
            exists (select 1 from brain_access_keys k
                    where k.principal_id = p.id and k.is_active = true) as has_active_key
     from brain_principals p
     join households h on h.id = p.household_id
     where p.slug = $1 and p.household_id <> $2::uuid`,
    [ADMIN_SLUG, householdId],
  );
  for (const row of result.rows) {
    console.warn(
      `WARNING: a '${ADMIN_SLUG}' principal also exists in household ${row.household_slug} (${row.household_id})`
      + `${row.has_active_key ? " and it holds an ACTIVE key" : ""}. Review and remove it.`,
    );
  }
}

// Other live is_admin keys are the whole reason this exists: after ADR-0004 the
// bootstrap-installed 'bootstrap-admin' row (if any) is a stored admin key
// backed by the server's own boot secret. Name them so the operator can revoke.
async function warnAboutOtherAdminKeys(client, principalId) {
  const result = await client.query(
    `select k.label, p.slug as principal_slug, h.slug as household_slug
     from brain_access_keys k
     join brain_principals p on p.id = k.principal_id
     join households h on h.id = p.household_id
     where k.is_admin = true and k.is_active = true and k.principal_id <> $1::uuid
     order by h.slug, p.slug, k.label`,
    [principalId],
  );
  for (const row of result.rows) {
    console.warn(
      `WARNING: another ACTIVE stored admin key exists: label='${row.label}' on principal `
      + `${row.principal_slug} in household ${row.household_slug}. It can purge. Revoke it unless you meant it.`,
    );
  }
}

async function confirm({ household, brains, defaultBrain, localTrusted, assumeYes }) {
  console.log(`Household: ${describeHousehold(household)}`);
  console.log(`Display name: ${household.display_name}`);
  if (brains.length === 0) {
    console.log("Brains: (none)");
  } else {
    console.log("Brains:");
    for (const brain of brains) {
      console.log(`  - ${brain.slug} [kind=${brain.kind}, egress_class=${brain.egress_class}]`);
    }
  }
  console.log("");
  console.log(`About to create the '${ADMIN_SLUG}' principal here (if absent) and install a STORED ADMIN key on it.`);
  console.log("That key is STRICTLY MORE POWERFUL than the legacy MCP_ACCESS_KEY it replaces:");
  console.log("  - it CAN purge (irreversible hard erasure); the legacy key never could");
  console.log("  - full read/write/delete/restore on EVERY brain listed above, plus its memberships");
  console.log("  - the four /graph/* admin routes, graph_assisted ask, and graph stats");
  console.log(`Default brain hint: ${defaultBrain.slug} (${defaultBrain.kind}) — a default, not a clamp.`);
  console.log(`read_egress_class: ${localTrusted ? "local_trusted" : "cloud_bound (default)"}`);
  if (!localTrusted) {
    // Under OB1_EGRESS_ENFORCE=enforce a cloud-bound caller has every non-public
    // brain stripped from scope (access-policy.mjs:329-352) — including the
    // private_local brains purge exists for. Say so BEFORE the key is typed.
    console.log("  NOTE: under egress 'enforce' a cloud_bound key cannot see private_local brains at all,");
    console.log("        so purge would be unreachable there. Re-run with --local-trusted if this key is");
    console.log("        operator-held on the host and must reach local-only brains.");
  }
  console.log("Store the raw key in a password manager only. Never in a .env, an agenix secret an agent reads, or a cage.");

  if (assumeYes) return;
  if (!process.stdin.isTTY) {
    throw new Error(
      "no terminal to confirm on. Re-run with --household <uuid|slug> --yes once you have checked the estate above.",
    );
  }
  const answer = await readLine("Proceed? [y/N] ");
  if (!/^y(es)?$/i.test(answer)) {
    throw new Error("not confirmed; nothing changed.");
  }
}

async function installKey(client, { householdId, brainId, keyHash, localTrusted }) {
  await client.query("BEGIN");

  await client.query(
    `insert into brain_principals
       (household_id, slug, display_name, principal_type, default_brain_id)
     values ($1::uuid, $2, 'Named administrator', 'admin', null)
     on conflict (household_id, slug) do nothing`,
    [householdId, ADMIN_SLUG],
  );

  // Re-read under FOR UPDATE: this both serialises concurrent runs and catches a
  // pre-existing principal that owns the slug but is not an admin.
  const principal = await client.query(
    `select id, principal_type
     from brain_principals
     where household_id = $1::uuid and slug = $2
     for update`,
    [householdId, ADMIN_SLUG],
  );
  const row = principal.rows[0];
  if (!row) {
    throw new Error(`could not create or find the '${ADMIN_SLUG}' principal.`);
  }
  if (row.principal_type !== "admin") {
    throw new Error(
      `principal '${ADMIN_SLUG}' already exists here with principal_type='${row.principal_type}'; refusing to reuse it.`,
    );
  }
  const principalId = row.id;

  // Reject a hash collision with a DIFFERENT principal rather than letting the
  // unique key_hash index abort with an opaque error — and, worse, rather than
  // handing admin to whatever already holds that key. Re-installing the same raw
  // key for this admin is fine and simply re-installs.
  const clash = await client.query(
    "select principal_id from brain_access_keys where key_hash = $1",
    [keyHash],
  );
  for (const clashRow of clash.rows) {
    if (clashRow.principal_id !== principalId) {
      throw new Error("that key is already registered to a different principal; choose a different key.");
    }
  }
  const revoked = await client.query(
    `update brain_access_keys set is_active = false, updated_at = now()
     where principal_id = $1::uuid and is_active = true`,
    [principalId],
  );

  // Upsert rather than delete-then-insert. A key row can be REFERENCED by
  // thoughts.written_by_key_id, declared `on delete restrict` (migration 021) so
  // that revoking a key can never erase the record of what it wrote — which means
  // deleting the row fails outright once the key has written anything. Reinstalling
  // the same key therefore reactivates its existing row; the revoke above has
  // already deactivated every other key for this principal. brain_id and
  // read_egress_class are refreshed too, so re-running with a different --brain or
  // --local-trusted actually takes effect.
  await client.query(
    `insert into brain_access_keys
       (principal_id, brain_id, key_hash, label, credential_type,
        is_active, is_admin, read_egress_class, can_mint_repo_keys)
     values ($1::uuid, $2::uuid, $3, 'named-admin', 'admin',
             true, true, $4, false)
     on conflict (key_hash) do update
       set is_active = true,
           brain_id = excluded.brain_id,
           read_egress_class = excluded.read_egress_class,
           updated_at = now()`,
    [principalId, brainId, keyHash, localTrusted ? "local_trusted" : null],
  );

  await client.query("COMMIT");
  return { principalId, revokedCount: revoked.rowCount };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    return fail(error instanceof UsageError
      ? `${error.message}. Usage: mint-named-admin.mjs [--household <uuid|slug>] [--brain <slug|uuid>] [--local-trusted] [--yes]`
      : String(error));
  }

  const client = await pool.connect();
  try {
    const household = options.household
      ? await resolveNamedHousehold(client, options.household)
      : autoDetectHousehold(await loadHouseholdCandidates(client));

    const brains = await listBrains(client, household.id);
    const defaultBrain = pickDefaultBrain(brains, options.brain);

    await confirm({
      household,
      brains,
      defaultBrain,
      localTrusted: options.localTrusted,
      assumeYes: options.assumeYes,
    });
    await warnAboutForeignAdmins(client, household.id);

    // The key is read only after the estate is settled: an aborted confirmation
    // must never have asked the operator for a secret.
    const raw = process.env.OB1_NAMED_ADMIN_KEY?.trim() || await readSecret("Raw named-admin key (input hidden): ");
    if (!raw) {
      throw new Error("no key supplied; nothing changed.");
    }
    // This is the most powerful credential in the system. A short one is not
    // worth installing.
    if (raw.length < MIN_KEY_LENGTH) {
      throw new Error(`key must be at least ${MIN_KEY_LENGTH} characters; nothing changed. Generate one with: openssl rand -hex 32`);
    }

    const { principalId, revokedCount } = await installKey(client, {
      householdId: household.id,
      brainId: defaultBrain.id,
      keyHash: hashAccessKey(raw),
      localTrusted: options.localTrusted,
    });

    await warnAboutOtherAdminKeys(client, principalId);

    // Deliberately prints no key material.
    console.log(`Named admin key installed on '${ADMIN_SLUG}' in household ${household.slug} (${household.id}).`);
    console.log(`Default brain: ${defaultBrain.slug}. Revoked ${revokedCount} previously active key(s) of this principal.`);
    console.log("Store the raw key in your password manager now — it cannot be recovered from OB1.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    client.release();
    await pool.end();
  }
}

// Only run when executed directly. Without this guard the module cannot be
// imported, so its argument parsing — which decides which estate an ADMIN key is
// homed in, and whether the wider local_trusted egress class is applied — is
// untestable, and a silently-swallowed typo like --housholed would be found in
// production rather than in a test.
const executedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (executedDirectly) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export const __testables = { parseArgs, pickDefaultBrain, autoDetectHousehold };
