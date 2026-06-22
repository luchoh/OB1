// Pure unit tests for the /search response projection (no I/O, always run).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { projectSearchResults } from "../src/search-projection.mjs";

describe("projectSearchResults", () => {
  it("returns [] for missing / empty / non-array results", () => {
    assert.deepEqual(projectSearchResults(null), []);
    assert.deepEqual(projectSearchResults({}), []);
    assert.deepEqual(projectSearchResults({ results: null }), []);
    assert.deepEqual(projectSearchResults({ results: [] }), []);
  });

  it("projects to the compact { id, brain, score, title, summary } shape", () => {
    const full = {
      results: [
        {
          id: "t1",
          similarity: 0.876543,
          content: "[ChatGPT: Foo | 2025-01-01] some body text",
          brain_slug: "ob1",
          brain_id: "uuid-1",
          metadata: { summary: "A distilled summary.", user_metadata: { chatgpt_title: "Foo" } },
        },
      ],
    };
    assert.deepEqual(projectSearchResults(full), [
      { id: "t1", brain: "ob1", score: 0.8765, title: "Foo", summary: "A distilled summary." },
    ]);
  });

  it("rounds score to 4 dp and maps non-numeric similarity to null", () => {
    const r = projectSearchResults({ results: [{ id: "a", similarity: 0.12345 }, { id: "b", similarity: null }] });
    assert.equal(r[0].score, 0.1235);
    assert.equal(r[1].score, null);
  });

  it("derives title from chatgpt_title, then claude_title, then metadata.title, else null", () => {
    const mk = (md) => projectSearchResults({ results: [{ id: "x", metadata: md }] })[0].title;
    assert.equal(mk({ user_metadata: { chatgpt_title: "CG" } }), "CG");
    assert.equal(mk({ user_metadata: { claude_title: "CL" } }), "CL");
    assert.equal(mk({ title: "MD" }), "MD");
    assert.equal(mk({}), null);
    assert.equal(mk({ user_metadata: { claude_title: "CL" }, title: "MD" }), "CL"); // precedence
  });

  it("uses metadata.summary when present, else truncates content", () => {
    const withSummary = projectSearchResults({ results: [{ id: "x", metadata: { summary: "  S  " }, content: "long" }] })[0];
    assert.equal(withSummary.summary, "S"); // trimmed

    const long = "y".repeat(500);
    const noSummary = projectSearchResults({ results: [{ id: "x", content: long, metadata: {} }] })[0];
    assert.ok(noSummary.summary.length <= 201, "content summary is truncated to ~200 chars");
    assert.ok(noSummary.summary.endsWith("…"), "truncation marker present");

    const blankSummary = projectSearchResults({ results: [{ id: "x", metadata: { summary: "   " }, content: "fallback body" }] })[0];
    assert.equal(blankSummary.summary, "fallback body"); // blank summary falls back to content
  });

  it("brain prefers slug then id then null; tolerates missing fields", () => {
    assert.equal(projectSearchResults({ results: [{ id: "x", brain_slug: "s", brain_id: "i" }] })[0].brain, "s");
    assert.equal(projectSearchResults({ results: [{ id: "x", brain_id: "i" }] })[0].brain, "i");
    const bare = projectSearchResults({ results: [{}] })[0];
    assert.deepEqual(bare, { id: null, brain: null, score: null, title: null, summary: "" });
  });

  it("honors the limit (caller's match_count)", () => {
    const full = { results: Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, similarity: 0.9 })) };
    assert.equal(projectSearchResults(full, { limit: 4 }).length, 4);
    assert.equal(projectSearchResults(full).length, 10); // no limit -> all
  });
});
