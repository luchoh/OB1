#!/usr/bin/env node
// mint-authority-init.mjs — install (or rotate) the repo-key MINTER key (docs/53).
//
// The operator runs this once, by hand, on the OB1 host. It reads a raw key from
// stdin WITHOUT ECHO and stores only sha256(key) against the secret-free
// `system:minter` principal seeded by migration 019. The raw key goes straight
// into the operator's password manager; it is never written to disk, never
// logged, and never passed as an argv (which would land in shell history and ps).
//
// Idempotent: re-running deactivates any active minter key and installs the new
// one in the same transaction, so this doubles as the minter's own rotation path.
//
// This script is the ONLY thing that grants can_mint_repo_keys. There is
// deliberately no tool and no route that does — a capability that can grant
// itself is not least-privilege.
//
// Usage:
//   node scripts/mint-authority-init.mjs          # prompts, no echo
//   OB1_MINTER_KEY=... node scripts/...           # non-interactive (automation)

import { pool } from "../src/db.mjs";
import { hashAccessKey } from "../src/auth.mjs";

const MIN_KEY_LENGTH = 32;

function fail(message) {
  console.error(`mint-authority-init: ${message}`);
  process.exitCode = 1;
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

async function main() {
  const raw = process.env.OB1_MINTER_KEY?.trim() || await readSecret("Raw minter key (input hidden): ");

  if (!raw) {
    return fail("no key supplied; nothing changed.");
  }
  // A minter key is the one credential that can create other credentials. A short
  // one is not worth installing.
  if (raw.length < MIN_KEY_LENGTH) {
    return fail(`key must be at least ${MIN_KEY_LENGTH} characters; nothing changed. Generate one with: openssl rand -hex 32`);
  }

  const keyHash = hashAccessKey(raw);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const principal = await client.query(
      `select id, household_id from brain_principals
       where slug = 'system:minter' and principal_type = 'minter'
       order by created_at asc limit 1
       for update`,
    );
    if (principal.rowCount === 0) {
      throw new Error(
        "no 'system:minter' principal found — apply migration 019 first (./scripts/apply-open-brain-local-migrations.sh). "
        + "If 019 ran against a database with no person principal, its seed inserted nothing; bootstrap the household first.",
      );
    }
    const principalId = principal.rows[0].id;

    // Reject a hash collision with an existing NON-minter key rather than letting
    // the unique key_hash index abort with an opaque error. The same raw key
    // re-installed for the minter itself is fine and simply re-installs.
    const clash = await client.query(
      "select principal_id from brain_access_keys where key_hash = $1",
      [keyHash],
    );
    for (const row of clash.rows) {
      if (row.principal_id !== principalId) {
        throw new Error("that key is already registered to a different principal; choose a different key.");
      }
    }
    // Same-principal reinstall: drop the old row so the unique key_hash index
    // cannot collide with the insert below.
    await client.query("delete from brain_access_keys where key_hash = $1", [keyHash]);

    const revoked = await client.query(
      `update brain_access_keys set is_active = false, updated_at = now()
       where principal_id = $1::uuid and is_active = true`,
      [principalId],
    );

    await client.query(
      `insert into brain_access_keys
         (principal_id, brain_id, key_hash, label, credential_type,
          is_active, is_admin, read_egress_class, can_mint_repo_keys)
       values ($1::uuid, null, $2, 'repo-key minter', 'minter',
               true, false, null, true)`,
      [principalId, keyHash],
    );

    await client.query("COMMIT");
    // Deliberately prints no key material.
    console.log(`Minter key installed. Revoked ${revoked.rowCount} previously active minter key(s).`);
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
