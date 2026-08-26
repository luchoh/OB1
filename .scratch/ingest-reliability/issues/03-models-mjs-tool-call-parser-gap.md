# 03 — `models.mjs` has no content fallback, so metadata extraction degrades silently

Status: needs-triage

## Summary

`extractToolArguments` in `local/open-brain-mcp/src/models.mjs` assumes the model
returns a tool call. It has no fallback for an answer delivered in
`message.content`.

This is the same defect that stalled `ob1-imap-watch` for two weeks, in the MCP
server rather than a recipe. It does not stall here — it degrades. Thoughts are
still captured, but with no extracted metadata and a
`metadata_extraction_error` field recording why.

## Mechanism

`local/open-brain-mcp/src/models.mjs:134`:

```js
function extractToolArguments(response, expectedName) {
  const toolCalls = response?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    const inlineToolArgs = extractInlineToolArguments(..., expectedName);
    if (inlineToolArgs) return inlineToolArgs;
    throw new Error("Model did not return a tool call");
  }
  ...
}
```

It tries `tool_calls`, then inline `<function=...>` markup, then throws. The
measured breach shape — `finish_reason: "stop"`, no `tool_calls`, a valid JSON
object in `message.content` — hits the `throw`.

For contrast, `recipes/shared_docling.py::extract_tool_arguments` **does** have
that fallback, which is exactly why the imap fix worked.

### The two call sites behave differently

| Call site | Behaviour on throw |
| --- | --- |
| `:344` `submit_metadata` | Rejection is caught by `Promise.allSettled` in `server.mjs:434`, passed to `normalizeMetadata` as `extractionError`, and stored on the row as `metadata_extraction_error` (`models.mjs:271`). The thought is captured; its metadata is empty. |
| `:400` `submit_grounded_answer` | Already has its own `try`/`catch` that falls back to plain content with `grounded: false, insufficient_evidence: true`. |

So `submit_grounded_answer` is already handled. **`submit_metadata` is the gap.**

## Operational impact

When this fires, the captured thought gets:

- empty `people`, `action_items`, `dates_mentioned`, `topics`
- `summary` falling back to `truncateText(content, 280)` rather than a real summary
- `type` defaulting to `"note"`

The row is stored and readable, so nothing is lost outright — but it is
permanently less findable, and nothing reprocesses it. Because capture succeeds,
there is no failure signal at the call site; the only trace is the
`metadata_extraction_error` field on the row itself.

Severity is lower than issues `01` and `02` — degraded, not stalled, and not
silent at the row level. But it is unbounded in time and accumulating.

## Unknowns for triage

- **How many prod rows are affected?** Not yet measured. A count of thoughts
  carrying `metadata_extraction_error` in the prod DB, and the distribution of
  error strings, should come before deciding effort. The value may be small.
- Whether the same shape is worth fixing in the five recipes that keep **local**
  copies of the parser rather than importing the shared one:
  `recipes/prompt-autoresearch.py`, `recipes/code-autoresearch.py`,
  `recipes/claim_typing.py`, `recipes/chatgpt-conversation-import/import-chatgpt.py`,
  `recipes/claude-conversation-import/import-claude.py`. Consolidating them onto
  one parser may be the better answer than fixing five copies — that is a
  separate decision and should not be smuggled into this issue.

## Acceptance criteria

- [ ] `extractToolArguments` accepts a content-only response whose content is a
      valid JSON object, matching the behaviour of
      `recipes/shared_docling.py::extract_tool_arguments`.
- [ ] Callers whose result is **irreversible** do not scrape a JSON object out of
      surrounding prose. `submit_metadata` writes a row that nothing reprocesses,
      so it should require content that is JSON end to end — the same distinction
      the imap fix draws via `scrape_content=False`.
- [ ] `submit_grounded_answer`'s existing fallback still works and is not made
      stricter by this change; it is a read path and can be retried.
- [ ] A count of existing prod rows carrying `metadata_extraction_error` is
      recorded in this issue before the fix is scoped.
- [ ] A decision is recorded on whether affected rows are backfilled or left as
      they are. Either is acceptable; leaving it undecided is not.
- [ ] Regression tests covering: a normal tool call, a content-only JSON response,
      and a prose response that must still be refused.
- [ ] `docs/08-vllm-mlx-no-thinking.md` recommendation 6 is checked against the
      final behaviour, since it now describes the Python side only.

## Provenance

Found by the grok reviewer pane during review of the imap fix, while looking
outside the scope it was given. Verified independently against the source before
filing: the missing fallback at `models.mjs:134`, the `Promise.allSettled` catch
at `server.mjs:434-455`, and the `metadata_extraction_error` write at
`models.mjs:271`.

## Comments
