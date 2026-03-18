import { config } from "./config.mjs";

const metadataTool = {
  type: "function",
  function: {
    name: "submit_metadata",
    description: "Return structured metadata for a note in the personal knowledge base.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [
        "people",
        "action_items",
        "dates_mentioned",
        "topics",
        "type",
        "summary",
        "source",
      ],
      properties: {
        people: {
          type: "array",
          items: { type: "string" },
        },
        action_items: {
          type: "array",
          items: { type: "string" },
        },
        dates_mentioned: {
          type: "array",
          items: { type: "string" },
        },
        topics: {
          type: "array",
          items: { type: "string" },
        },
        type: {
          type: "string",
        },
        summary: {
          type: "string",
        },
        source: {
          type: ["string", "null"],
        },
      },
    },
  },
};

const groundedAnswerTool = {
  type: "function",
  function: {
    name: "submit_grounded_answer",
    description: "Return a grounded answer using only the provided evidence items.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [
        "answer",
        "grounded",
        "citations",
      ],
      properties: {
        answer: {
          type: "string",
        },
        grounded: {
          type: "boolean",
        },
        citations: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
  },
};

const SOURCE_RETRIEVAL_TYPES = new Set([
  "email",
  "document_chunk",
  "chatgpt_conversation_source",
  "claude_conversation_source",
  "chatgpt_conversation_record",
  "claude_conversation_record",
]);

function truncateText(text, limit = 240) {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1)}…`;
}

function normalizeChatContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("")
      .trim();
  }

  return "";
}

function extractJsonPayload(text) {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "");

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Model did not return a JSON object");
    }
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

function extractToolArguments(response, expectedName) {
  const toolCalls = response?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    const inlineToolArgs = extractInlineToolArguments(response?.choices?.[0]?.message?.content, expectedName);
    if (inlineToolArgs) {
      return inlineToolArgs;
    }
    throw new Error("Model did not return a tool call");
  }

  const call = toolCalls.find((entry) => entry?.function?.name === expectedName) ?? toolCalls[0];
  const raw = call?.function?.arguments;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("Tool call arguments were empty");
  }

  return extractJsonPayload(raw);
}

function extractInlineToolArguments(content, expectedName) {
  const text = normalizeChatContent(content);
  if (!text.includes("<function=")) {
    return null;
  }

  const functionMatch = text.match(/<function=([^>\n]+)>\s*([\s\S]*)/);
  if (!functionMatch) {
    return null;
  }

  const functionName = functionMatch[1]?.trim();
  if (!functionName || (expectedName && functionName !== expectedName)) {
    return null;
  }

  const body = functionMatch[2] ?? "";
  const params = {};
  const paramRegex = /<parameter=([^>\n]+)>\s*([\s\S]*?)\s*<\/parameter>/g;

  for (const match of body.matchAll(paramRegex)) {
    const key = match[1]?.trim();
    if (!key) {
      continue;
    }
    params[key] = match[2]?.trim() ?? "";
  }

  return Object.keys(params).length > 0 ? params : null;
}

function sanitizeStringList(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [...new Set(values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean))];
}

function sanitizeEvidenceItems(evidence) {
  if (!Array.isArray(evidence)) {
    return [];
  }

  return evidence.map((item) => ({
    id: item.id,
    similarity: typeof item.similarity === "number" ? Number(item.similarity.toFixed(4)) : null,
    type: item.type ?? null,
    source: item.source ?? null,
    retrieval_role: item.retrieval_role ?? null,
    occurred_at: item.occurred_at ?? null,
    summary: item.summary ?? null,
    excerpt: item.excerpt ?? null,
    email_sender: item.email_sender ?? null,
    email_subject: item.email_subject ?? null,
    document_path: item.document_path ?? null,
    attachment_filename: item.attachment_filename ?? null,
  }));
}

function sanitizeBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "1"].includes(normalized)) {
      return true;
    }
    if (["false", "no", "0"].includes(normalized)) {
      return false;
    }
  }

  return false;
}

function resolveRetrievalRole(metadata, type) {
  if (typeof metadata.retrieval_role === "string" && metadata.retrieval_role.trim()) {
    return metadata.retrieval_role.trim();
  }

  return SOURCE_RETRIEVAL_TYPES.has(type) ? "source" : "distilled";
}

export function normalizeMetadata({ content, extracted = {}, metadata = {}, source, type, tags, occurredAt, extractionError }) {
  const resolvedType = type ?? metadata.type ?? extracted.type ?? "note";

  return {
    people: sanitizeStringList([...(metadata.people ?? []), ...(extracted.people ?? [])]),
    action_items: sanitizeStringList([...(metadata.action_items ?? []), ...(extracted.action_items ?? [])]),
    dates_mentioned: sanitizeStringList([
      ...(metadata.dates_mentioned ?? []),
      ...(extracted.dates_mentioned ?? []),
      ...(occurredAt ? [occurredAt] : []),
    ]),
    topics: sanitizeStringList([
      ...(metadata.topics ?? []),
      ...(extracted.topics ?? []),
      ...(Array.isArray(tags) ? tags : []),
    ]),
    tags: sanitizeStringList([...(metadata.tags ?? []), ...(Array.isArray(tags) ? tags : [])]),
    type: resolvedType,
    summary: metadata.summary ?? extracted.summary ?? truncateText(content, 280),
    source: source ?? metadata.source ?? extracted.source ?? "manual",
    retrieval_role: resolveRetrievalRole(metadata, resolvedType),
    occurred_at: occurredAt ?? metadata.occurred_at ?? null,
    user_metadata: metadata,
    ...(extractionError ? { metadata_extraction_error: extractionError } : {}),
  };
}

async function requestJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Request to ${url} failed with ${response.status}: ${message}`);
  }

  return response.json();
}

export async function createEmbedding(input) {
  const payload = {
    model: config.embeddingModel,
    input,
    dimensions: config.embeddingDimensions,
  };
  const response = await requestJson(`${config.embeddingBaseUrl}/embeddings`, payload);
  const embedding = response?.data?.[0]?.embedding;

  if (!Array.isArray(embedding)) {
    throw new Error("Embedding endpoint returned an invalid payload");
  }

  if (embedding.length !== config.expectedEmbeddingDimension) {
    throw new Error(
      `Expected ${config.expectedEmbeddingDimension} embedding dimensions, got ${embedding.length}`,
    );
  }

  return embedding;
}

export async function extractMetadata(content, source) {
  const response = await requestJson(`${config.llmBaseUrl}/chat/completions`, {
    model: config.llmModel,
    temperature: 0,
    max_tokens: config.metadataMaxTokens,
    chat_template_kwargs: {
      enable_thinking: config.llmEnableThinking,
    },
    tools: [metadataTool],
    tool_choice: "required",
    messages: [
      {
        role: "system",
        content: [
          "You extract structured metadata for a personal knowledge base.",
          "Use the provided tool to return structured metadata.",
          "Prefer empty arrays over invented values.",
          "Use null for source if unknown.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Content:\n${content}`,
          source ? `Declared source: ${source}` : "Declared source: none",
        ].join("\n\n"),
      },
    ],
  });

  const parsed = extractToolArguments(response, "submit_metadata");

  return {
    people: sanitizeStringList(parsed.people),
    action_items: sanitizeStringList(parsed.action_items),
    dates_mentioned: sanitizeStringList(parsed.dates_mentioned),
    topics: sanitizeStringList(parsed.topics),
    type: typeof parsed.type === "string" && parsed.type.trim() ? parsed.type.trim() : "note",
    summary: typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : truncateText(content, 280),
    source: typeof parsed.source === "string" && parsed.source.trim() ? parsed.source.trim() : null,
  };
}

export async function answerFromEvidence(question, evidence) {
  const response = await requestJson(`${config.llmBaseUrl}/chat/completions`, {
    model: config.llmModel,
    temperature: 0,
    max_tokens: config.answerMaxTokens,
    chat_template_kwargs: {
      enable_thinking: config.llmEnableThinking,
    },
    tools: [groundedAnswerTool],
    tool_choice: "required",
    messages: [
      {
        role: "system",
        content: [
          "You answer questions about a personal knowledge base using only the supplied evidence items.",
          "Do not infer missing facts, motives, purchases, or relationships that are not supported.",
          "If the evidence is partial, answer only the supported portion and mark the rest as missing.",
          "If the evidence does not support the question, say so plainly.",
          "Use only citation ids that appear in the evidence list.",
          "Never include chain-of-thought or internal reasoning.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Question:\n${question.trim()}`,
          `Evidence items:\n${JSON.stringify(sanitizeEvidenceItems(evidence), null, 2)}`,
        ].join("\n\n"),
      },
    ],
  });

  let parsed;
  try {
    parsed = extractToolArguments(response, "submit_grounded_answer");
  } catch (error) {
    const plainAnswer = normalizeChatContent(response?.choices?.[0]?.message?.content);
    if (plainAnswer) {
      return {
        answer: plainAnswer.trim(),
        grounded: false,
        insufficient_evidence: true,
        citations: [],
      };
    }
    throw error;
  }

  const evidenceIds = new Set(evidence.map((item) => item.id));
  const citations = sanitizeStringList(parsed.citations).filter((item) => evidenceIds.has(item));
  const grounded = sanitizeBoolean(parsed.grounded) && citations.length > 0;
  const insufficientEvidence = Boolean(parsed.insufficient_evidence) || !grounded;

  return {
    answer: typeof parsed.answer === "string" && parsed.answer.trim()
      ? parsed.answer.trim()
      : "I do not have enough evidence in memory to answer that reliably.",
    grounded,
    insufficient_evidence: insufficientEvidence,
    citations,
  };
}

export async function healthcheckUpstreams() {
  const [llmHealth, embeddingHealth] = await Promise.all([
    fetch(config.llmHealthUrl),
    fetch(config.embeddingHealthUrl),
  ]);

  if (!llmHealth.ok) {
    throw new Error(`LLM healthcheck failed with ${llmHealth.status}`);
  }

  if (!embeddingHealth.ok) {
    throw new Error(`Embedding healthcheck failed with ${embeddingHealth.status}`);
  }

  return {
    llm: await llmHealth.json(),
    embedding: await embeddingHealth.json(),
  };
}
