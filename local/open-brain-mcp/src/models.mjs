import { config } from "./config.mjs";

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

function sanitizeStringList(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [...new Set(values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean))];
}

export function normalizeMetadata({ content, extracted = {}, metadata = {}, source, type, tags, occurredAt, extractionError }) {
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
    type: type ?? metadata.type ?? extracted.type ?? "note",
    summary: metadata.summary ?? extracted.summary ?? truncateText(content, 280),
    source: source ?? metadata.source ?? extracted.source ?? "manual",
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
    messages: [
      {
        role: "system",
        content: [
          "You extract structured metadata for a personal knowledge base.",
          "Return only valid JSON.",
          "The JSON object must contain exactly these keys:",
          "people, action_items, dates_mentioned, topics, type, summary, source.",
          "Use arrays of strings for people, action_items, dates_mentioned, and topics.",
          "Use a short string for type and summary.",
          "Use null for source if unknown.",
          "Do not include markdown, commentary, or reasoning.",
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

  const message = response?.choices?.[0]?.message?.content;
  const parsed = extractJsonPayload(normalizeChatContent(message));

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
