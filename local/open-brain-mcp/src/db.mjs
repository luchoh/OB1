import pg from "pg";
import { config } from "./config.mjs";

const { Pool } = pg;

export const pool = new Pool(config.postgres);

export async function query(text, values = []) {
  return pool.query(text, values);
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
