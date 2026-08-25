# 01 — IMAP: bound the retry loop and dead-letter what cannot be distilled

Status: needs-triage

## Summary

In `recipes/email-history-import/import-imap.py`, a message whose distillation
raises is never written to the sync log, so it is reprocessed on every
subsequent cycle. There is no attempt counter, no backoff and no terminal state.
One bad response wedges the mailbox indefinitely.

This is the amplifier behind the 2026-08-11 stall. Commit `689eef2` fixed the
error that was firing; it did not touch the mechanism that turned one error into
two weeks of downtime.

## Observed evidence

`ob1-imap-watch` on `m2maxstudio` failed every cycle from **2026-08-11 to
2026-08-25** — roughly **1,800 consecutive cycles**, each exiting 1 with:

```
ERROR UID <n>: distillation failed: Model did not return a tool call
```

The same UID was retried every cycle for fourteen days. Nothing was ingested
from that mailbox in that window. The daemon was running the whole time; it was
never crashed, restarted or alerted on (see issue `02`).

After the fix was deployed (master `260d610`, system-config `877ec7b`):

```
[2026-08-25T01:41:22Z] cycle=1 exit_code=0 elapsed_seconds=414.87
  distilled_thoughts=1
  attachment_summary_thoughts=3 (x3)
  failures=0
```

First `exit_code=0` since 2026-08-11.

## Mechanism

`recipes/email-history-import/import-imap.py`:

| Location | What it does |
| --- | --- |
| `:40` | `SYNC_LOG_PATH = RECIPE_DIR / "imap-sync-log.json"` |
| `:963-965` | `should_skip()` — a message is skipped only if it has a sync entry at the current schema version |
| `:1325-1338` | `try: distill_email_thoughts(record)` / `except Exception: message_failed = True; failures += 1; print(...); continue` |
| `:1355` | the sync-log write — **`continue` jumps past it** |

The `if not message_failed:` guard at `:1320` applies the same rule on the other
failure branches (`:1312`, `:1348`): **any** failed message is left unrecorded,
therefore retried forever.

The `continue` is deliberate — the intent was "fail loudly rather than silently
mark it done", which is right. The gap is that there is no third option between
*retry forever* and *record as successfully ingested*.

## Operational impact

- One undistillable message halts ingest for the whole mailbox; later messages in
  the same cycle are reached but the cycle never completes clean, and the failing
  UID is re-fetched and re-sent to the model on every pass.
- Each retry costs a full Docling + LLM round trip. ~1,800 cycles at ~7 minutes
  each is substantial wasted local inference.
- The blast radius is not bounded by the fix: `distill_email_thoughts` now
  rejects more response shapes than it used to (deliberately — see `689eef2`), so
  the *trigger surface* of this loop is wider than before, even though the
  specific trigger that fired has been removed.

## Acceptance criteria

- [ ] A message that fails distillation is retried a **bounded** number of times.
      The limit is configurable and has a documented default.
- [ ] Attempt count and last error are persisted per message, surviving daemon
      restarts. The sync log is the obvious home, but a failed message must be
      distinguishable from a successfully-ingested one — do **not** reuse
      `ingested_ids` in a way that makes `should_skip()` treat a failure as a
      success.
- [ ] On exceeding the limit the message moves to a terminal **dead-letter**
      state: it is no longer retried, and the record retains the UID, the dedupe
      key, the attempt count, the last error text and a timestamp.
- [ ] Dead-lettered messages are visible without reading logs — e.g. a count in
      the cycle summary line and a way to list them.
- [ ] A dead-lettered message can be explicitly requeued (a flag or a documented
      edit) once the underlying cause is fixed. Nothing is permanently lost.
- [ ] Backoff between retries, so a persistent failure does not consume a full
      Docling+LLM round trip every cycle.
- [ ] Regression test: a message that always raises is attempted N times, then
      dead-lettered, and is **not** attempted on the following cycle.
- [ ] Regression test: dead-lettering does not mark the message as ingested —
      `should_skip()` must not confuse the two states.
- [ ] The `NOTE:` comment at `:1327-1334` is updated or removed once this lands.

## Notes

- `tests/test_imap_import_llm_contract.py::ImapImportSyncLogProgressTests` already
  covers the sync-log progress path and is the natural place to extend.
- Consider whether the same treatment is needed for the other two
  `message_failed` branches (`:1312`, `:1348`) or only the distillation one.

## Comments
