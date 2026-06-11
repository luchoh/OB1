// Projection planner — pure plan-level suite (module 3 of PRD docs/34).
//
// These tests cross the planner's ONE interface (`planProjection`) and assert on
// the plan it returns. They run with zero infrastructure: no Neo4j, no Postgres,
// no config. Every expectation is a HAND-AUTHORED plan literal — none is produced
// by calling the planner (a self-deriving test proves nothing). Where a canonical
// id embeds a sha256 (AttachmentRef, claim entities), the test pins the structural
// shape — label counts, canonical names, relationship types — rather than the
// opaque hash, the same property the live structure-eval cases assert.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planProjection, PLAN_OPS } from "../src/projection-planner.mjs";

// Fixed, injected wall-clock so plans are deterministic.
const TS = "2026-01-01T00:00:00.000Z";
const CREATED = "2025-12-01T10:00:00.000Z";
const UPDATED = "2025-12-02T11:00:00.000Z";

const T = "11111111-1111-4111-8111-111111111111";
const CID = `thought:${T}`;

// Common structural columns every row carries.
function baseRow(overrides = {}) {
  return {
    id: T,
    dedupe_key: "dk",
    content_hash: "ch",
    content: "hello world",
    created_at: CREATED,
    updated_at: UPDATED,
    deleted_at: null,
    ...overrides,
  };
}

// The metadata-edge property block stamped on every edge for a given source_type.
function metaEdge(sourceType) {
  return {
    extraction_method: "metadata",
    confidence: 1,
    source_thought_id: T,
    source_type: sourceType,
    projected_at: TS,
  };
}

// --- structural helpers (used only where a canonical id is hashed) ----------
function labelCounts(nodes) {
  const counts = {};
  for (const n of nodes) {
    counts[n.label] = (counts[n.label] ?? 0) + 1;
  }
  return counts;
}
function namesForLabel(nodes, label) {
  return nodes
    .filter((n) => n.label === label)
    .map((n) => n.properties.canonical_name)
    .sort();
}
function edgeTuples(edges) {
  return edges
    .map((e) => `${e.fromLabel}-${e.type}->${e.toLabel}`)
    .sort();
}

describe("projection planner — interface guards", () => {
  it("throws on a row with no id (programmer error, not a control-flow verdict)", () => {
    assert.throws(() => planProjection({}, { projectedAt: TS }), /requires a thought row with an id/);
    assert.throws(() => planProjection(null, { projectedAt: TS }), /requires a thought row/);
  });
});

describe("projection planner — tombstone & restore (docs/32 D2 / M4)", () => {
  it("a soft-deleted row yields a DELETE plan, never node/edge data", () => {
    const row = baseRow({
      deleted_at: "2026-01-01T00:00:00Z",
      metadata: { type: "chat_distillation", source: "chatgpt", user_metadata: { chatgpt_conversation_id: "conv-abc" } },
    });
    assert.deepEqual(planProjection(row, { projectedAt: TS }), {
      op: PLAN_OPS.DELETE,
      canonicalId: CID,
      thoughtId: T,
    });
  });

  it("a restored row (deleted_at cleared) re-projects the FULL upsert plan", () => {
    // Identical row save for deleted_at:null must produce the same complete plan a
    // never-deleted row would — this is the M4 restore→re-projection guarantee.
    const metadata = {
      type: "chat_distillation",
      source: "chatgpt",
      retrieval_role: "distilled",
      summary: "A summary",
      user_metadata: {
        chatgpt_conversation_id: "conv-abc",
        chatgpt_title: "My Chat",
        chatgpt_create_time: "2025-11-01T00:00:00Z",
      },
    };
    const restored = planProjection(baseRow({ deleted_at: null, content: "Distilled chat summary", metadata }), { projectedAt: TS });

    assert.equal(restored.op, PLAN_OPS.UPSERT);
    assert.deepEqual(restored, {
      op: PLAN_OPS.UPSERT,
      canonicalId: CID,
      thoughtId: T,
      nodes: [
        {
          label: "Thought",
          canonicalId: CID,
          properties: {
            canonical_id: CID,
            thought_id: T,
            dedupe_key: "dk",
            content_hash: "ch",
            source_system: "chatgpt",
            source_type: "chat_distillation",
            retrieval_role: "distilled",
            title: "My Chat",
            summary: "A summary",
            content_preview: "Distilled chat summary",
            created_at: CREATED,
            updated_at: UPDATED,
          },
        },
        {
          label: "Conversation",
          canonicalId: "conversation:chatgpt:conv-abc",
          properties: {
            canonical_id: "conversation:chatgpt:conv-abc",
            source_system: "chatgpt",
            source_type: "conversation",
            platform: "chatgpt",
            external_id: "conv-abc",
            conversation_hash: null,
            title: "My Chat",
            created_at: "2025-11-01T00:00:00Z",
            updated_at: UPDATED,
          },
        },
      ],
      edges: [
        { fromLabel: "Thought", fromId: CID, type: "DERIVED_FROM", toLabel: "Conversation", toId: "conversation:chatgpt:conv-abc", properties: metaEdge("chat_distillation") },
        { fromLabel: "Conversation", fromId: "conversation:chatgpt:conv-abc", type: "DISTILLED_TO", toLabel: "Thought", toId: CID, properties: metaEdge("chat_distillation") },
      ],
    });
  });
});

describe("projection planner — conversation source (provenance-v1)", () => {
  it("a distilled chatgpt thought projects DERIVED_FROM + DISTILLED_TO", () => {
    const plan = planProjection(
      baseRow({
        content: "Distilled chat summary",
        metadata: {
          type: "chat_distillation",
          source: "chatgpt",
          retrieval_role: "distilled",
          summary: "A summary",
          user_metadata: { chatgpt_conversation_id: "conv-abc", chatgpt_title: "My Chat", chatgpt_create_time: "2025-11-01T00:00:00Z" },
        },
      }),
      { projectedAt: TS },
    );
    assert.deepEqual(edgeTuples(plan.edges), [
      "Conversation-DISTILLED_TO->Thought",
      "Thought-DERIVED_FROM->Conversation",
    ]);
    assert.deepEqual(labelCounts(plan.nodes), { Thought: 1, Conversation: 1 });
  });

  it("retrieval_role:source flips the edge to REFERENCES_SOURCE with NO distilled back-edge", () => {
    const plan = planProjection(
      baseRow({
        metadata: {
          type: "chatgpt_conversation_record",
          source: "chatgpt",
          retrieval_role: "source",
          user_metadata: { chatgpt_conversation_id: "conv-abc" },
        },
      }),
      { projectedAt: TS },
    );
    // provenance-v1 (default): no raw Message/Participant structure, just the link.
    assert.deepEqual(edgeTuples(plan.edges), ["Thought-REFERENCES_SOURCE->Conversation"]);
    assert.deepEqual(labelCounts(plan.nodes), { Thought: 1, Conversation: 1 });
  });
});

describe("projection planner — email / document / dictation artifacts", () => {
  it("an email_thought projects an Email with DERIVED_FROM + DISTILLED_TO", () => {
    const plan = planProjection(
      baseRow({
        content: "email body",
        metadata: {
          type: "email_thought",
          source: "imap",
          user_metadata: { email_dedupe_key: "mail-1", email_subject: "Hi", email_sender: "a@b.com" },
        },
      }),
      { projectedAt: TS },
    );
    assert.deepEqual(plan.nodes, [
      {
        label: "Thought",
        canonicalId: CID,
        properties: {
          canonical_id: CID,
          thought_id: T,
          dedupe_key: "dk",
          content_hash: "ch",
          source_system: "imap",
          source_type: "email_thought",
          retrieval_role: null,
          title: "Hi",
          summary: "email body",
          content_preview: "email body",
          created_at: CREATED,
          updated_at: UPDATED,
        },
      },
      {
        label: "Email",
        canonicalId: "email:mail-1",
        properties: {
          canonical_id: "email:mail-1",
          source_system: "imap",
          source_type: "email",
          title: "Hi",
          sender: "a@b.com",
          sender_name: null,
          mailbox: null,
          occurred_at: null,
          imap_uid: null,
          created_at: CREATED,
          updated_at: UPDATED,
        },
      },
    ]);
    assert.deepEqual(plan.edges, [
      { fromLabel: "Thought", fromId: CID, type: "DERIVED_FROM", toLabel: "Email", toId: "email:mail-1", properties: metaEdge("email_thought") },
      { fromLabel: "Email", fromId: "email:mail-1", type: "DISTILLED_TO", toLabel: "Thought", toId: CID, properties: metaEdge("email_thought") },
    ]);
  });

  it("a document_summary projects DERIVED_FROM + SUMMARIZED_AS + DISTILLED_TO", () => {
    const plan = planProjection(
      baseRow({
        metadata: {
          type: "document_summary",
          source: "document",
          user_metadata: { document_sha256: "docsha", document_filename: "f.pdf" },
        },
      }),
      { projectedAt: TS },
    );
    assert.deepEqual(labelCounts(plan.nodes), { Thought: 1, Document: 1 });
    assert.deepEqual(edgeTuples(plan.edges), [
      "Document-DISTILLED_TO->Thought",
      "Document-SUMMARIZED_AS->Thought",
      "Thought-DERIVED_FROM->Document",
    ]);
    const doc = plan.nodes.find((n) => n.label === "Document");
    assert.equal(doc.canonicalId, "document:docsha");
    assert.equal(doc.properties.filename, "f.pdf");
    assert.equal(doc.properties.source_type, "document");
  });

  it("a document_chunk projects PART_OF + REFERENCES_SOURCE (no distill back-edges)", () => {
    const plan = planProjection(
      baseRow({
        metadata: {
          type: "document_chunk",
          source: "document",
          user_metadata: { document_sha256: "docsha" },
        },
      }),
      { projectedAt: TS },
    );
    assert.deepEqual(edgeTuples(plan.edges), [
      "Thought-PART_OF->Document",
      "Thought-REFERENCES_SOURCE->Document",
    ]);
  });

  it("a distilled dictation thought projects DERIVED_FROM + DISTILLED_TO", () => {
    const plan = planProjection(
      baseRow({
        metadata: {
          type: "dictation_note",
          source: "dictation",
          retrieval_role: "distilled",
          user_metadata: { artifact_id: "art-1" },
        },
      }),
      { projectedAt: TS },
    );
    assert.deepEqual(labelCounts(plan.nodes), { Thought: 1, DictationArtifact: 1 });
    assert.deepEqual(edgeTuples(plan.edges), [
      "DictationArtifact-DISTILLED_TO->Thought",
      "Thought-DERIVED_FROM->DictationArtifact",
    ]);
    const art = plan.nodes.find((n) => n.label === "DictationArtifact");
    assert.equal(art.canonicalId, "dictation:art-1");
    assert.equal(art.properties.artifact_id, "art-1");
    assert.equal(art.properties.created_at, CREATED);
  });
});

describe("projection planner — raw chat structure (source-first-chat-v1)", () => {
  const rawExport = {
    mapping: {
      root: { parent: null, children: ["m1"], message: null },
      m1: {
        parent: "root",
        children: ["m2"],
        message: { id: "msg1", author: { role: "user" }, create_time: "2023-11-14T22:13:20.000Z", content: { content_type: "text", parts: ["Hello"] } },
      },
      m2: {
        parent: "m1",
        children: [],
        message: { id: "msg2", author: { role: "assistant" }, create_time: "2023-11-14T22:15:00.000Z", content: { content_type: "text", parts: ["Hi there"] } },
      },
    },
  };

  const plan = planProjection(
    baseRow({
      metadata: {
        type: "chatgpt_conversation_record",
        source: "chatgpt",
        user_metadata: { chatgpt_conversation_id: "c1", chatgpt_title: "T", raw_export_json: JSON.stringify(rawExport) },
      },
    }),
    { schemaVariant: "source-first-chat-v1", projectedAt: TS },
  );

  it("walks the message tree into Message + Participant nodes (alongside the Conversation)", () => {
    // conversationProjection AND rawChatConversationProjection BOTH fire for a
    // record-type thought that carries a conversation id — the documented overlap.
    assert.deepEqual(labelCounts(plan.nodes), { Thought: 1, Conversation: 1, Message: 2, Participant: 2 });
    const messageIds = plan.nodes.filter((n) => n.label === "Message").map((n) => n.canonicalId).sort();
    assert.deepEqual(messageIds, ["message:chatgpt:c1:msg1", "message:chatgpt:c1:msg2"]);
    const participantIds = plan.nodes.filter((n) => n.label === "Participant").map((n) => n.canonicalId).sort();
    assert.deepEqual(participantIds, ["participant:chatgpt:c1:assistant", "participant:chatgpt:c1:user"]);
  });

  it("emits HAS_MESSAGE, REFERENCES_SOURCE, AUTHORED_BY and a PRECEDES chain", () => {
    assert.deepEqual(edgeTuples(plan.edges), [
      "Conversation-DISTILLED_TO->Thought",
      "Conversation-HAS_MESSAGE->Message",
      "Conversation-HAS_MESSAGE->Message",
      "Message-AUTHORED_BY->Participant",
      "Message-AUTHORED_BY->Participant",
      "Message-PRECEDES->Message",
      "Thought-DERIVED_FROM->Conversation",
      "Thought-REFERENCES_SOURCE->Message",
      "Thought-REFERENCES_SOURCE->Message",
    ]);
    const precedes = plan.edges.find((e) => e.type === "PRECEDES");
    assert.equal(precedes.fromId, "message:chatgpt:c1:msg1");
    assert.equal(precedes.toId, "message:chatgpt:c1:msg2");
  });

  it("the first Message node carries the expected hand-authored properties", () => {
    const msg1 = plan.nodes.find((n) => n.canonicalId === "message:chatgpt:c1:msg1");
    assert.deepEqual(msg1.properties, {
      canonical_id: "message:chatgpt:c1:msg1",
      source_system: "chatgpt",
      source_type: "message",
      platform: "chatgpt",
      conversation_id: "c1",
      conversation_hash: null,
      message_key: "msg1",
      ordinal: 1,
      role: "user",
      attachment_count: 0,
      content_preview: "Hello",
      created_at: "2023-11-14T22:13:20.000Z",
      updated_at: UPDATED,
    });
  });

  it("provenance-v1 does NOT walk the raw structure (no Message/Participant nodes)", () => {
    const provenancePlan = planProjection(
      baseRow({
        metadata: {
          type: "chatgpt_conversation_record",
          source: "chatgpt",
          user_metadata: { chatgpt_conversation_id: "c1", raw_export_json: JSON.stringify(rawExport) },
        },
      }),
      { projectedAt: TS },
    );
    assert.deepEqual(labelCounts(provenancePlan.nodes), { Thought: 1, Conversation: 1 });
  });
});

describe("projection planner — claim/entity metadata (source-first-chat-claims-v1)", () => {
  const plan = planProjection(
    baseRow({
      content: "I prefer dark mode in VS Code on my MacBook",
      metadata: {
        type: "claim",
        source: "chatgpt",
        user_metadata: {
          claim_kind: "preference",
          claim_subject: "Dark Mode",
          claim_object: "VS Code",
          claim_strength: "strong",
          claim_scope: { device: ["MacBook"], totally_unknown_key: ["ignored"] },
        },
      },
    }),
    { schemaVariant: "source-first-chat-claims-v1", projectedAt: TS },
  );

  it("subject/object become Concepts; a known scope key becomes its typed entity", () => {
    assert.deepEqual(labelCounts(plan.nodes), { Thought: 1, Concept: 2, Device: 1 });
    assert.deepEqual(namesForLabel(plan.nodes, "Concept"), ["Dark Mode", "VS Code"]);
    assert.deepEqual(namesForLabel(plan.nodes, "Device"), ["MacBook"]);
  });

  it("claim_kind:preference maps the object edge to USES; subject is ABOUT; device is ASSOCIATED_WITH", () => {
    assert.deepEqual(edgeTuples(plan.edges), [
      "Thought-ABOUT->Concept",
      "Thought-ASSOCIATED_WITH->Device",
      "Thought-USES->Concept",
    ]);
  });

  it("entity nodes carry claim_metadata extraction with strong-claim confidence", () => {
    const subject = plan.nodes.find((n) => n.properties.canonical_name === "Dark Mode");
    assert.equal(subject.properties.entity_type, "Concept");
    assert.equal(subject.properties.normalized_name, "dark mode");
    assert.equal(subject.properties.extraction_method, "claim_metadata");
    assert.equal(subject.properties.confidence, 0.95);
    const aboutEdge = plan.edges.find((e) => e.type === "ABOUT");
    assert.equal(aboutEdge.properties.claim_kind, "preference");
    assert.equal(aboutEdge.properties.confidence, 0.95);
  });

  it("an unknown claim_scope key fabricates NOTHING (guard rail #5: degrade, don't invent)", () => {
    // totally_unknown_key produced no node and no edge.
    assert.equal(plan.nodes.some((n) => n.properties.source_scope_key === "totally_unknown_key"), false);
    assert.equal(plan.nodes.length, 4);
  });

  it("the claims variant ignores claim metadata on a non-claim conversation thought's scope only", () => {
    // A claims-variant thought with no claim_* fields degrades to just the Thought node.
    const bare = planProjection(
      baseRow({ metadata: { type: "note", source: "manual", user_metadata: {} } }),
      { schemaVariant: "source-first-chat-claims-v1", projectedAt: TS },
    );
    assert.deepEqual(labelCounts(bare.nodes), { Thought: 1 });
    assert.equal(bare.edges.length, 0);
  });
});

describe("projection planner — malformed metadata degrades without fabricating (guard rail #5)", () => {
  it("a non-object user_metadata yields only the Thought node, no invented edges", () => {
    const plan = planProjection(
      baseRow({ metadata: { type: "weird", source: "mystery", user_metadata: "not-an-object" } }),
      { projectedAt: TS },
    );
    assert.deepEqual(plan.nodes, [
      {
        label: "Thought",
        canonicalId: CID,
        properties: {
          canonical_id: CID,
          thought_id: T,
          dedupe_key: "dk",
          content_hash: "ch",
          source_system: "mystery",
          source_type: "weird",
          retrieval_role: null,
          title: null,
          summary: "hello world",
          content_preview: "hello world",
          created_at: CREATED,
          updated_at: UPDATED,
        },
      },
    ]);
    assert.equal(plan.edges.length, 0);
  });

  it("a row with no metadata at all still projects a valid Thought node", () => {
    const plan = planProjection(baseRow({ metadata: undefined }), { projectedAt: TS });
    assert.deepEqual(labelCounts(plan.nodes), { Thought: 1 });
    const t = plan.nodes[0];
    assert.equal(t.properties.source_system, null);
    assert.equal(t.properties.source_type, null);
    assert.equal(plan.edges.length, 0);
  });

  it("unparseable raw_export_json under the raw schema degrades to no Message nodes", () => {
    const plan = planProjection(
      baseRow({
        metadata: {
          type: "chatgpt_conversation_record",
          source: "chatgpt",
          user_metadata: { chatgpt_conversation_id: "c1", raw_export_json: "{not valid json" },
        },
      }),
      { schemaVariant: "source-first-chat-v1", projectedAt: TS },
    );
    // The Conversation node still forms (conversationProjection), but the broken
    // raw payload yields zero Message/Participant nodes — no fabricated structure.
    assert.deepEqual(labelCounts(plan.nodes), { Thought: 1, Conversation: 1 });
  });
});

describe("projection planner — projectedAt injection", () => {
  it("stamps the injected timestamp onto edge properties", () => {
    const plan = planProjection(
      baseRow({ metadata: { type: "email_thought", source: "imap", user_metadata: { email_dedupe_key: "m" } } }),
      { projectedAt: "1999-09-09T09:09:09.000Z" },
    );
    assert.ok(plan.edges.length > 0);
    for (const edge of plan.edges) {
      assert.equal(edge.properties.projected_at, "1999-09-09T09:09:09.000Z");
    }
  });

  it("omitting projectedAt drops the property entirely (never invents a clock value)", () => {
    const plan = planProjection(
      baseRow({ metadata: { type: "email_thought", source: "imap", user_metadata: { email_dedupe_key: "m" } } }),
      {},
    );
    assert.ok(plan.edges.length > 0);
    for (const edge of plan.edges) {
      assert.equal("projected_at" in edge.properties, false);
    }
  });
});
