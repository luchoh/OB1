// search-projection.mjs — pure projection of a search_thoughts response into a
// compact, retrieval-focused shape for programmatic callers (the auto-retrieve
// hook): { id, brain, score, title, summary }. No I/O, no config — kept in its
// own module so it is unit-testable without loading the server (Consul/DB).

function truncate(text, limit = 200) {
  if (typeof text !== "string") return "";
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

// full: the object returned by handleSearchThoughts ({ results: [...] , ... }).
// Title is best-effort — chat thoughts carry it in user_metadata; many thoughts
// have none -> null. Summary prefers the distilled metadata summary, else a
// content snippet.
export function projectSearchResults(full, { limit } = {}) {
  const rows = Array.isArray(full?.results) ? full.results : [];
  const sliced = typeof limit === "number" ? rows.slice(0, limit) : rows;
  return sliced.map((row) => {
    const metadata = row?.metadata ?? {};
    const userMetadata = metadata.user_metadata ?? {};
    const title =
      userMetadata.chatgpt_title ?? userMetadata.claude_title ?? metadata.title ?? null;
    const summary =
      typeof metadata.summary === "string" && metadata.summary.trim()
        ? metadata.summary.trim()
        : truncate(row?.content ?? "", 200);
    return {
      id: row?.id ?? null,
      brain: row?.brain_slug ?? row?.brain_id ?? null,
      score: typeof row?.similarity === "number" ? Math.round(row.similarity * 1e4) / 1e4 : null,
      title,
      summary,
    };
  });
}
