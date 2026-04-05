import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";

function stableJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stableJsonValue(entry));
  }

  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.keys(value)
      .sort()
      .reduce((accumulator, key) => {
        accumulator[key] = stableJsonValue(value[key]);
        return accumulator;
      }, {});
  }

  return value;
}

export function stableJsonStringify(value, space = 0) {
  return JSON.stringify(stableJsonValue(value), null, space || undefined);
}

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function ensureParentDirectory(filepath) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
}

function appendJsonLine(filepath, record) {
  ensureParentDirectory(filepath);
  fs.appendFileSync(filepath, `${JSON.stringify(record)}\n`, "utf8");
}

function collapseWhitespace(value) {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ")
    : "";
}

function truncateText(value, limit) {
  if (typeof value !== "string" || value.length <= limit) {
    return value ?? "";
  }

  if (limit <= 3) {
    return value.slice(0, limit);
  }

  return `${value.slice(0, limit - 3)}...`;
}

function readLastJsonLine(filepath) {
  if (!fs.existsSync(filepath)) {
    return null;
  }

  const content = fs.readFileSync(filepath, "utf8").trim();
  if (!content) {
    return null;
  }

  const lines = content.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index].trim();
    if (!candidate) {
      continue;
    }

    try {
      return JSON.parse(candidate);
    } catch (error) {
      console.error(
        `[ob1-observability] failed to parse trailing JSONL record from ${filepath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  return null;
}

function queryTelemetry(queryText) {
  const normalized = collapseWhitespace(queryText);
  if (!normalized) {
    return {
      query_sha256: null,
      query_preview: null,
      query_preview_mode: config.observability.retrievalTelemetry.previewMode,
      query_length: 0,
    };
  }

  const previewMode = config.observability.retrievalTelemetry.previewMode;
  let preview = null;
  if (previewMode === "truncated") {
    preview = truncateText(normalized, config.observability.retrievalTelemetry.previewChars);
  }

  return {
    query_sha256: sha256Hex(normalized),
    query_preview: preview,
    query_preview_mode: previewMode,
    query_length: normalized.length,
  };
}

function rowIds(rows) {
  return (rows ?? [])
    .map((row) => (typeof row?.id === "string" ? row.id : null))
    .filter(Boolean);
}

function rowRoles(rows) {
  return (rows ?? []).map((row) => (
    typeof row?.metadata?.retrieval_role === "string"
      ? row.metadata.retrieval_role
      : "unknown"
  ));
}

function basePayload(accessContext) {
  return {
    auth_source: accessContext?.authSource ?? "unknown",
    brain_id: accessContext?.effectiveBrainId ?? null,
    brain_slug: accessContext?.effectiveBrainSlug ?? null,
    requested_brain_slug: accessContext?.requestedBrainSlug ?? null,
  };
}

function safeErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error ?? "unknown");
  return truncateText(collapseWhitespace(raw), 240);
}

export function appendRetrievalTelemetry({
  eventType,
  accessContext,
  queryText,
  threshold,
  requestedCount,
  retrievalStrategy,
  fallbackUsed,
  resultRows,
  graphAssisted = false,
  graphExpansion = null,
  elapsedMs,
  success,
  error = null,
  extra = {},
}) {
  if (!config.observability.retrievalTelemetry.enabled) {
    return false;
  }

  const payload = {
    ...basePayload(accessContext),
    ...queryTelemetry(queryText),
    retrieval_strategy: retrievalStrategy ?? null,
    fallback_used: typeof fallbackUsed === "boolean" ? fallbackUsed : null,
    graph_assisted: Boolean(graphAssisted),
    graph_policy_version: typeof graphExpansion?.policy_version === "number"
      ? graphExpansion.policy_version
      : null,
    graph_policy_hash: typeof graphExpansion?.policy_hash === "string"
      ? graphExpansion.policy_hash
      : null,
    graph_policy_path: typeof graphExpansion?.policy_path === "string"
      ? graphExpansion.policy_path
      : null,
    match_threshold: typeof threshold === "number" ? threshold : null,
    requested_count: Number.isFinite(requestedCount) ? Number(requestedCount) : null,
    returned_count: rowIds(resultRows).length,
    result_ids: rowIds(resultRows),
    result_retrieval_roles: rowRoles(resultRows),
    graph_added_ids: Array.isArray(graphExpansion?.added_ids)
      ? graphExpansion.added_ids.filter((value) => typeof value === "string")
      : [],
    graph_candidate_count: typeof graphExpansion?.candidate_count === "number"
      ? graphExpansion.candidate_count
      : null,
    graph_max_hops: typeof graphExpansion?.max_hops === "number"
      ? graphExpansion.max_hops
      : null,
    elapsed_ms: Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : null,
    success: Boolean(success),
  };

  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value !== undefined) {
      payload[key] = value;
    }
  }

  if (error) {
    payload.error = safeErrorMessage(error);
  }

  const record = {
    timestamp: new Date().toISOString(),
    event_type: eventType,
    payload,
  };

  try {
    appendJsonLine(config.observability.retrievalTelemetry.path, record);
    return true;
  } catch (writeError) {
    console.error(
      `[ob1-observability] failed to append retrieval telemetry: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
    );
    return false;
  }
}

export function appendPolicyRevision({
  policyPath,
  policyVersion,
  policyHash,
  policyPayload,
}) {
  if (!config.observability.policyHistory.enabled) {
    return false;
  }

  const record = {
    timestamp: new Date().toISOString(),
    event_type: "graph_retrieval_policy_revision",
    policy_hash: policyHash,
    policy_path: policyPath,
    policy_version: policyVersion,
    reason: config.observability.policyHistory.reason,
    policy: policyPayload,
  };

  try {
    const previous = readLastJsonLine(config.observability.policyHistory.path);
    if (
      previous?.event_type === record.event_type
      && previous?.policy_hash === record.policy_hash
      && previous?.policy_path === record.policy_path
    ) {
      return false;
    }

    appendJsonLine(config.observability.policyHistory.path, record);
    return true;
  } catch (writeError) {
    console.error(
      `[ob1-observability] failed to append policy revision history: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
    );
    return false;
  }
}
