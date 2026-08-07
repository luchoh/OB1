#!/usr/bin/env node
// mint-authority-init.mjs — create the repo-key MINTER principal and install (or
// rotate) its key (docs/53).
//
// The operator runs this once, by hand, on the OB1 host. It reads a raw key from
// stdin WITHOUT ECHO and stores only sha256(key) against the `system:minter`
// principal. The raw key goes straight into the operator's password manager; it
// is never written to disk, never logged, and never passed as an argv (which
// would land in shell history and ps).
//
// WHY THE PRINCIPAL IS CREATED HERE AND NOT IN MIGRATION 019: the minter is
// confined to its own household (repo-key-minting.mjs mints only into
// accessContext.householdId), so homing it in the wrong estate produces a minter
// that can never see an existing repo brain and silently creates empty new ones
// instead. Only a human knows which estate holds the repo brains, so the choice
// is made here — detected, printed, and confirmed — never guessed unattended by a
// migration.
//
// Idempotent: re-running deactivates any active minter key and installs the new
// one in the same transaction, so this doubles as the minter's own rotation path.
//
// This script is the ONLY thing that grants can_mint_repo_keys. There is
// deliberately no tool and no route that does — a capability that can grant
// itself is not least-privilege.
//
// Usage:
//   node scripts/mint-authority-init.mjs                        # detect + confirm, no echo
//   node scripts/mint-authority-init.mjs --household repo-estate
//   OB1_MINTER_KEY=... node scripts/mint-authority-init.mjs --household <uuid|slug> --yes
//
// Flags / env:
//   --household <uuid|slug>   OB1_MINTER_HOUSEHOLD   estate to home the minter in
//   --yes                     OB1_MINTER_ASSUME_YES  skip the confirmation prompt
//   (key)                     OB1_MINTER_KEY         raw key, for automation

import { pool } from "../src/db.mjs";
import { hashAccessKey } from "../src/auth.mjs";

const MIN_KEY_LENGTH = 32;
const MINTER_SLUG = "system:minter";

function fail(message) {
  console.error(`mint-authority-init: ${message}`);
  process.exitCode = 1;
}

class UsageError extends Error {}

function parseArgs(argv) {
  let household = process.env.OB1_MINTER_HOUSEHOLD?.trim() || null;
  let assumeYes = process.env.OB1_MINTER_ASSUME_YES === "1";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") {
      assumeYes = true;
    } else if (arg === "--household") {
      household = argv[i + 1]?.trim() || null;
      i += 1;
      if (!household) throw new UsageError("--household needs a household uuid or slug");
    } else if (arg.startsWith("--household=")) {
      household = arg.slice("--household=".length).trim() || null;
      if (!household) throw new UsageError("--household needs a household uuid or slug");
    } else {
      throw new UsageError(`unknown argument '${arg}'`);
    }
  }

  return { household, assumeYes };
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
  return `${row.slug} (${row.id}) — ${Number(row.repo_brains)} repo brain(s), ${Number(row.total_brains)} brain(s) total`;
}

// Every household with the brain counts that decide the auto-detection. A
// household with no brains at all is never a candidate: an empty estate is a
// bootstrap accident, not a repo estate.
async function loadHouseholdCandidates(client) {
  const result = await client.query(
    `select h.id, h.slug, h.display_name,
            count(b.id) filter (where b.kind = 'repo') as repo_brains,
            count(b.id) as total_brains
     from households h
     left join brains b on b.household_id = h.id
     group by h.id, h.slug, h.display_name, h.created_at
     order by count(b.id) filter (where b.kind = 'repo') desc,
              count(b.id) desc,
              h.created_at asc`,
  );
  return result.rows;
}

async function resolveNamedHousehold(client, name) {
  const result = await client.query(
    `select h.id, h.slug, h.display_name,
            count(b.id) filter (where b.kind = 'repo') as repo_brains,
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
// Anything else is reported as a choice for the operator to make explicitly.
function autoDetectHousehold(candidates) {
  const withRepoBrains = candidates.filter((row) => Number(row.repo_brains) > 0);
  const plausible = withRepoBrains.length > 0
    ? withRepoBrains
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
      `more than one household could be the repo estate; refusing to guess. Re-run with --household <uuid|slug>:\n${listing}`,
    );
  }
  return plausible[0];
}

async function listBrains(client, householdId) {
  const result = await client.query(
    "select slug, kind, egress_class from brains where household_id = $1::uuid order by kind, slug",
    [householdId],
  );
  return result.rows;
}

// A minter left over in another estate (e.g. from the seed migration 019 used to
// carry) is not fatal here, but it is a live principal in the wrong place and the
// operator has to clean it up by hand.
async function warnAboutForeignMinters(client, householdId) {
  const result = await client.query(
    `select h.slug as household_slug, h.id as household_id,
            exists (select 1 from brain_access_keys k
                    where k.principal_id = p.id and k.is_active = true) as has_active_key
     from brain_principals p
     join households h on h.id = p.household_id
     where p.slug = $1 and p.household_id <> $2::uuid`,
    [MINTER_SLUG, householdId],
  );
  for (const row of result.rows) {
    console.warn(
      `WARNING: a '${MINTER_SLUG}' principal also exists in household ${row.household_slug} (${row.household_id})`
      + `${row.has_active_key ? " and it holds an ACTIVE key" : ""}. Review and remove it.`,
    );
  }
}

async function confirm(household, brains, assumeYes) {
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
  console.log(`The '${MINTER_SLUG}' principal will be created here (if absent) and will be able to mint repo keys for THESE brains only.`);

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

async function installKey(client, { householdId, keyHash }) {
  await client.query("BEGIN");

  await client.query(
    `insert into brain_principals
       (household_id, slug, display_name, principal_type, default_brain_id)
     values ($1::uuid, $2, 'Repo-key minting authority', 'minter', null)
     on conflict (household_id, slug) do nothing`,
    [householdId, MINTER_SLUG],
  );

  // Re-read under FOR UPDATE: this both serialises concurrent runs and catches a
  // pre-existing principal that owns the slug but is not a minter.
  const principal = await client.query(
    `select id, principal_type, default_brain_id
     from brain_principals
     where household_id = $1::uuid and slug = $2
     for update`,
    [householdId, MINTER_SLUG],
  );
  const row = principal.rows[0];
  if (!row) {
    throw new Error(`could not create or find the '${MINTER_SLUG}' principal.`);
  }
  if (row.principal_type !== "minter") {
    throw new Error(
      `principal '${MINTER_SLUG}' already exists here with principal_type='${row.principal_type}'; refusing to reuse it.`,
    );
  }
  // The minter is deliberately brain-less, which is why auth.mjs flips
  // requireUsableBrain off for a minting key. A default brain would give it a
  // content surface it has no business having.
  if (row.default_brain_id) {
    throw new Error(`principal '${MINTER_SLUG}' has a default_brain_id set; refusing — the minter must be brain-less.`);
  }
  const principalId = row.id;

  // Reject a hash collision with an existing NON-minter key rather than letting
  // the unique key_hash index abort with an opaque error. The same raw key
  // re-installed for the minter itself is fine and simply re-installs.
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
  // already deactivated every other key for this principal.
  await client.query(
    `insert into brain_access_keys
       (principal_id, brain_id, key_hash, label, credential_type,
        is_active, is_admin, read_egress_class, can_mint_repo_keys)
     values ($1::uuid, null, $2, 'repo-key minter', 'minter',
             true, false, null, true)
     on conflict (key_hash) do update
       set is_active = true, updated_at = now()`,
    [principalId, keyHash],
  );

  await client.query("COMMIT");
  return revoked.rowCount;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    return fail(error instanceof UsageError
      ? `${error.message}. Usage: mint-authority-init.mjs [--household <uuid|slug>] [--yes]`
      : String(error));
  }

  const client = await pool.connect();
  try {
    const household = options.household
      ? await resolveNamedHousehold(client, options.household)
      : autoDetectHousehold(await loadHouseholdCandidates(client));

    await confirm(household, await listBrains(client, household.id), options.assumeYes);
    await warnAboutForeignMinters(client, household.id);

    // The key is read only after the estate is settled: an aborted confirmation
    // must never have asked the operator for a secret.
    const raw = process.env.OB1_MINTER_KEY?.trim() || await readSecret("Raw minter key (input hidden): ");
    if (!raw) {
      throw new Error("no key supplied; nothing changed.");
    }
    // A minter key is the one credential that can create other credentials. A
    // short one is not worth installing.
    if (raw.length < MIN_KEY_LENGTH) {
      throw new Error(`key must be at least ${MIN_KEY_LENGTH} characters; nothing changed. Generate one with: openssl rand -hex 32`);
    }

    const revokedCount = await installKey(client, { householdId: household.id, keyHash: hashAccessKey(raw) });

    // Deliberately prints no key material.
    console.log(`Minter key installed in household ${household.slug} (${household.id}). Revoked ${revokedCount} previously active minter key(s).`);
    console.log("Store the raw key in your password manager now — it cannot be recovered from OB1.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
