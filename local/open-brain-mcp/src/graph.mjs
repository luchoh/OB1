import { createHash } from "node:crypto";
import neo4j from "neo4j-driver";
import { config } from "./config.mjs";
import { query } from "./db.mjs";

export const GRAPH_SCHEMA_VARIANTS = new Set([
  "provenance-v1",
  "source-first-chat-v1",
  "source-first-chat-claims-v1",
]);

const GRAPH_PROJECTION_REVISION = "graph-projection-v4";

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

let driver;
let ensuredDatabases = new Set();
let ensuredSchemas = new Set();
let projectorTimer = null;
let projectorRunning = false;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function graphEnabled() {
  return config.graph?.enabled === true;
}

function normalizeGraphSchemaVariant(value = config.graph.schemaVariant) {
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

function cypherIdentifier(value, kind = "identifier") {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid ${kind}: ${value}`);
  }
  return `\`${value}\``;
}

function cypherDatabaseName(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(value)) {
    throw new Error(`Invalid database name: ${value}`);
  }
  return `\`${value}\``;
}

function validateLabel(label) {
  if (!NODE_LABELS.has(label)) {
    throw new Error(`Unsupported graph label: ${label}`);
  }
  return cypherIdentifier(label, "label");
}

function validateRelationship(type) {
  if (!REL_TYPES.has(type)) {
    throw new Error(`Unsupported graph relationship: ${type}`);
  }
  return cypherIdentifier(type, "relationship");
}

function graphDriver() {
  if (!graphEnabled()) {
    throw new Error("Graph integration is disabled");
  }

  if (!driver) {
    driver = neo4j.driver(
      config.graph.uri,
      neo4j.auth.basic(config.graph.username, config.graph.password),
      {
        disableLosslessIntegers: true,
      },
    );
  }

  return driver;
}

async function runGraph(statement, parameters = {}, { database = config.graph.database, mode = "WRITE" } = {}) {
  const session = graphDriver().session({
    database,
    defaultAccessMode: mode === "READ" ? neo4j.session.READ : neo4j.session.WRITE,
  });

  try {
    return await session.run(statement, parameters);
  } finally {
    await session.close();
  }
}

async function writeGraph(work, database = config.graph.database) {
  const session = graphDriver().session({
    database,
    defaultAccessMode: neo4j.session.WRITE,
  });

  try {
    return await session.executeWrite(work);
  } finally {
    await session.close();
  }
}

export async function closeGraph() {
  if (driver) {
    const active = driver;
    driver = undefined;
    ensuredDatabases = new Set();
    ensuredSchemas = new Set();
    await active.close();
  }
}

export async function healthcheckGraph() {
  if (!graphEnabled()) {
    return { enabled: false };
  }

  await ensureGraphDatabaseExists(config.graph.database);
  await ensureGraphSchema(config.graph.database);
  await runGraph("RETURN 1 AS ok", {}, { mode: "READ" });
  return {
    enabled: true,
    database: config.graph.database,
    uri: config.graph.uri,
    schema_variant: normalizeGraphSchemaVariant(config.graph.schemaVariant),
  };
}

export async function ensureGraphDatabaseExists(database = config.graph.database) {
  if (!graphEnabled()) {
    return;
  }

  if (ensuredDatabases.has(database)) {
    return;
  }

  const systemSession = graphDriver().session({
    database: "system",
    defaultAccessMode: neo4j.session.WRITE,
  });

  try {
    const databaseIdentifier = cypherDatabaseName(database);
    await systemSession.run(`CREATE DATABASE ${databaseIdentifier} IF NOT EXISTS`);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const result = await systemSession.run(
        `
          SHOW DATABASES YIELD name, currentStatus
          WHERE name = $database
          RETURN currentStatus AS status
        `,
        { database },
      );
      const status = result.records[0]?.get("status");
      if (typeof status === "string" && status.toLowerCase() === "online") {
        ensuredDatabases.add(database);
        return;
      }
      await sleep(500);
    }
    throw new Error(`Neo4j database ${database} did not become online in time`);
  } finally {
    await systemSession.close();
  }
}

export async function ensureGraphSchema(database = config.graph.database) {
  if (!graphEnabled()) {
    return;
  }

  if (ensuredSchemas.has(database)) {
    return;
  }

  await ensureGraphDatabaseExists(database);

  const constraintStatements = [
    "CREATE CONSTRAINT ob1_thought_canonical_id IF NOT EXISTS FOR (n:Thought) REQUIRE n.canonical_id IS UNIQUE",
    "CREATE CONSTRAINT ob1_conversation_canonical_id IF NOT EXISTS FOR (n:Conversation) REQUIRE n.canonical_id IS UNIQUE",
    "CREATE CONSTRAINT ob1_email_canonical_id IF NOT EXISTS FOR (n:Email) REQUIRE n.canonical_id IS UNIQUE",
    "CREATE CONSTRAINT ob1_attachment_canonical_id IF NOT EXISTS FOR (n:Attachment) REQUIRE n.canonical_id IS UNIQUE",
    "CREATE CONSTRAINT ob1_document_canonical_id IF NOT EXISTS FOR (n:Document) REQUIRE n.canonical_id IS UNIQUE",
    "CREATE CONSTRAINT ob1_dictation_canonical_id IF NOT EXISTS FOR (n:DictationArtifact) REQUIRE n.canonical_id IS UNIQUE",
    "CREATE CONSTRAINT ob1_message_canonical_id IF NOT EXISTS FOR (n:Message) REQUIRE n.canonical_id IS UNIQUE",
    "CREATE CONSTRAINT ob1_participant_canonical_id IF NOT EXISTS FOR (n:Participant) REQUIRE n.canonical_id IS UNIQUE",
    "CREATE CONSTRAINT ob1_attachment_ref_canonical_id IF NOT EXISTS FOR (n:AttachmentRef) REQUIRE n.canonical_id IS UNIQUE",
    "CREATE CONSTRAINT ob1_person_canonical_id IF NOT EXISTS FOR (n:Person) REQUIRE n.canonical_id IS UNIQUE",
    "CREATE CONSTRAINT ob1_organization_canonical_id IF NOT EXISTS FOR (n:Organization) REQUIRE n.canonical_id IS UNIQUE",
    "CREATE CONSTRAINT ob1_project_canonical_id IF NOT EXISTS FOR (n:Project) REQUIRE n.canonical_id IS UNIQUE",
    "CREATE CONSTRAINT ob1_device_canonical_id IF NOT EXISTS FOR (n:Device) REQUIRE n.canonical_id IS UNIQUE",
    "CREATE CONSTRAINT ob1_place_canonical_id IF NOT EXISTS FOR (n:Place) REQUIRE n.canonical_id IS UNIQUE",
    "CREATE CONSTRAINT ob1_property_canonical_id IF NOT EXISTS FOR (n:Property) REQUIRE n.canonical_id IS UNIQUE",
    "CREATE CONSTRAINT ob1_concept_canonical_id IF NOT EXISTS FOR (n:Concept) REQUIRE n.canonical_id IS UNIQUE",
  ];

  for (const statement of constraintStatements) {
    await runGraph(statement, {}, { database });
  }

  ensuredSchemas.add(database);
}

function projectionRevisionSql() {
  return `
    encode(
      digest(
        coalesce(t.id::text, '') || '|' ||
        coalesce(t.dedupe_key, '') || '|' ||
        coalesce(t.content_hash, '') || '|' ||
        coalesce(t.metadata::text, '') || '|' ||
        coalesce(t.updated_at::text, '') || '|' ||
        $6::text || '|' ||
        $7::text,
        'sha256'
      ),
      'hex'
    )
  `;
}

async function fetchProjectionCandidates({
  database = config.graph.database,
  schemaVariant = config.graph.schemaVariant,
  limit = config.graph.projectorBatchSize,
  forceAll = false,
  thoughtIds = [],
  dedupeKeys = [],
} = {}) {
  const revisionSql = projectionRevisionSql();
  const result = await query(
    `
      with projected as (
        select
          t.id,
          t.brain_id,
          t.dedupe_key,
          t.content,
          t.content_hash,
          t.metadata,
          t.created_at,
          t.updated_at,
          ${revisionSql} as projection_revision_hash,
          gps.projection_revision_hash as projected_revision_hash,
          gps.last_projection_status
        from thoughts t
        left join thought_graph_projection_state gps
          on gps.thought_id = t.id
         and gps.brain_id = t.brain_id
         and gps.graph_database = $1
        where ($2::boolean
          or gps.thought_id is null
          or gps.projection_revision_hash is distinct from ${revisionSql}
          or gps.last_projection_status is distinct from 'projected')
          and (
            ($3::uuid[] is null and $4::text[] is null)
            or ($3::uuid[] is not null and t.id = any($3))
            or ($4::text[] is not null and t.dedupe_key = any($4))
          )
      )
      select *
      from projected
      order by updated_at asc, id asc
      limit $5
    `,
    [
      database,
      forceAll,
      thoughtIds.length ? thoughtIds : null,
      dedupeKeys.length ? dedupeKeys : null,
      limit,
      normalizeGraphSchemaVariant(schemaVariant),
      GRAPH_PROJECTION_REVISION,
    ],
  );

  return result.rows;
}

async function recordProjectionState({
  thoughtId,
  brainId,
  database,
  revisionHash,
  status,
  error = null,
}) {
  await query(
    `
      insert into thought_graph_projection_state (
        thought_id,
        brain_id,
        graph_database,
        projection_revision_hash,
        last_projected_at,
        last_projection_status,
        last_projection_error
      )
      values ($1, $2, $3, $4, now(), $5, $6)
      on conflict (thought_id, graph_database)
      do update set
        brain_id = excluded.brain_id,
        projection_revision_hash = excluded.projection_revision_hash,
        last_projected_at = excluded.last_projected_at,
        last_projection_status = excluded.last_projection_status,
        last_projection_error = excluded.last_projection_error,
        updated_at = now()
    `,
    [thoughtId, brainId, database, revisionHash, status, error],
  );
}

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

function canonicalThoughtId(row) {
  return `thought:${row.id}`;
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

function buildBaseEdgeProps(row) {
  return {
    extraction_method: "metadata",
    confidence: 1,
    source_thought_id: row.id,
    source_type: row.metadata?.type ?? null,
    projected_at: new Date().toISOString(),
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
  const metadata = message?.metadata ?? {};

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

function addClaimEntityProjection(store, row, metadata, userMetadata, baseEdgeProps, schemaVariant) {
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

function buildProjectionPlan(row, schemaVariant = config.graph.schemaVariant) {
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

  const baseEdgeProps = buildBaseEdgeProps(row);
  conversationProjection(store, row, metadata, userMetadata, baseEdgeProps);
  artifactProjection(store, row, metadata, userMetadata, baseEdgeProps);
  rawChatConversationProjection(store, row, metadata, userMetadata, baseEdgeProps, schemaVariant);
  addClaimEntityProjection(store, row, metadata, userMetadata, baseEdgeProps, schemaVariant);

  return {
    nodes: [...store.nodes.values()],
    edges: [...store.edges.values()],
  };
}

async function upsertNode(tx, node) {
  const label = validateLabel(node.label);
  await tx.run(
    `
      MERGE (n:${label} {canonical_id: $canonicalId})
      SET n += $properties
    `,
    {
      canonicalId: node.canonicalId,
      properties: node.properties,
    },
  );
}

async function upsertEdge(tx, edge) {
  const fromLabel = validateLabel(edge.fromLabel);
  const toLabel = validateLabel(edge.toLabel);
  const type = validateRelationship(edge.type);

  await tx.run(
    `
      MATCH (from:${fromLabel} {canonical_id: $fromId})
      MATCH (to:${toLabel} {canonical_id: $toId})
      MERGE (from)-[r:${type}]->(to)
      SET r += $properties
    `,
    {
      fromId: edge.fromId,
      toId: edge.toId,
      properties: edge.properties,
    },
  );
}

async function projectThoughtRow(row, database, schemaVariant) {
  const plan = buildProjectionPlan(row, schemaVariant);
  await writeGraph(async (tx) => {
    for (const node of plan.nodes) {
      await upsertNode(tx, node);
    }
    for (const edge of plan.edges) {
      await upsertEdge(tx, edge);
    }
  }, database);
}

export async function projectThoughts({
  database = config.graph.database,
  schemaVariant = config.graph.schemaVariant,
  limit = config.graph.projectorBatchSize,
  forceAll = false,
  thoughtIds = [],
  dedupeKeys = [],
  verbose = false,
} = {}) {
  if (!graphEnabled()) {
    throw new Error("Graph integration is disabled");
  }

  await ensureGraphDatabaseExists(database);
  await ensureGraphSchema(database);

  const rows = await fetchProjectionCandidates({
    database,
    schemaVariant,
    limit,
    forceAll,
    thoughtIds,
    dedupeKeys,
  });

  const summary = {
    database,
    schema_variant: normalizeGraphSchemaVariant(schemaVariant),
    fetched: rows.length,
    projected: 0,
    failed: 0,
    failures: [],
  };

  for (const row of rows) {
    try {
      await projectThoughtRow(row, database, schemaVariant);
      await recordProjectionState({
        thoughtId: row.id,
        brainId: row.brain_id,
        database,
        revisionHash: row.projection_revision_hash,
        status: "projected",
      });
      summary.projected += 1;
      if (verbose) {
        console.log(`projected thought ${row.id} (${row.dedupe_key})`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordProjectionState({
        thoughtId: row.id,
        brainId: row.brain_id,
        database,
        revisionHash: row.projection_revision_hash,
        status: "failed",
        error: message.slice(0, 2000),
      });
      summary.failed += 1;
      summary.failures.push({
        thought_id: row.id,
        dedupe_key: row.dedupe_key,
        error: message,
      });
      if (verbose) {
        console.error(`failed to project thought ${row.id}: ${message}`);
      }
    }
  }

  return summary;
}

export async function graphProjectionStats(database = config.graph.database) {
  const sql = projectionRevisionSql();
  const result = await query(
    `
      with candidate as (
        select
          t.id,
          t.brain_id,
          gps.last_projection_status,
          gps.last_projected_at,
          gps.last_projection_error,
          ${sql} as revision_hash,
          gps.projection_revision_hash
        from thoughts t
        left join thought_graph_projection_state gps
          on gps.thought_id = t.id
         and gps.brain_id = t.brain_id
         and gps.graph_database = $1
      )
      select
        count(*)::bigint as total_thought_rows,
        count(*) filter (
          where projection_revision_hash = revision_hash
            and last_projection_status = 'projected'
        )::bigint as projected_rows,
        count(*) filter (
          where projection_revision_hash is null
             or projection_revision_hash is distinct from revision_hash
             or last_projection_status is distinct from 'projected'
        )::bigint as pending_rows,
        count(*) filter (where last_projection_status = 'failed')::bigint as failed_rows,
        max(last_projected_at) as last_projected_at
      from candidate
    `,
    [database],
  );

  return result.rows[0] ?? null;
}

function thoughtCanonicalIdFromInput({ thoughtId, canonicalId }) {
  if (canonicalId) {
    return canonicalId;
  }
  if (thoughtId) {
    return `thought:${thoughtId}`;
  }
  throw new Error("Either thought_id or canonical_id is required");
}

function serializeRecord(record) {
  return Object.fromEntries(record.keys.map((key) => [key, record.get(key)]));
}

function dedupeGraphItems(items) {
  const seen = new Set();
  const deduped = [];

  for (const item of items ?? []) {
    const canonicalId = item?.node?.canonical_id;
    if (!canonicalId || seen.has(canonicalId)) {
      continue;
    }
    seen.add(canonicalId);
    deduped.push(item);
  }

  return deduped;
}

async function fetchGraphNode(canonicalId, database = config.graph.database) {
  const result = await runGraph(
    `
      OPTIONAL MATCH (node {canonical_id: $canonicalId})
      RETURN
        CASE
          WHEN node IS NULL THEN null
          ELSE node { .* }
        END AS node,
        CASE
          WHEN node IS NULL THEN []
          ELSE labels(node)
        END AS labels
    `,
    { canonicalId },
    { database, mode: "READ" },
  );

  const row = result.records[0] ? serializeRecord(result.records[0]) : null;
  return {
    node: row?.node ?? null,
    labels: Array.isArray(row?.labels) ? row.labels : [],
  };
}

export async function graphNeighbors({
  thoughtId,
  canonicalId,
  maxHops = 2,
  limit = 10,
  database = config.graph.database,
} = {}) {
  if (!graphEnabled()) {
    throw new Error("Graph integration is disabled");
  }

  const resolvedHops = Math.max(1, Math.min(3, Number(maxHops) || 1));
  const resolvedLimit = Math.max(1, Math.min(200, Number(limit) || 10));
  const targetId = thoughtCanonicalIdFromInput({ thoughtId, canonicalId });

  const result = await runGraph(
    `
      MATCH (center {canonical_id: $canonicalId})
      OPTIONAL MATCH p=(center)-[*1..${resolvedHops}]-(neighbor)
      WHERE neighbor.canonical_id <> center.canonical_id
      WITH
        center,
        neighbor,
        p,
        CASE
          WHEN 'Message' IN labels(neighbor) THEN 1
          ELSE 0
        END AS message_rank,
        CASE
          WHEN 'Conversation' IN labels(neighbor) THEN 0
          WHEN 'Participant' IN labels(neighbor) THEN 1
          WHEN 'AttachmentRef' IN labels(neighbor) THEN 2
          WHEN 'Concept' IN labels(neighbor) THEN 3
          WHEN 'Project' IN labels(neighbor) THEN 4
          WHEN 'Device' IN labels(neighbor) THEN 5
          WHEN 'Organization' IN labels(neighbor) THEN 6
          WHEN 'Place' IN labels(neighbor) THEN 7
          WHEN 'Property' IN labels(neighbor) THEN 8
          WHEN 'Person' IN labels(neighbor) THEN 9
          WHEN 'Thought' IN labels(neighbor) THEN 10
          WHEN 'Email' IN labels(neighbor) THEN 11
          WHEN 'Attachment' IN labels(neighbor) THEN 12
          WHEN 'Document' IN labels(neighbor) THEN 13
          WHEN 'DictationArtifact' IN labels(neighbor) THEN 14
          WHEN 'Message' IN labels(neighbor) THEN 99
          ELSE 50
        END AS label_rank
      ORDER BY
        message_rank ASC,
        CASE WHEN p IS NULL THEN 999 ELSE length(p) END ASC,
        label_rank ASC,
        coalesce(neighbor.updated_at, neighbor.created_at) DESC
      WITH center, neighbor, label_rank, collect(p)[0] AS sample_path
      WITH
        center,
        neighbor,
        label_rank,
        sample_path,
        CASE
          WHEN sample_path IS NULL THEN null
          ELSE length(sample_path)
        END AS hop_count
      ORDER BY
        CASE WHEN label_rank = 99 THEN 1 ELSE 0 END ASC,
        hop_count ASC,
        label_rank ASC,
        coalesce(neighbor.updated_at, neighbor.created_at) DESC
      LIMIT ${resolvedLimit}
      RETURN
        center { .* } as center,
        labels(center) as center_labels,
        collect(
          CASE
            WHEN neighbor IS NULL THEN null
            ELSE {
              node: neighbor { .* },
              labels: labels(neighbor),
              hop_count: hop_count,
              anchors: [pathNode in nodes(sample_path)
                WHERE pathNode.canonical_id <> center.canonical_id
                  AND pathNode.canonical_id <> neighbor.canonical_id
                | {
                  canonical_id: pathNode.canonical_id,
                  labels: labels(pathNode),
                  canonical_name: coalesce(pathNode.canonical_name, pathNode.title, null),
                  normalized_name: coalesce(pathNode.normalized_name, toLower(coalesce(pathNode.canonical_name, pathNode.title, '')))
                }
              ],
              relationships: [rel in relationships(sample_path) | {
                type: type(rel),
                from: startNode(rel).canonical_id,
                to: endNode(rel).canonical_id,
                properties: properties(rel)
              }]
            }
          END
        ) as neighbors
    `,
    {
      canonicalId: targetId,
    },
    { database, mode: "READ" },
  );

  if (result.records.length === 0) {
    return {
      success: true,
      center: null,
      neighbors: [],
    };
  }

  const row = serializeRecord(result.records[0]);
  return {
    success: true,
    center: row.center,
    center_labels: row.center_labels,
    neighbors: dedupeGraphItems((row.neighbors ?? []).filter(Boolean)),
  };
}

export async function graphThoughtNeighbors({
  thoughtId,
  canonicalId,
  maxHops = 2,
  limit = 25,
  allowedRetrievalRoles = [],
  database = config.graph.database,
} = {}) {
  if (!graphEnabled()) {
    throw new Error("Graph integration is disabled");
  }

  const resolvedHops = Math.max(1, Math.min(3, Number(maxHops) || 1));
  const resolvedLimit = Math.max(1, Math.min(200, Number(limit) || 25));
  const targetId = thoughtCanonicalIdFromInput({ thoughtId, canonicalId });
  const filteredRoles = Array.isArray(allowedRetrievalRoles)
    ? allowedRetrievalRoles.filter((value) => typeof value === "string" && value.trim())
    : [];
  const rolePredicate = filteredRoles.length > 0
    ? "AND coalesce(neighbor.retrieval_role, 'unknown') in $allowedRetrievalRoles"
    : "";

  const result = await runGraph(
    `
      MATCH (center:Thought {canonical_id: $canonicalId})
      OPTIONAL MATCH p=(center)-[*1..${resolvedHops}]-(neighbor:Thought)
      WHERE neighbor.canonical_id <> center.canonical_id
        ${rolePredicate}
      WITH center, neighbor, p
      ORDER BY
        CASE WHEN p IS NULL THEN 999 ELSE length(p) END ASC,
        coalesce(neighbor.updated_at, neighbor.created_at) DESC
      WITH center, neighbor, collect(p)[0] AS sample_path
      WITH
        center,
        neighbor,
        sample_path,
        CASE
          WHEN sample_path IS NULL THEN null
          ELSE length(sample_path)
        END AS hop_count
      ORDER BY hop_count ASC, coalesce(neighbor.updated_at, neighbor.created_at) DESC
      LIMIT ${resolvedLimit}
      RETURN
        center { .* } as center,
        labels(center) as center_labels,
        collect(
          CASE
            WHEN neighbor IS NULL THEN null
            ELSE {
              node: neighbor { .* },
              labels: labels(neighbor),
              hop_count: hop_count,
              anchors: [pathNode in nodes(sample_path)
                WHERE pathNode.canonical_id <> center.canonical_id
                  AND pathNode.canonical_id <> neighbor.canonical_id
                | {
                  canonical_id: pathNode.canonical_id,
                  labels: labels(pathNode),
                  canonical_name: coalesce(pathNode.canonical_name, pathNode.title, null),
                  normalized_name: coalesce(pathNode.normalized_name, toLower(coalesce(pathNode.canonical_name, pathNode.title, '')))
                }
              ],
              relationships: [rel in relationships(sample_path) | {
                type: type(rel),
                from: startNode(rel).canonical_id,
                to: endNode(rel).canonical_id,
                properties: properties(rel)
              }]
            }
          END
        ) as neighbors
    `,
    {
      canonicalId: targetId,
      allowedRetrievalRoles: filteredRoles,
    },
    { database, mode: "READ" },
  );

  if (result.records.length === 0) {
    return {
      success: true,
      center: null,
      neighbors: [],
    };
  }

  const row = serializeRecord(result.records[0]);
  return {
    success: true,
    center: row.center,
    center_labels: row.center_labels,
    neighbors: dedupeGraphItems((row.neighbors ?? []).filter(Boolean)),
  };
}

export async function whyConnected({
  fromThoughtId,
  fromCanonicalId,
  toThoughtId,
  toCanonicalId,
  maxHops = 4,
  limit = 3,
  database = config.graph.database,
} = {}) {
  if (!graphEnabled()) {
    throw new Error("Graph integration is disabled");
  }

  const resolvedHops = Math.max(1, Math.min(6, Number(maxHops) || 4));
  const resolvedLimit = Math.max(1, Math.min(8, Number(limit) || 3));
  const fromId = thoughtCanonicalIdFromInput({ thoughtId: fromThoughtId, canonicalId: fromCanonicalId });
  const toId = thoughtCanonicalIdFromInput({ thoughtId: toThoughtId, canonicalId: toCanonicalId });

  const [fromNode, toNode] = await Promise.all([
    fetchGraphNode(fromId, database),
    fetchGraphNode(toId, database),
  ]);

  if (!fromNode.node || !toNode.node) {
    return {
      success: true,
      connected: false,
      from: fromNode.node,
      from_labels: fromNode.labels,
      to: toNode.node,
      to_labels: toNode.labels,
      paths: [],
    };
  }

  if (fromId === toId) {
    return {
      success: true,
      connected: true,
      from: fromNode.node,
      from_labels: fromNode.labels,
      to: toNode.node,
      to_labels: toNode.labels,
      paths: [
        {
          hop_count: 0,
          nodes: [
            {
              canonical_id: fromNode.node.canonical_id,
              labels: fromNode.labels,
              properties: fromNode.node,
            },
          ],
          relationships: [],
        },
      ],
    };
  }

  const result = await runGraph(
    `
      MATCH (from {canonical_id: $fromCanonicalId})
      MATCH (to {canonical_id: $toCanonicalId})
      OPTIONAL MATCH p = allShortestPaths((from)-[*..${resolvedHops}]-(to))
      WITH from, to, p
      ORDER BY CASE WHEN p IS NULL THEN 999 ELSE length(p) END ASC
      LIMIT ${resolvedLimit}
      RETURN
        from { .* } AS from_node,
        labels(from) AS from_labels,
        to { .* } AS to_node,
        labels(to) AS to_labels,
        collect(
          CASE
            WHEN p IS NULL THEN null
            ELSE {
              hop_count: length(p),
              nodes: [node in nodes(p) | {
                canonical_id: node.canonical_id,
                labels: labels(node),
                properties: properties(node)
              }],
              relationships: [rel in relationships(p) | {
                type: type(rel),
                from: startNode(rel).canonical_id,
                to: endNode(rel).canonical_id,
                properties: properties(rel)
              }]
            }
          END
        ) AS paths
    `,
    {
      fromCanonicalId: fromId,
      toCanonicalId: toId,
    },
    { database, mode: "READ" },
  );

  if (result.records.length === 0) {
    return {
      success: true,
      connected: false,
      from: fromNode.node,
      from_labels: fromNode.labels,
      to: toNode.node,
      to_labels: toNode.labels,
      paths: [],
    };
  }

  const row = serializeRecord(result.records[0]);
  const paths = (row.paths ?? []).filter(Boolean);
  return {
    success: true,
    connected: paths.length > 0,
    from: row.from_node,
    from_labels: row.from_labels,
    to: row.to_node,
    to_labels: row.to_labels,
    paths,
  };
}

export async function sourceLineage({
  thoughtId,
  canonicalId,
  maxDepth = 4,
  limit = 12,
  database = config.graph.database,
} = {}) {
  if (!graphEnabled()) {
    throw new Error("Graph integration is disabled");
  }

  const resolvedDepth = Math.max(1, Math.min(6, Number(maxDepth) || 4));
  const resolvedLimit = Math.max(1, Math.min(50, Number(limit) || 12));
  const targetId = thoughtCanonicalIdFromInput({ thoughtId, canonicalId });

  const result = await runGraph(
    `
      MATCH (center:Thought {canonical_id: $canonicalId})
      OPTIONAL MATCH p=(center)-[:DERIVED_FROM|PART_OF|REFERENCES_SOURCE*1..${resolvedDepth}]->(source)
      WHERE source:Conversation OR source:Email OR source:Attachment OR source:Document OR source:DictationArtifact
      WITH center, p, source
      ORDER BY length(p) ASC, coalesce(source.updated_at, source.created_at) DESC
      LIMIT ${resolvedLimit}
      RETURN
        center { .* } as center,
        labels(center) as center_labels,
        collect(
          CASE
            WHEN source IS NULL THEN null
            ELSE {
              node: source { .* },
              labels: labels(source),
              hop_count: length(p),
              relationships: [rel in relationships(p) | {
                type: type(rel),
                from: startNode(rel).canonical_id,
                to: endNode(rel).canonical_id,
                properties: properties(rel)
              }]
            }
          END
        ) as lineage
    `,
    {
      canonicalId: targetId,
    },
    { database, mode: "READ" },
  );

  if (result.records.length === 0) {
    return {
      success: true,
      center: null,
      lineage: [],
    };
  }

  const row = serializeRecord(result.records[0]);
  return {
    success: true,
    center: row.center,
    center_labels: row.center_labels,
    lineage: dedupeGraphItems((row.lineage ?? []).filter(Boolean)),
  };
}

export function startGraphProjectorLoop() {
  if (!graphEnabled() || config.graph.projectorIntervalSeconds <= 0 || projectorTimer) {
    return;
  }

  const tick = async () => {
    if (projectorRunning) {
      return;
    }
    projectorRunning = true;
    try {
      await projectThoughts({
        database: config.graph.database,
        schemaVariant: config.graph.schemaVariant,
        limit: config.graph.projectorBatchSize,
      });
    } catch (error) {
      console.error(
        `graph projector tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      projectorRunning = false;
    }
  };

  void tick();
  projectorTimer = setInterval(() => {
    void tick();
  }, config.graph.projectorIntervalSeconds * 1000);
}

export async function stopGraphProjectorLoop() {
  if (projectorTimer) {
    clearInterval(projectorTimer);
    projectorTimer = null;
  }
  await closeGraph();
}
