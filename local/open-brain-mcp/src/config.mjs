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

function envOptionalString(name) {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function withTlsPreference(consul) {
  if (
    consul.skipTlsVerify
    && consul.addr?.startsWith("https://")
    && process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined
  ) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
}

async function discoverConsulService(consul, serviceName) {
  if (!consul.addr) {
    throw new Error(`Missing CONSUL_HTTP_ADDR for Consul discovery of ${serviceName}`);
  }

  withTlsPreference(consul);

  const headers = {};
  if (consul.token) {
    headers["X-Consul-Token"] = consul.token;
  }

  const response = await fetch(
    `${consul.addr.replace(/\/$/, "")}/v1/health/service/${serviceName}?passing=1`,
    { headers },
  );

  if (!response.ok) {
    throw new Error(
      `Consul discovery failed for ${serviceName}: ${response.status} ${response.statusText}`,
    );
  }

  const payload = await response.json();
  const entry = payload?.[0];
  const service = entry?.Service ?? {};
  const address = service.Address || entry?.Node?.Address;
  const port = service.Port;

  if (!address || !port) {
    throw new Error(`Consul service ${serviceName} is missing address/port`);
  }

  return {
    address,
    port,
    rootUrl: `http://${address}:${port}`,
  };
}

async function resolveServiceUrls({ serviceName, baseUrl, healthUrl, consul }) {
  let resolvedBaseUrl = baseUrl;
  let resolvedHealthUrl = healthUrl;

  if (resolvedBaseUrl && resolvedHealthUrl) {
    return {
      baseUrl: resolvedBaseUrl.replace(/\/$/, ""),
      healthUrl: resolvedHealthUrl,
    };
  }

  if (consul.forceDiscovery || !resolvedBaseUrl || !resolvedHealthUrl) {
    const service = await discoverConsulService(consul, serviceName);
    resolvedBaseUrl ??= `${service.rootUrl}/v1`;
    resolvedHealthUrl ??= `${service.rootUrl}/health`;
  }

  if (!resolvedBaseUrl || !resolvedHealthUrl) {
    throw new Error(`Missing service URLs for ${serviceName}`);
  }

  return {
    baseUrl: resolvedBaseUrl.replace(/\/$/, ""),
    healthUrl: resolvedHealthUrl,
  };
}

async function resolveGraphUri({ serviceName, uri, consul }) {
  let resolvedUri = uri;

  if (resolvedUri) {
    return resolvedUri;
  }

  if (consul.forceDiscovery || !resolvedUri) {
    const service = await discoverConsulService(consul, serviceName);
    resolvedUri = `bolt://${service.address}:${service.port}`;
  }

  if (!resolvedUri) {
    throw new Error(`Missing graph URI for ${serviceName}`);
  }

  return resolvedUri;
}

async function pgConfig(consul) {
  const connectionString =
    process.env.OPEN_BRAIN_DATABASE_URL ?? process.env.DATABASE_URL ?? undefined;

  if (connectionString) {
    return { connectionString };
  }

  let host = envOptionalString("PGHOST");
  let port = envOptionalNumber("PGPORT", undefined);

  if (host && port) {
    return {
      host: envString("PGHOST", host),
      port: envNumber("PGPORT", port),
      database: envString("PGDATABASE", process.env.POSTGRES_DB ?? "ob1"),
      user: envString("PGUSER", process.env.POSTGRES_USER ?? "ob1"),
      password: envString("PGPASSWORD", process.env.POSTGRES_PASSWORD),
    };
  }

  if (consul.forceDiscovery || !host || !port) {
    const service = await discoverConsulService(consul, consul.postgresServiceName);
    host ??= service.address;
    port ??= service.port;
  }

  return {
    host: envString("PGHOST", host),
    port: envNumber("PGPORT", port),
    database: envString("PGDATABASE", process.env.POSTGRES_DB ?? "ob1"),
    user: envString("PGUSER", process.env.POSTGRES_USER ?? "ob1"),
    password: envString("PGPASSWORD", process.env.POSTGRES_PASSWORD),
  };
}

async function loadConfig() {
  const runtimeRole = envOptionalString("OPEN_BRAIN_RUNTIME_ROLE") ?? "service";
  const consul = {
    addr: envOptionalString("CONSUL_HTTP_ADDR") ?? "https://consul.lincoln.luchoh.net",
    token: envOptionalString("CONSUL_HTTP_TOKEN") ?? "",
    skipTlsVerify: envBoolean("CONSUL_SKIP_TLS_VERIFY", false),
    forceDiscovery: envBoolean("CONSUL_FORCE_DISCOVERY", false),
    postgresServiceName: envOptionalString("CONSUL_POSTGRES_SERVICE") ?? "postgresql",
  };

  const llmServiceName = envOptionalString("OPEN_BRAIN_LLM_SERVICE_NAME") ?? "mlx-server";
  const embeddingServiceName = envOptionalString("OPEN_BRAIN_EMBEDDING_SERVICE_NAME") ?? "ob1-embedding";
  const graphEnabled = envBoolean("OPEN_BRAIN_GRAPH_ENABLED", false);
  const graphServiceName = envOptionalString("OPEN_BRAIN_GRAPH_SERVICE_NAME") ?? "neo4j-enterprise";
  const needsModelServices = runtimeRole !== "graph-projector";

  let llm;
  if (needsModelServices) {
    llm = await resolveServiceUrls({
      serviceName: llmServiceName,
      baseUrl: envOptionalString("LLM_BASE_URL"),
      healthUrl: envOptionalString("LLM_HEALTH_URL"),
      consul,
    });
  } else {
    llm = {
      baseUrl: envOptionalString("LLM_BASE_URL") ?? "",
      healthUrl: envOptionalString("LLM_HEALTH_URL") ?? "",
    };
  }

  let embedding;
  if (needsModelServices) {
    embedding = await resolveServiceUrls({
      serviceName: embeddingServiceName,
      baseUrl: envOptionalString("EMBEDDING_BASE_URL"),
      healthUrl: envOptionalString("EMBEDDING_HEALTH_URL"),
      consul,
    });
  } else {
    embedding = {
      baseUrl: envOptionalString("EMBEDDING_BASE_URL") ?? "",
      healthUrl: envOptionalString("EMBEDDING_HEALTH_URL") ?? "",
    };
  }

  let graph;
  if (graphEnabled) {
    graph = {
      enabled: true,
      serviceName: graphServiceName,
      uri: await resolveGraphUri({
        serviceName: graphServiceName,
        uri: envOptionalString("NEO4J_URI"),
        consul,
      }),
      username: envString("NEO4J_USERNAME", "neo4j"),
      password: envString("NEO4J_PASSWORD", undefined),
      database: envOptionalString("OPEN_BRAIN_GRAPH_DATABASE") ?? "ob1-graph",
      stagingDatabase: envOptionalString("OPEN_BRAIN_GRAPH_STAGING_DATABASE") ?? "ob1-graph-stage",
      projectorIntervalSeconds: envOptionalNumber("OPEN_BRAIN_GRAPH_PROJECTOR_INTERVAL_SECONDS", 60) ?? 60,
      projectorBatchSize: envOptionalNumber("OPEN_BRAIN_GRAPH_PROJECTOR_BATCH_SIZE", 100) ?? 100,
    };
  } else {
    graph = {
      enabled: false,
      serviceName: graphServiceName,
      uri: undefined,
      username: undefined,
      password: undefined,
      database: envOptionalString("OPEN_BRAIN_GRAPH_DATABASE") ?? "ob1-graph",
      stagingDatabase: envOptionalString("OPEN_BRAIN_GRAPH_STAGING_DATABASE") ?? "ob1-graph-stage",
      projectorIntervalSeconds: envOptionalNumber("OPEN_BRAIN_GRAPH_PROJECTOR_INTERVAL_SECONDS", 60) ?? 60,
      projectorBatchSize: envOptionalNumber("OPEN_BRAIN_GRAPH_PROJECTOR_BATCH_SIZE", 100) ?? 100,
    };
  }

  return {
    serviceName: process.env.OPEN_BRAIN_SERVICE_NAME ?? "open-brain-local",
    runtimeRole,
    host: process.env.OPEN_BRAIN_HOST ?? "localhost",
    port: envNumber("OPEN_BRAIN_PORT", 8787),
    accessKey: envString("MCP_ACCESS_KEY", undefined),
    llmBaseUrl: llm.baseUrl,
    llmHealthUrl: llm.healthUrl,
    llmModel: envString("LLM_MODEL", "mlx-community/Qwen3.5-397B-A17B-nvfp4"),
    llmEnableThinking: envBoolean("LLM_ENABLE_THINKING", false),
    embeddingBaseUrl: embedding.baseUrl,
    embeddingHealthUrl: embedding.healthUrl,
    embeddingModel: envString("EMBEDDING_MODEL", "mlx-community/Qwen3-Embedding-8B-mxfp8"),
    embeddingDimensions: envOptionalNumber("EMBEDDING_DIMENSIONS_PARAMETER", 1536) ?? 1536,
    expectedEmbeddingDimension: envOptionalNumber("EMBEDDING_STORE_DIMENSION", 1536) ?? 1536,
    metadataMaxTokens: envOptionalNumber("OPEN_BRAIN_METADATA_MAX_TOKENS", 400) ?? 400,
    answerMaxTokens: envOptionalNumber("OPEN_BRAIN_ANSWER_MAX_TOKENS", 600) ?? 600,
    graph,
    postgres: await pgConfig(consul),
  };
}

export const config = await loadConfig();
