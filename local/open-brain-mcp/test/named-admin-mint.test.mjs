import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// scripts/mint-named-admin.mjs (docs/adr/0005) is the only path left that writes
// is_admin=true once the legacy branch is unreachable, so its pure argument and
// brain-selection decisions are worth pinning: the flags decide WHICH estate and
// WHICH default brain the most powerful credential in the system is homed in.
//
// It cannot be imported yet. The module calls main() at top level, so importing
// it opens a pool, prompts on the TTY and can install a key — a test suite must
// never be able to do that by accident. This file therefore stays inert until the
// script exposes its pure helpers, and says exactly what it needs.

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "mint-named-admin.mjs",
);

const source = fs.existsSync(SCRIPT) ? fs.readFileSync(SCRIPT, "utf8") : null;

// Detected by reading, not by importing, for the reason above.
const testablesSkip = source === null
  ? "scripts/mint-named-admin.mjs does not exist yet (docs/adr/0005)"
  : (/export const __testables/.test(source)
    ? false
    : "scripts/mint-named-admin.mjs runs main() at import and exports nothing; "
      + "needs an import.meta-main guard plus `export const __testables = { parseArgs, pickDefaultBrain, autoDetectHousehold }` "
      + "before its argument and brain-selection decisions can be tested");

let testables = null;
if (!testablesSkip) {
  ({ __testables: testables } = await import(SCRIPT));
}

test("named admin: the raw key is never taken from argv", { skip: testablesSkip }, () => {
  // argv lands in shell history and in `ps` output on a shared host. The key may
  // arrive on stdin or through the environment, never as a positional argument.
  assert.throws(() => testables.parseArgs(["deadbeef".repeat(8)]));
  assert.throws(() => testables.parseArgs(["--key", "deadbeef".repeat(8)]));
});

test("named admin: an unknown flag is a usage error, not a silent default", { skip: testablesSkip }, () => {
  // Silently ignoring --housholed would home the admin in an auto-detected estate
  // the operator did not name.
  assert.throws(() => testables.parseArgs(["--housholed", "local-household"]));
  assert.throws(() => testables.parseArgs(["--household"]), undefined, "a flag with no value must not become an empty estate name");
});

test("named admin: --local-trusted is opt-in", { skip: testablesSkip }, () => {
  assert.equal(testables.parseArgs([]).localTrusted, false, "the wider egress class is never the default");
  assert.equal(testables.parseArgs(["--local-trusted"]).localTrusted, true);
});
