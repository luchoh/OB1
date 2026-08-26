import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serviceDir = path.resolve(testDir, "..");
const repoRoot = path.resolve(serviceDir, "../..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("interactive repo entry points never load service dotenv files", () => {
  const devenv = readRepoFile("devenv.nix");
  const envrc = readRepoFile(".envrc");

  assert.doesNotMatch(devenv, /dotenv\.(?:enable|filename)/);
  assert.doesNotMatch(envrc, /dotenv_if_exists|source_env|source[ \t]+.*\.env/);
});

test("runtime config imports never acquire repo credentials as a side effect", () => {
  const config = readRepoFile("local/open-brain-mcp/src/config.mjs");

  assert.doesNotMatch(config, /from ["']dotenv["']/);
  assert.doesNotMatch(config, /\.env\.open-brain-local|loadRepoEnv|parsedEnv/);
});

test("the managed local service loads its dotenv inside the service subprocess", () => {
  const devenv = readRepoFile("devenv.nix");
  const subprocessStart = devenv.indexOf("(\n      # Service credentials cross the boundary");
  const dotenvLoad = devenv.indexOf("source .env.open-brain-local", subprocessStart);
  const serviceExec = devenv.indexOf("exec ./scripts/run-open-brain-local.sh", dotenvLoad);

  assert.notEqual(subprocessStart, -1);
  assert.ok(dotenvLoad > subprocessStart);
  assert.ok(serviceExec > dotenvLoad);
});
