import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const serviceDir = path.resolve(currentDir, "..");
export const repoRoot = path.resolve(serviceDir, "../..");

function parsedEnv(filepath) {
  try {
    return dotenv.parse(fs.readFileSync(filepath));
  } catch {
    return {};
  }
}

function loadRepoEnv() {
  const baseEnv = parsedEnv(path.join(repoRoot, ".env"));
  for (const [key, value] of Object.entries(baseEnv)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  const localEnv = parsedEnv(path.join(repoRoot, ".env.open-brain-local"));
  for (const [key, value] of Object.entries(localEnv)) {
    if (process.env[key] === undefined || process.env[key] === baseEnv[key]) {
      process.env[key] = value;
    }
  }
}

loadRepoEnv();

function envString(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function envNumber(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }
  return parsed;
}

function envOptionalNumber(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }
  return parsed;
}

function envBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Environment variable ${name} must be a boolean`);
}

function pgConfig() {
  const connectionString =
    process.env.OPEN_BRAIN_DATABASE_URL ?? process.env.DATABASE_URL ?? undefined;

  if (connectionString) {
    return { connectionString };
  }

  return {
    host: envString("PGHOST", "10.10.10.100"),
    port: envNumber("PGPORT", 5432),
    database: envString("PGDATABASE", process.env.POSTGRES_DB ?? "ob1"),
    user: envString("PGUSER", process.env.POSTGRES_USER ?? "ob1"),
    password: envString("PGPASSWORD", process.env.POSTGRES_PASSWORD),
  };
}

export const config = {
  serviceName: process.env.OPEN_BRAIN_SERVICE_NAME ?? "open-brain-local",
  host: process.env.OPEN_BRAIN_HOST ?? "127.0.0.1",
  port: envNumber("OPEN_BRAIN_PORT", 8787),
  accessKey: envString("MCP_ACCESS_KEY", undefined),
  llmBaseUrl: envString("LLM_BASE_URL", "http://10.10.10.101:8035/v1").replace(/\/$/, ""),
  llmHealthUrl: envString("LLM_HEALTH_URL", "http://10.10.10.101:8035/health"),
  llmModel: envString("LLM_MODEL", "mlx-community/Qwen3.5-397B-A17B-nvfp4"),
  llmEnableThinking: envBoolean("LLM_ENABLE_THINKING", false),
  embeddingBaseUrl: envString("EMBEDDING_BASE_URL", "http://10.10.10.101:8082/v1").replace(/\/$/, ""),
  embeddingHealthUrl: envString("EMBEDDING_HEALTH_URL", "http://10.10.10.101:8082/health"),
  embeddingModel: envString("EMBEDDING_MODEL", "mlx-community/Qwen3-Embedding-8B-mxfp8"),
  embeddingDimensions: envOptionalNumber("EMBEDDING_DIMENSIONS_PARAMETER", 1536) ?? 1536,
  expectedEmbeddingDimension: envOptionalNumber("EMBEDDING_STORE_DIMENSION", 1536) ?? 1536,
  metadataMaxTokens: envOptionalNumber("OPEN_BRAIN_METADATA_MAX_TOKENS", 400) ?? 400,
  postgres: pgConfig(),
};
