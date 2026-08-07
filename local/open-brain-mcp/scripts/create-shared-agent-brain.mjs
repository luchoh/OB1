#!/usr/bin/env node
// create-shared-agent-brain.mjs — create the estate's ONE shared agent brain.
//
// This is the brain pi writes to across every repo. mint_agent_key grants
// pi:<repo> editor on it, and refuses outright when it does not exist — creating
// it implicitly from a minting call would let a tool decide, unattended, which
// estate gets a cross-repo write surface. That is the operator's call, so it
// lives here, where a human is present to see the estate and say yes.
//
// WHY THE BRAIN IS BORN CLOUD-READABLE (egress_class='repo'):
// pi's key is cloud_bound, like every agent key. Under OB1_EGRESS_ENFORCE=enforce
// a cloud_bound caller has private_local brains stripped from its scope entirely,
// so a shared brain classified private_local would simply vanish for pi the day
// enforce is flipped — search, ask AND capture. Creating it as 'repo' from the
// start avoids that, and avoids the alternative fixes, which are both worse:
// marking the caged agent's key local_trusted, or declassifying an existing brain
// (a §6.13 transition whose machinery does not exist in this codebase).
//
// It also does NOT declassify anything. The existing agent-common brain is
// untouched and stays private_local. This creates a NEW, empty brain that has
// never held anything — which is why nothing here needs a transition ceremony.
// docs/45 §8.2 recorded this two-brain shape as owner-resolved on 2026-06-24;
// this is the half that was never built.
//
// NOTHING CONFIDENTIAL BELONGS IN IT. 'repo' means cloud-readable, and pi can
// forward anything it reads to any endpoint the cage can reach. The label is the
// honest description of that, not a control.
//
// Usage:
//   node scripts/create-shared-agent-brain.mjs                          # detect + confirm
//   node scripts/create-shared-agent-brain.mjs --household agent-estate
//   node scripts/create-shared-agent-brain.mjs --household agent-estate --yes
//
//   --household <uuid|slug>   OB1_SHARED_BRAIN_HOUSEHOLD
//   --slug <slug>             OB1_SHARED_BRAIN_SLUG        (default: common-public)
//   --yes                     OB1_SHARED_BRAIN_ASSUME_YES  skip the confirmation

import readline from "node:readline";
import { pool } from "../src/db.mjs";

const DEFAULT_SLUG = "common-public";

function fail(message) {
  console.error(`create-shared-agent-brain: ${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = {
    household: process.env.OB1_SHARED_BRAIN_HOUSEHOLD?.trim() || null,
    slug: process.env.OB1_SHARED_BRAIN_SLUG?.trim() || DEFAULT_SLUG,
    assumeYes: process.env.OB1_SHARED_BRAIN_ASSUME_YES === "1",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") {
      options.assumeYes = true;
    } else if (arg === "--household" || arg === "--slug") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} needs a value.`);
      }
      options[arg === "--household" ? "household" : "slug"] = value;
      i += 1;
    } else if (arg.startsWith("--household=")) {
      options.household = arg.slice("--household=".length);
    } else if (arg.startsWith("--slug=")) {
      options.slug = arg.slice("--slug=".length);
    } else {
      throw new Error(`unknown argument '${arg}'. Usage: --household <uuid|slug> [--slug <slug>] [--yes]`);
    }
  }
  return options;
}

function readLine(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()); }));
}

function describeHousehold(row) {
  return `${row.slug} (${row.id}) — ${Number(row.repo_brains)} repo brain(s), ${Number(row.total_brains)} brain(s) total`;
}

// Same shape as mint-authority-init.mjs: rank by repo brains, then by any brains.
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

// Fail closed. On a real estate this usually REFUSES — the agent brains are
// kind='personal', not kind='repo', so both households look equally plausible and
// the operator must name one. That refusal is the feature.
function autoDetectHousehold(candidates) {
  const withRepoBrains = candidates.filter((row) => Number(row.repo_brains) > 0);
  const plausible = withRepoBrains.length > 0
    ? withRepoBrains
    : candidates.filter((row) => Number(row.total_brains) > 0);

  if (plausible.length === 0) {
    throw new Error("no household holds any brain. Bootstrap the estate first, or name it with --household <uuid|slug>.");
  }
  if (plausible.length > 1) {
    const listing = plausible.map((row) => `  - ${describeHousehold(row)}`).join("\n");
    throw new Error(`more than one household could be the agent estate; refusing to guess. Re-run with --household <uuid|slug>:\n${listing}`);
  }
  return plausible[0];
}

async function confirm(household, brains, slug, assumeYes) {
  console.log(`Household: ${describeHousehold(household)}`);
  console.log(`Display name: ${household.display_name}`);
  console.log(brains.length === 0 ? "Existing brains: (none)" : "Existing brains:");
  for (const brain of brains) {
    console.log(`  - ${brain.slug} [kind=${brain.kind}, egress_class=${brain.egress_class}]`);
  }
  console.log("");
  console.log(`Will CREATE brain '${slug}' here: kind=repo, egress_class=repo (CLOUD-READABLE),`);
  console.log("is_shared_agent_brain=true, is_default_shared=false.");
  console.log("Every pi agent key minted in this estate will get read-write on it.");
  console.log("Nothing confidential should ever be filed there.");
  console.log("No existing brain is modified.");

  if (assumeYes) return;
  if (!process.stdin.isTTY) {
    throw new Error("no terminal to confirm on. Re-run with --household <uuid|slug> --yes once you have checked the estate above.");
  }
  const answer = await readLine("Proceed? [y/N] ");
  if (!/^y(es)?$/i.test(answer)) {
    throw new Error("not confirmed; nothing changed.");
  }
}

async function createBrain(client, { householdId, slug }) {
  // Migration 020's partial unique index already caps this at one per household;
  // checking first turns a raw constraint violation into a message that says what
  // to do about it.
  const existingShared = await client.query(
    "select slug from brains where household_id = $1::uuid and is_shared_agent_brain = true",
    [householdId],
  );
  if (existingShared.rowCount > 0) {
    throw new Error(
      `this estate already has a shared agent brain: '${existingShared.rows[0].slug}'. `
      + "An estate gets exactly one; mint_agent_key would not know which to pick.",
    );
  }

  const clash = await client.query(
    "select kind, egress_class, is_shared_agent_brain from brains where household_id = $1::uuid and slug = $2",
    [householdId, slug],
  );
  if (clash.rowCount > 0) {
    const row = clash.rows[0];
    throw new Error(
      `a brain named '${slug}' already exists here (kind=${row.kind}, egress_class=${row.egress_class}). `
      + "Refusing to touch it — reclassifying an existing brain is a declassification, not this script's job. "
      + "Pick another name with --slug, or promote its content deliberately.",
    );
  }

  const created = await client.query(
    `insert into brains
       (household_id, slug, display_name, kind, egress_class, is_default_shared, is_shared_agent_brain)
     values ($1::uuid, $2, $3, 'repo', 'repo', false, true)
     returning id`,
    [householdId, slug, "Shared agent brain (cross-repo, cloud-readable)"],
  );
  const brainId = created.rows[0].id;

  // Give the estate's people owner rights, so a human can read, curate and delete
  // what the agents write. Without this the operator's only route in is the admin
  // secret, and there would be no role-based way to clean up a poisoned row.
  const owners = await client.query(
    `insert into brain_memberships (principal_id, brain_id, role)
     select p.id, $2::uuid, 'owner'
     from brain_principals p
     where p.household_id = $1::uuid and p.principal_type = 'person'
     on conflict (principal_id, brain_id) do nothing
     returning principal_id`,
    [householdId, brainId],
  );

  return { brainId, ownerCount: owners.rowCount };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    return fail(error.message);
  }

  const client = await pool.connect();
  try {
    const household = options.household
      ? await resolveNamedHousehold(client, options.household)
      : autoDetectHousehold(await loadHouseholdCandidates(client));

    const brains = (await client.query(
      "select slug, kind, egress_class from brains where household_id = $1::uuid order by kind, slug",
      [household.id],
    )).rows;

    await confirm(household, brains, options.slug, options.assumeYes);

    await client.query("BEGIN");
    const { brainId, ownerCount } = await createBrain(client, {
      householdId: household.id,
      slug: options.slug,
    });
    await client.query("COMMIT");

    console.log(`Created shared agent brain '${options.slug}' (${brainId}) in ${household.slug}.`);
    console.log(`Granted owner to ${ownerCount} person principal(s) in this estate.`);
    if (ownerCount === 0) {
      console.warn("WARNING: no person principal in this estate, so no human holds owner on it. Grant one by hand.");
    }
    console.log("Next: mint_agent_key { repo_slug: \"<repo>\" } will now grant pi read-write here.");
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
