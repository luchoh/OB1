import pg from "pg";
import { config } from "./config.mjs";

const { Pool } = pg;

export const pool = new Pool(config.postgres);
const tunedClients = new WeakSet();

async function ensureSessionSettings(client) {
  if (tunedClients.has(client)) {
    return;
  }

  if (config.forceSeqscan) {
    // The current shared ob1 database can hang on reads against `thoughts`
    // unless index-driven plan types are disabled for the session. This keeps
    // the local service usable while the underlying index issue is investigated.
    await client.query(`
      set enable_indexscan = off;
      set enable_bitmapscan = off;
      set enable_indexonlyscan = off;
    `);
  }
  tunedClients.add(client);
}

export async function query(text, values = []) {
  const client = await pool.connect();
  try {
    await ensureSessionSettings(client);
    return await client.query(text, values);
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
