import neo4j from "neo4j-driver";
import { config } from "./config.mjs";
import { query } from "./db.mjs";

const NODE_LABELS = new Set([
  "Thought",
  "Conversation",
  "Email",
  "Attachment",
  "Document",
  "DictationArtifact",
]);

const REL_TYPES = new Set([
  "DERIVED_FROM",
  "PART_OF",
  "HAS_ATTACHMENT",
  "SUMMARIZED_AS",
  "DISTILLED_TO",
  "REFERENCES_SOURCE",
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
        coalesce(t.updated_at::text, ''),
        'sha256'
      ),
      'hex'
    )
  `;
}

async function fetchProjectionCandidates({
  database = config.graph.database,
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
         and gps.graph_database = $1
        where ($2::boolean
          or gps.thought_id is null
          or gps.projection_revision_hash is distinct from ${revisionSql}
          or gps.last_projection_status is distinct from 'projected')
          and ($3::uuid[] is null or t.id = any($3))
          and ($4::text[] is null or t.dedupe_key = any($4))
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
    ],
  );

  return result.rows;
}

async function recordProjectionState({
  thoughtId,
  database,
  revisionHash,
  status,
  error = null,
}) {
  await query(
    `
      insert into thought_graph_projection_state (
        thought_id,
        graph_database,
        projection_revision_hash,
        last_projected_at,
        last_projection_status,
        last_projection_error
      )
      values ($1, $2, $3, now(), $4, $5)
      on conflict (thought_id, graph_database)
      do update set
        projection_revision_hash = excluded.projection_revision_hash,
        last_projected_at = excluded.last_projected_at,
        last_projection_status = excluded.last_projection_status,
        last_projection_error = excluded.last_projection_error,
        updated_at = now()
    `,
    [thoughtId, database, revisionHash, status, error],
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

function conversationProjection(store, row, metadata, userMetadata, baseEdgeProps) {
  const chatgptHash = prefer(userMetadata.chatgpt_conversation_hash);
  const chatgptId = prefer(userMetadata.chatgpt_conversation_id);
  const claudeHash = prefer(userMetadata.claude_conversation_hash);
  const claudeId = prefer(userMetadata.claude_conversation_id);
  const thoughtId = canonicalThoughtId(row);

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
    addEdge(store.edges, "Thought", thoughtId, "DERIVED_FROM", "Conversation", canonicalId, baseEdgeProps);
    addEdge(store.edges, "Conversation", canonicalId, "DISTILLED_TO", "Thought", thoughtId, baseEdgeProps);
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
    addEdge(store.edges, "Thought", thoughtId, "DERIVED_FROM", "Conversation", canonicalId, baseEdgeProps);
    addEdge(store.edges, "Conversation", canonicalId, "DISTILLED_TO", "Thought", thoughtId, baseEdgeProps);
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

function buildProjectionPlan(row) {
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

async function projectThoughtRow(row, database) {
  const plan = buildProjectionPlan(row);
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
    limit,
    forceAll,
    thoughtIds,
    dedupeKeys,
  });

  const summary = {
    database,
    fetched: rows.length,
    projected: 0,
    failed: 0,
    failures: [],
  };

  for (const row of rows) {
    try {
      await projectThoughtRow(row, database);
      await recordProjectionState({
        thoughtId: row.id,
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
          gps.last_projection_status,
          gps.last_projected_at,
          gps.last_projection_error,
          ${sql} as revision_hash,
          gps.projection_revision_hash
        from thoughts t
        left join thought_graph_projection_state gps
          on gps.thought_id = t.id
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
  const resolvedLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const targetId = thoughtCanonicalIdFromInput({ thoughtId, canonicalId });

  const result = await runGraph(
    `
      MATCH (center {canonical_id: $canonicalId})
      OPTIONAL MATCH p=(center)-[*1..${resolvedHops}]-(neighbor)
      WHERE neighbor.canonical_id <> center.canonical_id
      WITH center, p, neighbor
      ORDER BY length(p) ASC, coalesce(neighbor.updated_at, neighbor.created_at) DESC
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
              hop_count: length(p),
              relationships: [rel in relationships(p) | {
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
