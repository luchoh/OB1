import pg from "pg";
import { config } from "./config.mjs";

const { Pool } = pg;

export const pool = new Pool(config.postgres);

export async function query(text, values = []) {
  return pool.query(text, values);
}

// Run `fn` in ONE transaction with the audit actor announced to Postgres, so the
// revision trigger (migration 022) can stamp `thought_audit.actor` — a NOT NULL
// column a trigger cannot otherwise populate, because the database has no idea
// who the caller is.
//
// `set_config(..., true)` is TRANSACTION scoped, and that is the whole point:
// the pool reuses connections, so a session-scoped setting would leak one
// caller's identity onto the next writer's rows. Transaction scope means the
// value dies with the COMMIT no matter which client picks the connection up
// next.
//
// `fn` receives a bound query function that MUST be used for the mutation —
// the module-level `query` goes to a different pooled connection, where the
// setting does not exist, so the trigger would REFUSE the write (022 fails
// closed). Using the wrong one fails loudly rather than losing attribution.
export async function withAuditActor(actor, fn) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('ob1.actor', $1, true)", [JSON.stringify(actor ?? {})]);
    const result = await fn((text, values = []) => client.query(text, values));
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function healthcheckDatabase() {
  await query("select 1");
}

export function formatVector(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Embedding vector must be a non-empty array");
  }

  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("Embedding vector contains a non-finite value");
    }
  }

  return `[${values.join(",")}]`;
}

export async function closePool() {
  await pool.end();
}
