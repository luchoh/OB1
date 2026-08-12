#!/usr/bin/env node
// bootstrap-agent-estate.mjs — create the current-model agent-estate boundary.
//
// This replaces the historical provision.sh bootstrap for a new estate. It
// deliberately creates no legacy brains, repo principals, or access keys. The
// next explicit operator steps are create-shared-agent-brain.mjs and
// mint-authority-init.mjs.
//
// Usage:
//   node scripts/bootstrap-agent-estate.mjs --operator-household local-household --operator luchoh
//   node scripts/bootstrap-agent-estate.mjs --yes

import readline from "node:readline";
import { pool } from "../src/db.mjs";

const DEFAULT_ESTATE = "agent-estate";
const DEFAULT_OPERATOR_HOUSEHOLD = "local-household";
const DEFAULT_OPERATOR = "luchoh";

function fail(message) {
  console.error(`bootstrap-agent-estate: ${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = {
    estate: DEFAULT_ESTATE,
    operatorHousehold: DEFAULT_OPERATOR_HOUSEHOLD,
    operator: DEFAULT_OPERATOR,
    assumeYes: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") options.assumeYes = true;
    else if (["--estate", "--operator-household", "--operator"].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
      options[{ "--estate": "estate", "--operator-household": "operatorHousehold", "--operator": "operator" }[arg]] = value;
    } else throw new Error(`unknown argument '${arg}'.`);
  }
  for (const [label, value] of Object.entries(options)) {
    if (label !== "assumeYes" && !/^[a-z0-9][a-z0-9-]*$/.test(value)) {
      throw new Error(`${label} must be a lowercase slug.`);
    }
  }
  return options;
}

function readLine(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()); }));
}

async function loadOperator(client, { operatorHousehold, operator }) {
  const result = await client.query(
    `select p.id, p.principal_type
       from brain_principals p join households h on h.id = p.household_id
      where h.slug = $1 and p.slug = $2`,
    [operatorHousehold, operator],
  );
  if (result.rowCount !== 1) {
    throw new Error(`operator '${operatorHousehold}:${operator}' does not exist; nothing changed.`);
  }
  if (result.rows[0].principal_type !== "person") {
    throw new Error(`operator '${operatorHousehold}:${operator}' is not a person principal; nothing changed.`);
  }
  return result.rows[0];
}

async function inspectEstate(client, estate) {
  const result = await client.query(
    `select h.id, h.slug, h.display_name,
            count(distinct b.id)::integer as brain_count,
            count(distinct p.id)::integer as principal_count
       from households h
       left join brains b on b.household_id = h.id
       left join brain_principals p on p.household_id = h.id
      where h.slug = $1
      group by h.id, h.slug, h.display_name`,
    [estate],
  );
  return result.rows[0] || null;
}

async function confirm(options, existing) {
  const action = existing
    ? `ensure admin membership on existing estate '${options.estate}' (brains=${existing.brain_count}, principals=${existing.principal_count})`
    : `create empty estate '${options.estate}'`;
  console.log(`Will ${action}.`);
  console.log(`Will grant estate admin to ${options.operatorHousehold}:${options.operator}.`);
  console.log("Will not create brains, repo principals, access keys, or modify any other estate.");
  if (options.assumeYes) return;
  if (!process.stdin.isTTY) throw new Error("no terminal to confirm on; re-run with --yes after checking the target.");
  if (!/^y(es)?$/i.test(await readLine("Proceed? [y/N] "))) throw new Error("not confirmed; nothing changed.");
}

async function bootstrap(client, options, operator) {
  await client.query("BEGIN");
  try {
    await client.query(
      "insert into households (slug, display_name) values ($1, 'Agent Estate') on conflict (slug) do nothing",
      [options.estate],
    );
    const estate = await client.query("select id from households where slug = $1 for update", [options.estate]);
    if (estate.rowCount !== 1) throw new Error(`could not create or find estate '${options.estate}'.`);
    await client.query(
      `insert into estate_memberships (principal_id, estate_id, role)
       values ($1::uuid, $2::uuid, 'admin')
       on conflict (principal_id, estate_id) do update set role = excluded.role, is_deny = false`,
      [operator.id, estate.rows[0].id],
    );
    // A first run establishes the estate. A later run, after common-public was
    // created, reconciles the cross-estate operator ownership the historical
    // production estate uses. It never creates or alters a brain.
    await client.query(
      `insert into brain_memberships (principal_id, brain_id, role)
       select $1::uuid, b.id, 'owner'
       from brains b
       where b.household_id = $2::uuid and b.is_shared_agent_brain = true
       on conflict (principal_id, brain_id) do update set role = excluded.role, is_deny = false`,
      [operator.id, estate.rows[0].id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { return fail(error.message); }
  const client = await pool.connect();
  try {
    const operator = await loadOperator(client, options);
    const existing = await inspectEstate(client, options.estate);
    await confirm(options, existing);
    await bootstrap(client, options, operator);
    console.log(`Agent estate '${options.estate}' is ready; ${options.operatorHousehold}:${options.operator} is its estate admin.`);
    console.log("Next: create-shared-agent-brain.mjs --household agent-estate, then mint-authority-init.mjs --household agent-estate.");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => { fail(error instanceof Error ? error.message : String(error)); });
