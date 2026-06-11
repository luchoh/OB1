// Projection planner — the pure rule turning a Thought row into a graph plan.
//
// This module is the single home for OB1's metadata→graph transformation: the
// chat-export parsing, claim/entity extraction, and artifact-lineage logic that
// decides which Neo4j nodes and edges a Thought projects to. It is the planner
// extracted out of the 2,504-line graph.mjs (PRD docs/34, module 3).
//
// PURITY CONTRACT (the whole point of the module, mirroring access-policy.mjs):
// no config/db/pg/neo4j import, no I/O. Input is a Thought row (content,
// metadata, structured columns, deleted_at); output is a projection PLAN — plain
// data. The two adapters at this seam are the live projector (writes the plan to
// Neo4j) and the test suite (asserts on the plan directly). This is what lets the
// suite exercise projection shapes with zero infrastructure.
//
// Two things that were impure in graph.mjs are lifted into the interface so the
// transform is deterministic:
//   * `schemaVariant` — was defaulted off `config.graph.schemaVariant`; here it
//     is a parameter (default "provenance-v1", the same fallback the old code
//     used when config was unset). No config import.
//   * `projectedAt` — the edge `projected_at` stamp was `new Date().toISOString()`
//     read mid-transform. It is now an injected parameter. The live projector
//     passes `new Date().toISOString()`; tests pass a fixed literal. When omitted
//     the stamp is simply absent from edge properties (undefined values are
//     dropped), never fabricated.
//
// Tombstone rule (docs/32 D2 / M4): a row whose `deleted_at` is set yields a
// DELETION plan (detach the Thought node), not a node/edge plan; a restored row
// (deleted_at cleared) yields a full upsert plan again. The plan says WHAT; the
// projector adapter still performs the D2.4 restore-vs-projector recheck and the
// projection_state row deletion as I/O — those cannot live in a pure module.

import { createHash } from "node:crypto";

// The plan discriminator. An upsert plan carries nodes/edges; a delete plan
// carries the canonical id (and uuid) to detach from the graph.
export const PLAN_OPS = Object.freeze({
  UPSERT: "upsert",
  DELETE: "delete",
});

export const GRAPH_SCHEMA_VARIANTS = new Set([
  "provenance-v1",
  "source-first-chat-v1",
  "source-first-chat-claims-v1",
]);

const NODE_LABELS = new Set([
  "Thought",
  "Conversation",
  "Email",
  "Attachment",
  "Document",
  "DictationArtifact",
  "Message",
  "Participant",
  "AttachmentRef",
  "Person",
  "Organization",
  "Project",
  "Device",
  "Place",
  "Property",
  "Concept",
]);

const REL_TYPES = new Set([
  "DERIVED_FROM",
  "PART_OF",
  "HAS_ATTACHMENT",
  "SUMMARIZED_AS",
  "DISTILLED_TO",
  "REFERENCES_SOURCE",
  "HAS_MESSAGE",
  "AUTHORED_BY",
  "PRECEDES",
  "HAS_ATTACHMENT_REF",
  "MENTIONS",
  "ABOUT",
  "USES",
  "LOCATED_AT",
  "OWNED_BY",
  "SENT_BY",
  "ASSOCIATED_WITH",
  "RELATED_TO",
]);

// The label/relationship vocabularies are exported so the Stage-2 driver adapter
// can validate plan items at write time (the old upsertNode/upsertEdge did this).
export const GRAPH_NODE_LABELS = NODE_LABELS;
export const GRAPH_REL_TYPES = REL_TYPES;

export function normalizeGraphSchemaVariant(value = "provenance-v1") {
  const normalized = typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : "provenance-v1";
  if (!GRAPH_SCHEMA_VARIANTS.has(normalized)) {
    throw new Error(`Unsupported graph schema variant: ${value}`);
  }
  return normalized;
}

function nestedUserMetadata(row) {
  const userMetadata = row?.metadata?.user_metadata;
  return userMetadata && typeof userMetadata === "object" && !Array.isArray(userMetadata)
    ? userMetadata
    : {};
}

function prefer(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return null;
}

function isoTimestamp(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value?.toISOString === "function") {
    return value.toISOString();
  }

  return String(value);
}

function truncateText(text, limit = 240) {
  if (typeof text !== "string") {
    return "";
  }

  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit - 1)}…`;
}

// ---------------------------------------------------------------------------
// Canonical-id helpers (consolidation target for Stage 2: retrieval.mjs and
// graph.mjs each carry a copy of the thought:<uuid> parse).
// ---------------------------------------------------------------------------

export const THOUGHT_CANONICAL_PREFIX = "thought:";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function canonicalThoughtId(row) {
  return `${THOUGHT_CANONICAL_PREFIX}${row.id}`;
}

// Extract a lowercase uuid from a `thought:<uuid>` canonical id, or null when the
// id is not a thought node or the uuid is malformed.
export function thoughtUuidFromCanonicalId(canonicalId) {
  if (typeof canonicalId !== "string" || !canonicalId.startsWith(THOUGHT_CANONICAL_PREFIX)) {
    return null;
  }
  const uuid = canonicalId.slice(THOUGHT_CANONICAL_PREFIX.length);
  return UUID_PATTERN.test(uuid) ? uuid.toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// Plan store: in-memory node/edge accumulators keyed for idempotent merging.
// ---------------------------------------------------------------------------

function nodeKey(label, canonicalId) {
  return `${label}:${canonicalId}`;
}

function edgeKey(fromLabel, fromId, type, toLabel, toId) {
  return `${fromLabel}:${fromId}:${type}:${toLabel}:${toId}`;
}

function addNode(store, label, canonicalId, properties) {
  if (!canonicalId) {
    return;
  }

  const key = nodeKey(label, canonicalId);
  const existing = store.get(key) ?? { label, canonicalId, properties: {} };
  existing.properties = {
    ...existing.properties,
    ...Object.fromEntries(
      Object.entries(properties).filter(([, value]) => value !== undefined),
    ),
  };
  store.set(key, existing);
}

function addEdge(store, fromLabel, fromId, type, toLabel, toId, properties) {
  if (!fromId || !toId) {
    return;
  }

  const key = edgeKey(fromLabel, fromId, type, toLabel, toId);
  const existing = store.get(key) ?? {
    fromLabel,
    fromId,
    type,
    toLabel,
    toId,
    properties: {},
  };
  existing.properties = {
    ...existing.properties,
    ...Object.fromEntries(
      Object.entries(properties).filter(([, value]) => value !== undefined),
    ),
  };
  store.set(key, existing);
}

function thoughtTitle(metadata, userMetadata) {
  return prefer(
    userMetadata.chatgpt_title,
    userMetadata.claude_title,
    metadata.subject,
    userMetadata.email_subject,
    userMetadata.subject,
    metadata.document_filename,
    userMetadata.document_filename,
  );
}

function buildBaseEdgeProps(row, projectedAt) {
  return {
    extraction_method: "metadata",
    confidence: 1,
    source_thought_id: row.id,
    source_type: row.metadata?.type ?? null,
    projected_at: projectedAt,
  };
}

function timestampToIso(value) {
  if (value === undefined || value === null || value === "" || value === 0) {
    return null;
  }

  if (typeof value === "number") {
    const numeric = value > 10_000_000_000 ? value / 1000 : value;
    const date = new Date(numeric * 1000);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (/^\d+$/.test(trimmed)) {
      return timestampToIso(Number(trimmed));
    }
    const candidate = trimmed.endsWith("Z")
      ? trimmed.slice(0, -1) + "+00:00"
      : trimmed;
    const parsed = new Date(candidate.includes("T") ? candidate : candidate.replace(" ", "T"));
    return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
  }

  return null;
}

function normalizeChatRole(value) {
  if (!value) {
    return null;
  }
  const lowered = String(value).trim().toLowerCase();
  if (["human", "user", "customer"].includes(lowered)) {
    return "user";
  }
  if (["assistant", "claude", "model", "ai"].includes(lowered)) {
    return "assistant";
  }
  return lowered || null;
}

function stableHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseRawExportJson(userMetadata) {
  const raw = prefer(userMetadata.raw_export_json);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function flattenText(value, fragments = []) {
  if (typeof value === "string") {
    const text = value.trim();
    if (text) {
      fragments.push(text);
    }
    return fragments;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      flattenText(item, fragments);
    }
    return fragments;
  }

  if (value && typeof value === "object") {
    for (const key of ["text", "content", "value", "body", "message", "completion", "caption"]) {
      if (key in value) {
        flattenText(value[key], fragments);
      }
    }
  }

  return fragments;
}

function dedupeStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function conversationAnchor(userMetadata, platform) {
  if (platform === "chatgpt") {
    return {
      conversationId: prefer(userMetadata.chatgpt_conversation_id),
      conversationHash: prefer(userMetadata.chatgpt_conversation_hash),
      title: prefer(userMetadata.chatgpt_title),
      createdAt: prefer(userMetadata.chatgpt_create_time),
    };
  }
  if (platform === "claude") {
    return {
      conversationId: prefer(userMetadata.claude_conversation_id),
      conversationHash: prefer(userMetadata.claude_conversation_hash),
      title: prefer(userMetadata.claude_title),
      createdAt: prefer(userMetadata.claude_create_time),
    };
  }
  return {
    conversationId: null,
    conversationHash: null,
    title: null,
    createdAt: null,
  };
}

function conversationCanonicalIdFor(platform, userMetadata) {
  const anchor = conversationAnchor(userMetadata, platform);
  const identifier = anchor.conversationId ?? anchor.conversationHash;
  return identifier ? `conversation:${platform}:${identifier}` : null;
}

function chatgptWalkMessages(mapping) {
  if (!mapping || typeof mapping !== "object") {
    return [];
  }

  const roots = [];
  for (const [nodeId, node] of Object.entries(mapping)) {
    const parent = node?.parent;
    if (parent === null || parent === undefined || !(parent in mapping)) {
      roots.push(nodeId);
    }
  }

  const messages = [];
  const visited = new Set();

  const walk = (nodeId) => {
    if (visited.has(nodeId) || !mapping[nodeId]) {
      return;
    }
    visited.add(nodeId);
    const node = mapping[nodeId];
    const message = node?.message;
    if (message && message.content) {
      messages.push(message);
    }
    for (const childId of node?.children ?? []) {
      walk(childId);
    }
  };

  for (const rootId of roots) {
    walk(rootId);
  }

  return messages;
}

function chatgptAttachmentRefs(message) {
  const attachments = [];
  for (const item of message?.metadata?.attachments ?? []) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const filename = prefer(item.name, item.filename, item.file_name, item.id);
    if (!filename) {
      continue;
    }
    attachments.push({
      refId: prefer(item.id, item.file_id, filename),
      filename,
      contentType: prefer(item.mime_type, item.content_type, item.type),
      sizeBytes: prefer(item.size_bytes, item.size),
    });
  }
  return attachments;
}

function chatgptMessageText(message) {
  const content = message?.content ?? {};
  const contentType = content?.content_type;

  if (contentType === "user_editable_context") {
    return "";
  }

  const fragments = [];
  if ([
    "text",
    "code",
    "execution_output",
    "computer_output",
    "system_error",
    "tether_browsing_display",
    "tether_quote",
  ].includes(contentType)) {
    for (const part of content.parts ?? []) {
      if (typeof part === "string" && part.trim()) {
        fragments.push(part.trim());
      }
    }
  } else if (contentType === "multimodal_text") {
    const attachmentNames = chatgptAttachmentRefs(message).map((item) => item.filename);
    if (attachmentNames.length > 0) {
      fragments.push(`Attachments: ${attachmentNames.join(", ")}`);
    }
    for (const part of content.parts ?? []) {
      if (typeof part === "string" && part.trim()) {
        fragments.push(part.trim());
      }
    }
  }

  return fragments.join("\n").trim();
}

function chatgptStructuredMessages(rawConversation) {
  const messages = chatgptWalkMessages(rawConversation?.mapping ?? {});
  return messages.map((message, index) => {
    const attachments = chatgptAttachmentRefs(message);
    const role = normalizeChatRole(message?.author?.role);
    return {
      canonicalKey: prefer(message?.id, `ordinal-${index + 1}`),
      role,
      createdAt: timestampToIso(message?.create_time),
      updatedAt: timestampToIso(message?.update_time),
      content: chatgptMessageText(message),
      attachments,
    };
  }).filter((message) => message.content || message.attachments.length > 0);
}

function claudeAttachmentRefs(message) {
  const attachments = [];
  for (const key of ["attachments", "files", "file_references"]) {
    const values = message?.[key];
    if (!Array.isArray(values)) {
      continue;
    }
    for (const item of values) {
      if (typeof item === "string") {
        const filename = item.trim();
        if (!filename) {
          continue;
        }
        attachments.push({
          refId: filename,
          filename,
          contentType: null,
          sizeBytes: null,
        });
        continue;
      }
      if (!item || typeof item !== "object") {
        continue;
      }
      const filename = prefer(item.file_name, item.filename, item.name, item.title, item.id);
      if (!filename) {
        continue;
      }
      attachments.push({
        refId: prefer(item.id, item.file_id, filename),
        filename,
        contentType: prefer(item.mime_type, item.content_type, item.type),
        sizeBytes: prefer(item.size_bytes, item.size),
      });
    }
  }
  return attachments;
}

function claudeMessageSortValue(message) {
  for (const key of ["created_at", "createdAt", "updated_at", "updatedAt", "timestamp"]) {
    const iso = timestampToIso(message?.[key]);
    if (iso) {
      return Date.parse(iso);
    }
  }
  return Number.POSITIVE_INFINITY;
}

function claudeExtractMessages(rawConversation) {
  const direct = Array.isArray(rawConversation?.chat_messages)
    ? rawConversation.chat_messages
    : Array.isArray(rawConversation?.messages)
      ? rawConversation.messages
      : null;
  const nestedConversation = rawConversation?.conversation;
  const nested = Array.isArray(nestedConversation?.chat_messages)
    ? nestedConversation.chat_messages
    : Array.isArray(nestedConversation?.messages)
      ? nestedConversation.messages
      : null;
  const messages = (direct ?? nested ?? []).filter((message) => message && typeof message === "object");
  return [...messages].sort((left, right) => claudeMessageSortValue(left) - claudeMessageSortValue(right));
}

function claudeMessageRole(message) {
  return normalizeChatRole(
    prefer(
      message?.sender,
      message?.role,
      typeof message?.author === "object" ? message.author?.role : message?.author,
      message?.from,
    ),
  );
}

function claudeMessageText(message) {
  const fragments = [];
  const attachmentNames = claudeAttachmentRefs(message).map((item) => item.filename);
  if (attachmentNames.length > 0) {
    fragments.push(`Attachments: ${attachmentNames.join(", ")}`);
  }
  for (const key of ["text", "content", "message", "body", "completion"]) {
    if (key in (message ?? {})) {
      fragments.push(...flattenText(message[key]));
    }
  }
  return dedupeStrings(fragments).join("\n").trim();
}

function claudeStructuredMessages(rawConversation) {
  return claudeExtractMessages(rawConversation).map((message, index) => {
    const attachments = claudeAttachmentRefs(message);
    return {
      canonicalKey: prefer(message?.uuid, message?.id, `ordinal-${index + 1}`),
      role: claudeMessageRole(message),
      createdAt: timestampToIso(
        prefer(
          message?.created_at,
          message?.createdAt,
          message?.updated_at,
          message?.updatedAt,
          message?.timestamp,
        ),
      ),
      updatedAt: timestampToIso(prefer(message?.updated_at, message?.updatedAt)),
      content: claudeMessageText(message),
      attachments,
    };
  }).filter((message) => message.content || message.attachments.length > 0);
}

function messageCanonicalId(platform, conversationIdentifier, messageKey) {
  return `message:${platform}:${conversationIdentifier}:${messageKey}`;
}

function participantCanonicalId(platform, conversationIdentifier, role) {
  return `participant:${platform}:${conversationIdentifier}:${role ?? "unknown"}`;
}

function attachmentRefCanonicalId(platform, conversationIdentifier, messageKey, attachment) {
  const raw = stableHash(
    JSON.stringify({
      platform,
      conversationIdentifier,
      messageKey,
      refId: attachment.refId ?? null,
      filename: attachment.filename ?? null,
      contentType: attachment.contentType ?? null,
    }),
  ).slice(0, 16);
  return `attachment_ref:${platform}:${conversationIdentifier}:${raw}`;
}

function schemaIncludesRawChatStructure(schemaVariant) {
  const normalized = normalizeGraphSchemaVariant(schemaVariant);
  return normalized === "source-first-chat-v1" || normalized === "source-first-chat-claims-v1";
}

function schemaIncludesClaimEntities(schemaVariant) {
  return normalizeGraphSchemaVariant(schemaVariant) === "source-first-chat-claims-v1";
}

function rawChatConversationProjection(store, row, metadata, userMetadata, baseEdgeProps, schemaVariant) {
  if (!schemaIncludesRawChatStructure(schemaVariant)) {
    return;
  }

  const type = metadata.type ?? null;
  if (!["chatgpt_conversation_record", "claude_conversation_record"].includes(type)) {
    return;
  }

  const platform = metadata.source ?? (type.startsWith("claude") ? "claude" : "chatgpt");
  const anchor = conversationAnchor(userMetadata, platform);
  const conversationIdentifier = anchor.conversationId ?? anchor.conversationHash;
  const conversationCanonicalId = conversationCanonicalIdFor(platform, userMetadata);
  if (!conversationIdentifier || !conversationCanonicalId) {
    return;
  }

  const rawConversation = parseRawExportJson(userMetadata);
  if (!rawConversation) {
    return;
  }

  const messages = platform === "claude"
    ? claudeStructuredMessages(rawConversation)
    : chatgptStructuredMessages(rawConversation);
  if (messages.length === 0) {
    return;
  }

  const thoughtId = canonicalThoughtId(row);
  let previousMessageId = null;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const messageId = messageCanonicalId(platform, conversationIdentifier, message.canonicalKey);
    addNode(store.nodes, "Message", messageId, {
      canonical_id: messageId,
      source_system: platform,
      source_type: "message",
      platform,
      conversation_id: anchor.conversationId ?? null,
      conversation_hash: anchor.conversationHash ?? null,
      message_key: message.canonicalKey,
      ordinal: index + 1,
      role: message.role ?? null,
      attachment_count: message.attachments.length,
      content_preview: truncateText(message.content, 420),
      created_at: message.createdAt ?? anchor.createdAt ?? null,
      updated_at: message.updatedAt ?? isoTimestamp(row.updated_at),
    });
    addEdge(store.edges, "Conversation", conversationCanonicalId, "HAS_MESSAGE", "Message", messageId, baseEdgeProps);
    addEdge(store.edges, "Thought", thoughtId, "REFERENCES_SOURCE", "Message", messageId, baseEdgeProps);

    const participantId = participantCanonicalId(platform, conversationIdentifier, message.role);
    addNode(store.nodes, "Participant", participantId, {
      canonical_id: participantId,
      source_system: platform,
      source_type: "participant",
      platform,
      conversation_id: anchor.conversationId ?? null,
      conversation_hash: anchor.conversationHash ?? null,
      role: message.role ?? null,
      created_at: anchor.createdAt ?? isoTimestamp(row.created_at),
      updated_at: isoTimestamp(row.updated_at),
    });
    addEdge(store.edges, "Message", messageId, "AUTHORED_BY", "Participant", participantId, baseEdgeProps);

    if (previousMessageId) {
      addEdge(store.edges, "Message", previousMessageId, "PRECEDES", "Message", messageId, baseEdgeProps);
    }
    previousMessageId = messageId;

    for (const attachment of message.attachments) {
      const attachmentId = attachmentRefCanonicalId(platform, conversationIdentifier, message.canonicalKey, attachment);
      addNode(store.nodes, "AttachmentRef", attachmentId, {
        canonical_id: attachmentId,
        source_system: platform,
        source_type: "attachment_ref",
        platform,
        conversation_id: anchor.conversationId ?? null,
        conversation_hash: anchor.conversationHash ?? null,
        message_key: message.canonicalKey,
        ref_id: attachment.refId ?? null,
        filename: attachment.filename ?? null,
        content_type: attachment.contentType ?? null,
        size_bytes: attachment.sizeBytes ?? null,
        created_at: message.createdAt ?? anchor.createdAt ?? null,
        updated_at: isoTimestamp(row.updated_at),
      });
      addEdge(store.edges, "Message", messageId, "HAS_ATTACHMENT_REF", "AttachmentRef", attachmentId, baseEdgeProps);
    }
  }
}

function normalizedEntityName(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function entityCanonicalId(label, name) {
  const normalized = normalizedEntityName(name);
  if (!normalized) {
    return null;
  }
  return `${label.toLowerCase()}:${stableHash(`${label}:${normalized.toLowerCase()}`).slice(0, 20)}`;
}

function claimStrengthConfidence(strength) {
  const normalized = typeof strength === "string" ? strength.trim().toLowerCase() : "";
  if (normalized === "strong") {
    return 0.95;
  }
  if (normalized === "weak") {
    return 0.72;
  }
  return 0.85;
}

function ensureArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null || value === "") {
    return [];
  }
  return [value];
}

function preferredEntityRelationship(claimKind, claimObject) {
  if (!claimObject) {
    return null;
  }

  const normalized = typeof claimKind === "string" ? claimKind.trim().toLowerCase() : "";
  if (["decision", "preference", "implementation_detail", "plan"].includes(normalized)) {
    return "USES";
  }
  if (["comparison", "option", "constraint", "diagnosis", "fact"].includes(normalized)) {
    return "RELATED_TO";
  }
  return "RELATED_TO";
}

function scopeKeyEntityLabel(key) {
  const normalized = typeof key === "string" ? key.trim().toLowerCase() : "";
  if (!normalized) {
    return null;
  }

  if (["project", "projects"].includes(normalized)) {
    return "Project";
  }

  if ([
    "device",
    "devices",
    "current_device",
    "reference_device",
    "target_device",
    "device_type",
    "motherboard",
    "camera",
    "amplifier",
    "headphones",
    "dac_options",
  ].includes(normalized)) {
    return "Device";
  }

  if ([
    "location",
    "locations",
    "region",
    "country",
    "city",
    "address",
    "home_location",
    "office_location",
    "airport",
    "location_preference",
    "room",
    "area",
  ].includes(normalized)) {
    return "Place";
  }

  if ([
    "company",
    "companies",
    "provider",
    "providers",
    "vendor",
    "brand",
    "brands",
    "agency",
    "designer",
  ].includes(normalized)) {
    return "Organization";
  }

  if ([
    "system",
    "systems",
    "platform",
    "service",
    "services",
    "tool",
    "tools",
    "application",
    "software",
    "database",
    "model",
    "models",
    "package",
    "packages",
    "library",
    "libraries",
    "framework",
    "frameworks",
    "component",
    "components",
    "module",
    "modules",
    "hardware",
    "protocol",
    "protocols",
    "feature",
    "features",
    "product",
    "products",
    "service_name",
    "source_system",
    "platforms",
    "ecosystem",
    "api",
    "endpoint",
    "endpoints",
    "api_endpoint",
    "package_manager",
    "package_managers",
    "shell",
    "language",
    "languages",
    "os",
    "interface",
    "network",
    "networks",
    "vlan",
    "vlans",
    "route",
    "filesystem",
    "format",
    "file_format",
    "file_type",
    "file_types",
    "query_type",
    "method",
    "methods",
    "function",
    "functions",
    "workflow",
    "architecture",
  ].includes(normalized)) {
    return "Concept";
  }

  return null;
}

function addEntityNode(store, label, canonicalId, properties) {
  addNode(store, label, canonicalId, {
    entity_type: label,
    ...properties,
  });
}

// `metadata` is unused (claim fields live under user_metadata) but kept positional
// to match the other projection helpers' (store, row, metadata, userMetadata, ...) shape.
function addClaimEntityProjection(store, row, _metadata, userMetadata, baseEdgeProps, schemaVariant) {
  if (!schemaIncludesClaimEntities(schemaVariant)) {
    return;
  }

  const thoughtId = canonicalThoughtId(row);
  const claimKind = prefer(userMetadata.claim_kind);
  const claimSubject = normalizedEntityName(userMetadata.claim_subject);
  const claimObject = normalizedEntityName(userMetadata.claim_object);
  const claimStrength = prefer(userMetadata.claim_strength);
  const confidence = claimStrengthConfidence(claimStrength);
  const evidenceText = truncateText(row.content, 280);
  const claimScope = userMetadata.claim_scope;
  const entityBaseProps = {
    extraction_method: "claim_metadata",
    confidence,
    evidence_text: evidenceText,
    created_at: isoTimestamp(row.created_at),
    updated_at: isoTimestamp(row.updated_at),
  };
  const edgeBaseProps = {
    ...baseEdgeProps,
    extraction_method: "claim_metadata",
    confidence,
    evidence_text: evidenceText,
    claim_kind: claimKind ?? null,
  };

  if (claimSubject) {
    const canonicalId = entityCanonicalId("Concept", claimSubject);
    addEntityNode(store.nodes, "Concept", canonicalId, {
      canonical_id: canonicalId,
      canonical_name: claimSubject,
      normalized_name: claimSubject.toLowerCase(),
      ...entityBaseProps,
    });
    addEdge(store.edges, "Thought", thoughtId, "ABOUT", "Concept", canonicalId, edgeBaseProps);
  }

  if (claimObject) {
    const canonicalId = entityCanonicalId("Concept", claimObject);
    addEntityNode(store.nodes, "Concept", canonicalId, {
      canonical_id: canonicalId,
      canonical_name: claimObject,
      normalized_name: claimObject.toLowerCase(),
      ...entityBaseProps,
    });
    const relationship = preferredEntityRelationship(claimKind, claimObject) ?? "RELATED_TO";
    addEdge(store.edges, "Thought", thoughtId, relationship, "Concept", canonicalId, edgeBaseProps);
  }

  if (!claimScope || typeof claimScope !== "object" || Array.isArray(claimScope)) {
    return;
  }

  for (const [scopeKey, rawValues] of Object.entries(claimScope)) {
    const label = scopeKeyEntityLabel(scopeKey);
    if (!label) {
      continue;
    }

    for (const rawValue of ensureArray(rawValues)) {
      const value = normalizedEntityName(typeof rawValue === "string" ? rawValue : String(rawValue ?? ""));
      if (!value) {
        continue;
      }

      const canonicalId = entityCanonicalId(label, value);
      addEntityNode(store.nodes, label, canonicalId, {
        canonical_id: canonicalId,
        canonical_name: value,
        normalized_name: value.toLowerCase(),
        source_scope_key: scopeKey,
        ...entityBaseProps,
      });

      const relationship = label === "Place"
        ? "LOCATED_AT"
        : label === "Concept"
          ? "MENTIONS"
          : "ASSOCIATED_WITH";

      addEdge(store.edges, "Thought", thoughtId, relationship, label, canonicalId, {
        ...edgeBaseProps,
        source_scope_key: scopeKey,
      });
    }
  }
}

function conversationProjection(store, row, metadata, userMetadata, baseEdgeProps) {
  const chatgptHash = prefer(userMetadata.chatgpt_conversation_hash);
  const chatgptId = prefer(userMetadata.chatgpt_conversation_id);
  const claudeHash = prefer(userMetadata.claude_conversation_hash);
  const claudeId = prefer(userMetadata.claude_conversation_id);
  const thoughtId = canonicalThoughtId(row);
  const retrievalRole = metadata.retrieval_role ?? null;

  if (chatgptHash || chatgptId) {
    const canonicalId = `conversation:chatgpt:${chatgptId ?? chatgptHash}`;
    addNode(store.nodes, "Conversation", canonicalId, {
      canonical_id: canonicalId,
      source_system: "chatgpt",
      source_type: "conversation",
      platform: "chatgpt",
      external_id: chatgptId ?? null,
      conversation_hash: chatgptHash ?? null,
      title: userMetadata.chatgpt_title ?? metadata.summary ?? null,
      created_at: userMetadata.chatgpt_create_time ?? metadata.occurred_at ?? null,
      updated_at: isoTimestamp(row.updated_at),
    });
    const linkType = retrievalRole === "source" ? "REFERENCES_SOURCE" : "DERIVED_FROM";
    addEdge(store.edges, "Thought", thoughtId, linkType, "Conversation", canonicalId, baseEdgeProps);
    if (linkType === "DERIVED_FROM") {
      addEdge(store.edges, "Conversation", canonicalId, "DISTILLED_TO", "Thought", thoughtId, baseEdgeProps);
    }
  }

  if (claudeHash || claudeId) {
    const canonicalId = `conversation:claude:${claudeId ?? claudeHash}`;
    addNode(store.nodes, "Conversation", canonicalId, {
      canonical_id: canonicalId,
      source_system: "claude",
      source_type: "conversation",
      platform: "claude",
      external_id: claudeId ?? null,
      conversation_hash: claudeHash ?? null,
      title: userMetadata.claude_title ?? metadata.summary ?? null,
      created_at: userMetadata.claude_create_time ?? metadata.occurred_at ?? null,
      updated_at: isoTimestamp(row.updated_at),
    });
    const linkType = retrievalRole === "source" ? "REFERENCES_SOURCE" : "DERIVED_FROM";
    addEdge(store.edges, "Thought", thoughtId, linkType, "Conversation", canonicalId, baseEdgeProps);
    if (linkType === "DERIVED_FROM") {
      addEdge(store.edges, "Conversation", canonicalId, "DISTILLED_TO", "Thought", thoughtId, baseEdgeProps);
    }
  }
}

function emailCanonicalId(row, metadata, userMetadata) {
  const explicit = prefer(userMetadata.email_dedupe_key);
  if (explicit) {
    return `email:${explicit}`;
  }
  if ((metadata.source ?? null) === "imap" && metadata.type === "email") {
    return `email:${row.dedupe_key}`;
  }
  return null;
}

function attachmentCanonicalId(emailId, metadata, userMetadata) {
  const attachmentSha = prefer(userMetadata.attachment_sha256, metadata.attachment_sha256);
  if (!emailId || !attachmentSha) {
    return null;
  }
  return `attachment:${emailId.slice("email:".length)}:${attachmentSha}`;
}

function documentCanonicalId(metadata, userMetadata) {
  const sha = prefer(userMetadata.document_sha256, metadata.document_sha256);
  if (sha) {
    return `document:${sha}`;
  }

  const path = prefer(userMetadata.document_path, metadata.document_path);
  return path ? `document_path:${path}` : null;
}

function dictationCanonicalId(row, metadata, userMetadata) {
  const artifactId = prefer(userMetadata.artifact_id, metadata.artifact_id);
  if (artifactId) {
    return `dictation:${artifactId}`;
  }

  const audioSha = prefer(userMetadata.audio_sha256, metadata.audio_sha256);
  if (audioSha) {
    return `dictation_audio:${audioSha}`;
  }

  if ((metadata.source ?? null) === "dictation") {
    return `dictation:${row.dedupe_key}`;
  }

  return null;
}

function artifactProjection(store, row, metadata, userMetadata, baseEdgeProps) {
  const thoughtId = canonicalThoughtId(row);
  const type = metadata.type ?? null;
  const retrievalRole = metadata.retrieval_role ?? null;
  const emailId = emailCanonicalId(row, metadata, userMetadata);
  const attachmentId = attachmentCanonicalId(emailId, metadata, userMetadata);
  const documentId = documentCanonicalId(metadata, userMetadata);
  const dictationId = dictationCanonicalId(row, metadata, userMetadata);

  if (emailId) {
    addNode(store.nodes, "Email", emailId, {
      canonical_id: emailId,
      source_system: "imap",
      source_type: "email",
      title: prefer(metadata.subject, userMetadata.email_subject, userMetadata.subject),
      sender: prefer(metadata.sender, userMetadata.email_sender, userMetadata.sender),
      sender_name: prefer(metadata.sender_name, userMetadata.sender_name),
      mailbox: prefer(metadata.mailbox, userMetadata.mailbox),
      occurred_at: prefer(metadata.date, metadata.occurred_at, userMetadata.occurred_at),
      imap_uid: prefer(metadata.imap_uid, userMetadata.imap_uid),
      created_at: isoTimestamp(row.created_at),
      updated_at: isoTimestamp(row.updated_at),
    });

    const emailLink = type === "email_thought" ? "DERIVED_FROM" : "REFERENCES_SOURCE";
    addEdge(store.edges, "Thought", thoughtId, emailLink, "Email", emailId, baseEdgeProps);
    if (emailLink === "DERIVED_FROM") {
      addEdge(store.edges, "Email", emailId, "DISTILLED_TO", "Thought", thoughtId, baseEdgeProps);
    }
  }

  if (attachmentId) {
    addNode(store.nodes, "Attachment", attachmentId, {
      canonical_id: attachmentId,
      source_system: "imap_attachment",
      source_type: "attachment",
      title: prefer(userMetadata.attachment_filename, metadata.attachment_filename),
      filename: prefer(userMetadata.attachment_filename, metadata.attachment_filename),
      content_type: prefer(userMetadata.attachment_content_type, metadata.attachment_content_type),
      size_bytes: prefer(userMetadata.attachment_size_bytes, metadata.attachment_size_bytes),
      attachment_sha256: prefer(userMetadata.attachment_sha256, metadata.attachment_sha256),
      email_canonical_id: emailId,
      created_at: isoTimestamp(row.created_at),
      updated_at: isoTimestamp(row.updated_at),
    });

    if (emailId) {
      addEdge(store.edges, "Email", emailId, "HAS_ATTACHMENT", "Attachment", attachmentId, baseEdgeProps);
    }
  }

  if (documentId) {
    addNode(store.nodes, "Document", documentId, {
      canonical_id: documentId,
      source_system: prefer(metadata.source, "document"),
      source_type: "document",
      title: prefer(userMetadata.document_filename, metadata.document_filename),
      filename: prefer(userMetadata.document_filename, metadata.document_filename),
      document_path: prefer(userMetadata.document_path, metadata.document_path),
      document_sha256: prefer(userMetadata.document_sha256, metadata.document_sha256),
      mimetype: prefer(userMetadata.document_mimetype, metadata.document_mimetype),
      size_bytes: prefer(userMetadata.document_size_bytes, metadata.document_size_bytes),
      created_at: isoTimestamp(row.created_at),
      updated_at: isoTimestamp(row.updated_at),
    });

    if (attachmentId) {
      addEdge(store.edges, "Attachment", attachmentId, "REFERENCES_SOURCE", "Document", documentId, baseEdgeProps);
    }
  }

  if (dictationId) {
    addNode(store.nodes, "DictationArtifact", dictationId, {
      canonical_id: dictationId,
      source_system: "dictation",
      source_type: "dictation_artifact",
      title: prefer(metadata.title, userMetadata.title, thoughtTitle(metadata, userMetadata)),
      artifact_id: prefer(userMetadata.artifact_id, metadata.artifact_id),
      audio_sha256: prefer(userMetadata.audio_sha256, metadata.audio_sha256),
      source_host: prefer(userMetadata.source_host, metadata.source_host),
      created_at: prefer(metadata.occurred_at, userMetadata.created_at, isoTimestamp(row.created_at)),
      updated_at: isoTimestamp(row.updated_at),
    });

    const dictationLink = retrievalRole === "source" ? "REFERENCES_SOURCE" : "DERIVED_FROM";
    addEdge(store.edges, "Thought", thoughtId, dictationLink, "DictationArtifact", dictationId, baseEdgeProps);
    if (dictationLink === "DERIVED_FROM") {
      addEdge(store.edges, "DictationArtifact", dictationId, "DISTILLED_TO", "Thought", thoughtId, baseEdgeProps);
    }
  }

  if (documentId) {
    if (type === "document_chunk") {
      if (attachmentId) {
        addEdge(store.edges, "Thought", thoughtId, "PART_OF", "Attachment", attachmentId, baseEdgeProps);
      } else {
        addEdge(store.edges, "Thought", thoughtId, "PART_OF", "Document", documentId, baseEdgeProps);
      }
      addEdge(store.edges, "Thought", thoughtId, "REFERENCES_SOURCE", "Document", documentId, baseEdgeProps);
    }

    if (type === "document_summary") {
      if (attachmentId) {
        addEdge(store.edges, "Thought", thoughtId, "DERIVED_FROM", "Attachment", attachmentId, baseEdgeProps);
        addEdge(store.edges, "Attachment", attachmentId, "DISTILLED_TO", "Thought", thoughtId, baseEdgeProps);
      } else {
        addEdge(store.edges, "Thought", thoughtId, "DERIVED_FROM", "Document", documentId, baseEdgeProps);
      }
      addEdge(store.edges, "Document", documentId, "SUMMARIZED_AS", "Thought", thoughtId, baseEdgeProps);
      addEdge(store.edges, "Document", documentId, "DISTILLED_TO", "Thought", thoughtId, baseEdgeProps);
    }
  }
}

// Build the node/edge plan for a LIVE thought row. Mirrors graph.mjs's
// buildProjectionPlan verbatim, minus the config/Date couplings now injected.
function buildUpsertPlan(row, schemaVariant, projectedAt) {
  const metadata = row.metadata ?? {};
  const userMetadata = nestedUserMetadata(row);
  const title = thoughtTitle(metadata, userMetadata);
  const sourceType = metadata.type ?? null;
  const sourceSystem = metadata.source ?? null;
  const thoughtId = canonicalThoughtId(row);
  const store = {
    nodes: new Map(),
    edges: new Map(),
  };

  addNode(store.nodes, "Thought", thoughtId, {
    canonical_id: thoughtId,
    thought_id: row.id,
    dedupe_key: row.dedupe_key,
    content_hash: row.content_hash,
    source_system: sourceSystem,
    source_type: sourceType,
    retrieval_role: metadata.retrieval_role ?? null,
    title,
    summary: metadata.summary ?? truncateText(row.content, 280),
    content_preview: truncateText(row.content, 420),
    created_at: isoTimestamp(row.created_at),
    updated_at: isoTimestamp(row.updated_at),
  });

  const baseEdgeProps = buildBaseEdgeProps(row, projectedAt);
  conversationProjection(store, row, metadata, userMetadata, baseEdgeProps);
  artifactProjection(store, row, metadata, userMetadata, baseEdgeProps);
  rawChatConversationProjection(store, row, metadata, userMetadata, baseEdgeProps, schemaVariant);
  addClaimEntityProjection(store, row, metadata, userMetadata, baseEdgeProps, schemaVariant);

  return {
    nodes: [...store.nodes.values()],
    edges: [...store.edges.values()],
  };
}

// ---------------------------------------------------------------------------
// The interface: a Thought row in, a projection plan out.
// ---------------------------------------------------------------------------

// planProjection(row, { schemaVariant, projectedAt }) -> plan
//
//   { op: 'delete', canonicalId, thoughtId }                         // tombstone
//   { op: 'upsert', canonicalId, thoughtId, nodes: [...], edges: [...] }
//
// A row with `deleted_at` set yields a DELETE plan (docs/32 D2): the projector
// detaches the Thought node and drops its projection_state row. A live row (or a
// restored row, deleted_at cleared) yields a full UPSERT plan — restore therefore
// re-projects by construction (M4). `nodes`/`edges` are plain objects:
//   node: { label, canonicalId, properties }
//   edge: { fromLabel, fromId, type, toLabel, toId, properties }
export function planProjection(row, { schemaVariant = "provenance-v1", projectedAt } = {}) {
  if (!row || typeof row !== "object" || row.id === undefined || row.id === null) {
    throw new Error("planProjection requires a thought row with an id");
  }

  const canonicalId = canonicalThoughtId(row);
  const thoughtId = row.id;

  if (row.deleted_at) {
    return { op: PLAN_OPS.DELETE, canonicalId, thoughtId };
  }

  const { nodes, edges } = buildUpsertPlan(row, schemaVariant, projectedAt);
  return { op: PLAN_OPS.UPSERT, canonicalId, thoughtId, nodes, edges };
}
