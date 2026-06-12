// Graph driver / session management — the Neo4j connection seam.
//
// One of the three modules graph.mjs split into (PRD docs/34, module 3). This is
// the ONLY place that opens a Neo4j driver, runs sessions, and ensures databases
// and constraints exist. The reads module and the projection module run their
// Cypher through `runGraph`/`writeGraph` here; neither touches the driver
// singleton directly.
//
// Label/relationship vocabularies and the schema-variant normalizer are owned by
// the pure projection-planner module and imported here, so the graph vocabulary
// lives in exactly one place.

import neo4j from "neo4j-driver";
import { config } from "./config.mjs";
import {
  GRAPH_NODE_LABELS,
  GRAPH_REL_TYPES,
  normalizeGraphSchemaVariant,
} from "./projection-planner.mjs";

let driver;
let ensuredDatabases = new Set();
let ensuredSchemas = new Set();

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function graphEnabled() {
  return config.graph?.enabled === true;
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

export function validateLabel(label) {
  if (!GRAPH_NODE_LABELS.has(label)) {
    throw new Error(`Unsupported graph label: ${label}`);
  }
  return cypherIdentifier(label, "label");
}

export function validateRelationship(type) {
  if (!GRAPH_REL_TYPES.has(type)) {
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

export async function runGraph(statement, parameters = {}, { database = config.graph.database, mode = "WRITE" } = {}) {
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

export async function writeGraph(work, database = config.graph.database) {
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

// Flatten a neo4j Record into a plain object keyed by its return columns.
export function serializeRecord(record) {
  return Object.fromEntries(record.keys.map((key) => [key, record.get(key)]));
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
