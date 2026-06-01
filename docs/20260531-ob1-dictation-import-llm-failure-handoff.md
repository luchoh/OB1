# OB1 Dictation Import Failure Handoff

This handoff is for the custodian of the `OB1` repo.

I am the custodian of `system-config`, not `OB1`. I traced a live prod failure far enough to prove the remaining blocker is in `OB1` importer code, then stopped short of trying to own that repo end to end.

## What Happened

The original prod Telegram voice-note failure had two stages:

1. `system-config` / infra failures
   - `ob1-telegram-bridge` could not write to MinIO raw-audio storage because MinIO bucket policies were missing `s3:ListBucket`.
   - `ob1-dictation-import` could not read canonical dictation artifacts for the same reason.
   - MinIO had also been running with stale/default creds until the managed config was rebuilt correctly.

2. After the infra fix, an `OB1` app failure remained
   - Telegram finally replied:
     - `Accepted audio capture. Uploaded to object storage and queued for transcription.`
   - But the note still did not appear in OB1.
   - The remaining crash is in `recipes/dictation-import/import-dictation.py`.

## Live Failure Verified

On `m2maxstudio`, `/var/log/ob1-dictation-import/server.log` shows the importer crash-looping on the LLM thought-extraction step:

```text
ValueError: Model did not return a tool call
```

More specifically:

- `summarize_dictation(...)` calls the local chat-completions model with tool calling.
- `extract_tool_arguments(...)` raises because the model response has no `choices[0].message.tool_calls`.
- `process_artifact(...)` calls `summarize_dictation(...)` before `ingest_row(...)`.
- Result: the importer dies before writing even the source row to OB1.

Relevant code path in `OB1`:

- [recipes/dictation-import/import-dictation.py](/Users/luchoh/Dev/OB1/recipes/dictation-import/import-dictation.py)
- [recipes/shared_docling.py](/Users/luchoh/Dev/OB1/recipes/shared_docling.py)
- existing tests:
  - [tests/test_telegram_review_workflow.py](/Users/luchoh/Dev/OB1/tests/test_telegram_review_workflow.py)
  - [tests/test_shared_docling.py](/Users/luchoh/Dev/OB1/tests/test_shared_docling.py)

## Why This Is An OB1 Bug

This is not an infra failure anymore.

The user’s note is already past Telegram and dictation. The failing policy is inside `OB1` importer logic:

- if automatic thought extraction fails,
- `OB1` currently throws away the whole import attempt,
- even though the source transcript itself is valid and already available.

That is the wrong failure mode.

For dictation imports, the durable minimum should be:

- ingest the source row,
- write `0` thought rows if thought extraction is unavailable,
- do not lose the note just because a local summarizer returned malformed tool-call output.

## What Changed In OB1

The `OB1` patch now exists locally and on the remote branch.

`OB1` branch:

- `feature/retrieval-observability`

Relevant `OB1` commits:

- `16f729a`
- `0a1bf22`
- `a992fdd9b695a9c46669e56e20ba7fa7735b8d68`
- `01be000`

Patch summary:

1. In `recipes/dictation-import/import-dictation.py`
   - added a source-only fallback path for dictation imports when `summarize_dictation(...)` raises
   - catch around the thought-extraction call inside `process_artifact(...)`
   - fallback behavior:
     - ingest the source row
     - write `0` thought rows
     - mark the artifact as processed
     - for Telegram-origin captures, send a status reply noting source-only import

2. In `recipes/shared_docling.py`
   - hardened `extract_tool_arguments(...)`
   - still accepts normal `message.tool_calls[*].function.arguments`
   - now also accepts structured output when the model puts it in `message.content` instead:
     - inline tool markup such as `<function=submit_thoughts>...`
     - raw JSON content such as `{"thoughts": [...]}`
   - this addresses the production failure mode where the model appears to return usable structured content without formal `tool_calls`

3. In `tests/test_telegram_review_workflow.py`
   - added a regression test covering:
     - thought extraction raises `ValueError("Model did not return a tool call")`
     - importer still ingests one `dictation_note` source row
     - no Telegram review prompt is requested
     - sync log is marked `ingested`

4. In `tests/test_shared_docling.py`
   - added regression tests covering parser fallback when:
     - `tool_calls` is absent but `message.content` contains inline tool markup
     - `tool_calls` is absent but `message.content` contains valid JSON

5. In `recipes/dictation-import/import-dictation.py`
   - changed dictation extraction and novelty-review requests to use `tool_choice: "required"` instead of the named-function object form
   - changed both structured extraction calls to `temperature: 0` to match the known-good extraction contract used by the other importers
   - this targets the production oMLX compatibility mismatch where dictation import was using a different request shape from the working chat/email importers

6. In `tests/test_dictation_import_llm_contract.py`
   - added regression tests proving the dictation importer now sends the same structured-output contract as the known-good importers:
     - `tool_choice: "required"`
     - `temperature: 0`

## What I Verified

Local syntax check:

```bash
python3 - <<PY
import ast, pathlib
for path in [
    pathlib.Path("/Users/luchoh/Dev/OB1/recipes/dictation-import/import-dictation.py"),
    pathlib.Path("/Users/luchoh/Dev/OB1/recipes/shared_docling.py"),
    pathlib.Path("/Users/luchoh/Dev/OB1/tests/test_telegram_review_workflow.py"),
    pathlib.Path("/Users/luchoh/Dev/OB1/tests/test_shared_docling.py"),
]:
    ast.parse(path.read_text())
    print(path)
PY
```

Targeted test run using an interpreter that actually had the recipe deps:

```bash
/nix/store/akhdp29pchjkdijrj3q9qrl9yhl3z3xi-python3-3.12.12-env/bin/python3 -m unittest tests.test_telegram_review_workflow
```

Observed result:

```text
Ran 9 tests in 0.178s
OK
```

The new test emitted the expected warning for the source-only fallback path.

Follow-up verification in the default local interpreter:

```bash
python3 -m unittest tests.test_dictation_import_llm_contract tests.test_shared_docling tests.test_telegram_review_workflow
python3 -m py_compile \
  recipes/shared_docling.py \
  recipes/dictation-import/import-dictation.py \
  tests/test_dictation_import_llm_contract.py \
  tests/test_shared_docling.py \
  tests/test_telegram_review_workflow.py
```

Observed result:

```text
Ran 13 tests in 0.096s
OK
```

Exact artifact replay against the May 31 production note:

```bash
direnv exec . /nix/store/akhdp29pchjkdijrj3q9qrl9yhl3z3xi-python3-3.12.12-env/bin/python3 \
  recipes/dictation-import/import-dictation.py \
  --object-key 'canonical/2026/05/31/93365bb6397cea3b3badbeb7d8408e3612027efaf630af05fae0c8c836cf82d6.md' \
  --sync-log-file /tmp/ob1-dictation-replay-sync.json \
  --verbose --dry-run
```

Observed result:

```text
Warning: automatic thought extraction failed for So here is an interesting idea I had. So there was a situation when I was absolu; ingesting source row only: Model did not return a tool call
Imported So here is an interesting idea I had. So there was a situation when I was absolu -> 0 thoughts
{
  "processed": 1,
  "skipped": 0,
  "reconciled": 0
}
```

Meaning:

- the exact production artifact reproduces locally
- dedupe is no longer the blocker once the artifact is replayed with a fresh sync log
- `16f729a` and `0a1bf22` are not sufficient for this real note
- the remaining defect is still in OB1 extraction compatibility with the actual oMLX response shape

DeepSeek retry against the same exact artifact:

```bash
direnv exec . env LLM_MODEL='DeepSeek-V4-Flash-nvfp4' /nix/store/akhdp29pchjkdijrj3q9qrl9yhl3z3xi-python3-3.12.12-env/bin/python3 \
  recipes/dictation-import/import-dictation.py \
  --object-key 'canonical/2026/05/31/93365bb6397cea3b3badbeb7d8408e3612027efaf630af05fae0c8c836cf82d6.md' \
  --sync-log-file /tmp/ob1-dictation-replay-sync-deepseek.json \
  --verbose --dry-run
```

Observed result:

```text
Review required for So here is an interesting idea I had. So there was a situation when I was absolu (review)
{
  "processed": 1,
  "skipped": 0,
  "reconciled": 0
}
```

Meaning:

- with `LLM_MODEL=DeepSeek-V4-Flash-nvfp4`, the exact same artifact no longer falls into the source-only fallback path
- extraction progressed far enough to enter the Telegram review workflow
- this is strong evidence that the remaining failure was model-specific compatibility with the old Qwen/oMLX path, not the artifact content itself
- the managed replay path on `m2maxstudio` should now use the same exact artifact replay with a fresh sync log under the deployed DeepSeek model

## What Was Completed After This Handoff Was Written

The branch was completed, pushed, and promoted to `main`.

Remote branch:

- `origin/feature/retrieval-observability`
- `origin/main`

State:

- `feature/retrieval-observability` now tracks `origin/feature/retrieval-observability`
- the request-contract fix commit `16f729a` is pushed
- the parser-hardening commit `0a1bf22` is pushed
- the importer fix commit `a992fdd9b695a9c46669e56e20ba7fa7735b8d68` is pushed
- the follow-up test hardening commit `01be000` is also pushed
- the Telegram callback hardening commit `dc45dfe` is pushed
- the document-feed / oMLX-defaults / verifier-fix commit `5a441f0` is pushed
- `origin/main` was fast-forwarded to `5a441f021bdadb96492365502394db0fd721bde3`

## Current User-Facing State

As of the last verification:

- Telegram bridge accepted the voice note.
- Dictation accepted the object-backed note.
- The pushed `OB1` fixes through `16f729a` still failed on the exact May 31 artifact under the old Qwen/oMLX path.
- The same exact artifact now reaches `review_required` when replayed with `LLM_MODEL=DeepSeek-V4-Flash-nvfp4`.
- The exact stuck May 31 note is now confirmed in production OB1.

What happened after the DeepSeek replay:

- The managed DeepSeek replay on `m2maxstudio` created a Telegram full-review session for the exact artifact:
  - artifact: `canonical/2026/05/31/93365bb6397cea3b3badbeb7d8408e3612027efaf630af05fae0c8c836cf82d6.md`
  - pending review token: `524caa8684773556`
  - source dedupe key: `dictation:7faaf9fb59908ef291df019f60f46e64ca79c43116bc12ffd3b7d1282ee480eb`
- Both extracted thoughts were already present in review state with `status: "approved"`.
- The user pressed `Approve` / `Approve All` / `Commit`, but the note still did not land through the normal Telegram callback path.
- Bridge logs did **not** show a handled callback for this exact source key, while the same period showed repeated Telegram `400` failures on `editMessageText`.
- The likely remaining `OB1` bug is in [`integrations/telegram-capture/telegram_bridge.py`](/Users/luchoh/Dev/OB1/integrations/telegram-capture/telegram_bridge.py):
  - `approve`, `deny`, and `approve_all` call `refresh_review_message(...)` inside the locked review-state write path
  - `commit` also calls `edit_message(...)` before returning
  - if Telegram rejects `editMessageText`, the callback path can abort mid-action instead of treating UI refresh as best-effort
- I manually finalized the exact pending review in production using the same ingest-and-resolve logic as the `commit` branch.
- Production ingest result for the stuck May 31 note:
  - source row confirmed with dedupe key `dictation:7faaf9fb59908ef291df019f60f46e64ca79c43116bc12ffd3b7d1282ee480eb`
  - thought row confirmed with dedupe key `dictation:7faaf9fb59908ef291df019f60f46e64ca79c43116bc12ffd3b7d1282ee480eb:thought:0`
  - thought row confirmed with dedupe key `dictation:7faaf9fb59908ef291df019f60f46e64ca79c43116bc12ffd3b7d1282ee480eb:thought:1`
- The pending Telegram review token is gone.
- Caveat: `/usr/local/var/ob1-dictation-import/dictation-sync-log.json` still shows the historical `thought_count: 0` entry for this artifact, so that sync log is not currently a reliable source of truth for final thought count after manual Telegram review resolution.

Important deployment detail:

- deploying only `a992fdd9b695a9c46669e56e20ba7fa7735b8d68` and `01be000` preserves the source row on extraction failure
- deploying `0a1bf22` adds parser fallback when useful structured output is returned in `message.content`
- deploying `16f729a` aligns dictation import with the known-good oMLX extraction contract already used by the other working importers
- with the old Qwen/oMLX path, even all of the above still reproduced `ValueError: Model did not return a tool call` on the exact May 31 artifact
- after the managed `LLM_MODEL` switch to `DeepSeek-V4-Flash-nvfp4`, the exact artifact replay no longer reproduces the source-only fallback in local dry-run replay
- runtime confirmation on `m2maxstudio` is now complete for the exact stuck artifact
- the remaining Telegram review callback defect was fixed in `dc45dfe`
- OB1 defaults and operator docs now match production reality:
  - runtime: oMLX
  - Consul compatibility service name: `mlx-server`
  - default LLM model: `DeepSeek-V4-Flash-nvfp4`
- the verifier now lets caller-provided endpoint and token env vars override stale `.env.open-brain-local` values

Important operational detail:

- the importer sync log still retains the historical May 31 entry with `thought_count: 0`, even though the exact note has now been manually finalized into prod
- resending the same audio does not create a new test because Telegram/MinIO dedupe maps it back to the same artifact and audio hash; replay or manual requeue is required for the exact same note
- for the exact stuck May 31 note, that manual replay/finalize has now already been done and the thought rows are in prod

## System-Config Deployment Request

`system-config` should now update the managed OB1 runtime pin to `origin/main` at or after:

- `5a441f021bdadb96492365502394db0fd721bde3`

That revision contains all runtime code needed by `system-config`:

- source-row preservation on dictation thought-extraction failure
- oMLX-compatible required-tool dictation extraction
- parser fallbacks for inline/JSON structured model content
- Telegram full-review callback hardening when Telegram message edits fail
- DeepSeek/oMLX-aligned OB1 defaults and verifier docs

Expected `system-config` action:

1. Update the managed OB1 source revision from the current `16f729a...` pin to `5a441f021bdadb96492365502394db0fd721bde3` or newer `origin/main`.
2. Rebuild/restart the managed OB1 services on `m2maxstudio`.
3. Confirm `/usr/local/lib/ob1-managed/stable/current/.ob1-managed-revision` reports the new revision.
4. Confirm the active wrappers still export:
   - `LLM_MODEL="DeepSeek-V4-Flash-nvfp4"`
   - `OPEN_BRAIN_LLM_SERVICE_NAME="mlx-server"`
5. Run a production Telegram review-flow check where Telegram `editMessageText` failure does not prevent the durable approve/commit action.

Verification already completed in OB1 before promotion:

```bash
python3 -m unittest tests.test_dictation_import_llm_contract tests.test_shared_docling tests.test_telegram_review_workflow tests.test_document_import_state
npm run check
bash -n scripts/verify-open-brain-local.sh scripts/import-open-brain-documents.sh
git diff --check
env \
  LLM_BASE_URL=https://mlx.lincoln.luchoh.net/v1 \
  LLM_HEALTH_URL=https://mlx.lincoln.luchoh.net/health \
  LLM_MODEL=DeepSeek-V4-Flash-nvfp4 \
  EMBEDDING_BASE_URL=https://ob1-embedding.lincoln.luchoh.net/v1 \
  EMBEDDING_HEALTH_URL=https://ob1-embedding.lincoln.luchoh.net/health \
  DOCLING_BASE_URL=https://docling.lincoln.luchoh.net \
  DOCLING_HEALTH_URL=https://docling.lincoln.luchoh.net/health \
  ./scripts/verify-open-brain-local.sh
```

Observed live verifier result:

- oMLX health passed with default model `DeepSeek-V4-Flash-nvfp4`
- embedding health passed with `1536` dimensions
- Docling health passed
- Consul passing checks succeeded for `mlx-server`, `ob1-embedding`, `docling`, and `neo4j-enterprise`
- PostgreSQL schema checks passed
- Neo4j graph health check passed
- final line: `Verification passed.`

Remaining non-blocking follow-up:

- Investigate the bookkeeping gap where `/usr/local/var/ob1-dictation-import/dictation-sync-log.json` retained the historical `thought_count: 0` entry for the manually finalized May 31 artifact.

## Minimal Acceptance Criteria

After `system-config` deploys the new OB1 revision:

1. `ob1-dictation-import` no longer crash-loops on missing tool calls.
2. A dictation artifact with broken thought extraction still stores its `dictation_note` source row.
3. A dictation artifact where the model omits formal `tool_calls` but returns usable inline or JSON structured content still produces `dictation_thought` rows.
4. The exact artifact `canonical/2026/05/31/93365bb6397cea3b3badbeb7d8408e3612027efaf630af05fae0c8c836cf82d6.md` no longer falls into the source-only fallback path when replayed with `LLM_MODEL=DeepSeek-V4-Flash-nvfp4`.
5. The managed replay of that exact artifact creates review state or produces `dictation_thought` rows, depending on Telegram review mode.
6. The Telegram full-review callback path still commits approved thoughts even when Telegram rejects `editMessageText`.
7. A dictation artifact sent through the production DeepSeek path still produces `dictation_thought` rows when it contains at least one durable fact, task, or decision.
8. The stuck May 31 Telegram note lands in OB1 without requiring resend.

## Post-Deploy Review UX Bug (2026-06-01)

After `system-config` deployed managed `OB1` `main` and `m2maxstudio` was rebuilt onto:

- branch: `main`
- revision: `d93042d36947e914376310447e3835f7ac11a7b4`
- worker model: `DeepSeek-V4-Flash-nvfp4`

The end-to-end dictation path recovered far enough to create a real Telegram full-review session for a fresh production voice note:

- artifact id: `fffd3f30c16c0a8293d9a9f38f29ae8ca5d6a10d4d84a9c9097f5981a376ae88`
- object key: `canonical/2026/06/01/fffd3f30c16c0a8293d9a9f38f29ae8ca5d6a10d4d84a9c9097f5981a376ae88.md`
- source dedupe key: `dictation:3bb9b3d5c381166362e99b24c0c0438fe42fffca1e19067f67bb8680fbd88d43`

That session exposed a new OB1-side review-resolution bug.

### Exact repro

The Telegram review proposed 2 candidate thoughts.

The user then tapped, in order:

1. `Deny 1`
2. `Deny 2`
3. `Commit`

Observed bridge callback log in `/var/log/ob1-telegram-bridge/server.log`:

```text
{"update_id": 261883667, "handled": true, "path": "callback", "decision": "denied", "review_kind": "review", "source_dedupe_key": "dictation:3bb9b3d5c381166362e99b24c0c0438fe42fffca1e19067f67bb8680fbd88d43", "thought_count": 2, "telegram_user_id": 8795344081}
{"update_id": 261883668, "handled": true, "path": "callback", "decision": "denied", "review_kind": "review", "source_dedupe_key": "dictation:3bb9b3d5c381166362e99b24c0c0438fe42fffca1e19067f67bb8680fbd88d43", "thought_count": 2, "telegram_user_id": 8795344081}
{"update_id": 261883669, "handled": true, "path": "callback", "decision": "commit_blocked", "reason": "no_approved_thoughts"}
```

Persisted review state after those taps in `/usr/local/var/ob1-telegram-bridge/telegram-review-state.json`:

- the session is still present under `pending_actions`
- both candidate thoughts have `status: "denied"`
- no resolution was recorded
- the review prompt remains pending instead of resolving cleanly

### Why this is wrong

This is not a Telegram delivery problem and not a `system-config` problem.

The callbacks were handled.

The actual bug is in OB1 review semantics:

- denying every thought individually leaves the session with zero approved thoughts
- pressing `Commit` after that does not finalize the review
- instead it returns `commit_blocked` with `reason=no_approved_thoughts`
- the session stays stranded in `pending_actions`

Current code path in `integrations/telegram-capture/telegram_bridge.py`:

- `action == "commit"` calls `approved_session_payloads(pending)`
- if that returns empty, it only acknowledges:
  - `No approved thoughts to commit.`
- then returns:
  - `{"decision": "commit_blocked", "reason": "no_approved_thoughts"}`
- it does **not** record an ignored resolution
- it does **not** clear the pending review session

### Expected behavior

If all candidate thoughts have been denied individually, the review should resolve the same way as an explicit `Deny All`, or otherwise provide a first-class finalization path that does not strand the session.

At minimum, one of these needs to happen when `Commit` is pressed with zero approved thoughts and all thoughts denied:

1. treat it as `deny_all`
2. record a terminal ignored resolution and clear the pending session
3. or present a distinct explicit finalization action for “commit source, keep 0 thoughts” if that is the intended product behavior

What should **not** happen is the current behavior where every per-thought deny is accepted, but the final review never resolves.

### Scope note

This bug is downstream of the original importer/tool-call failure.

The important good news is:

- managed `OB1 main` + DeepSeek recovered the production path far enough to generate and persist a Telegram full-review session
- the remaining issue here is now specifically the review-resolution semantics after per-thought denies

### Suggested acceptance check for OB1 custodian

For a Telegram full-review session with 2 candidate thoughts:

1. deny thought 1
2. deny thought 2
3. press `Commit`

Expected result:

- session reaches a terminal resolved state
- pending review is removed
- importer resolution becomes `ignored` or equivalent terminal state
- Telegram UI reflects the final outcome instead of remaining effectively stuck

### OB1 hotfix resolution

OB1 now handles this exact path in `integrations/telegram-capture/telegram_bridge.py`:

- `Commit` with zero approved thoughts and every candidate thought already `denied` records an `ignored` resolution.
- The pending review action is removed.
- The callback result is `decision: "commit_ignored"` with `reason: "all_thoughts_denied"`.
- The existing `Deny All` path and the new all-denied `Commit` path share the same ignored-finalization helper.
- `Commit` with zero approved thoughts but still-pending candidates remains blocked as `commit_blocked`; that is still an undecided review, not a terminal ignore.

Regression coverage was added in `tests/test_telegram_review_workflow.py` for the production sequence:

1. `Deny 1`
2. `Deny 2`
3. `Commit`

Expected deployment action for `system-config`:

- deploy `origin/main` at or after `6056c65f8d260ee85124b2681e17a3406da2c75e`
- restart `ob1-telegram-bridge`
- retry the same review flow or any fresh two-thought review with both thoughts denied before commit
