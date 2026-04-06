# PRD: Telegram Thought Review Loop

Date: 2026-03-25
Status: Proposed
Owner: Platform / Capture Pipelines / UX

## Summary

Change Telegram-origin reporting from a terse ingest acknowledgment into a real review surface.

Today, Telegram replies like:

- `Thought recorded. Stored 1 source row and 3 thought rows.`

That confirms storage, but it does not let the user inspect the extracted thoughts before or during ingest.

The desired product behavior is:

- show the candidate thoughts in Telegram
- let the user approve, edit, or deny them
- optionally let the user view the raw textual entry that produced those thoughts
- use the same review model for:
  - direct Telegram text capture
  - Telegram-origin dictation artifacts that later report back into Telegram

This PRD makes Telegram a lightweight memory-review inbox, not just a success-notification channel.

## Problem

The current Telegram workflow has a visibility and control gap.

For Telegram text capture:

- the bridge summarizes the message
- extracts up to 3 thoughts
- auto-records the approved subset
- replies with a count-only status line

For Telegram-origin dictation import:

- the importer distills up to 3 thoughts from the transcript
- auto-records the approved subset
- replies with the same count-only status line

That means the user cannot do the thing that matters most at capture time:

- verify whether the extracted thoughts are actually right
- reject a bad thought without rejecting the whole capture path
- revise wording before it becomes durable memory
- inspect the originating raw text without going to another system

The current review path is also asymmetric:

- it only prompts on uncertainty, duplicates, or "no durable thought" cases
- when auto-approval succeeds, the user never sees the actual extracted thoughts

That is fine for a background pipeline.
It is weak for a personal memory tool where the user wants editorial control.

## Goals

- Show extracted candidate thoughts directly in Telegram for Telegram-origin captures.
- Support per-thought actions:
  - approve
  - edit
  - deny
- Support whole-capture actions:
  - approve all
  - deny all
  - commit selected thoughts
- Optionally expose the raw textual source that produced the thoughts.
- Keep the review flow compatible with both:
  - direct Telegram text capture
  - Telegram-origin dictation importer notifications
- Reuse the existing Telegram callback and review-state machinery where practical.
- Preserve idempotency and avoid partial double-ingest.

## Non-Goals

- Reviewing non-Telegram ingestion channels in Telegram
- Exposing raw audio bytes or audio playback controls in Telegram
- Full freeform multi-message editing UI
- Replacing the underlying novelty-review heuristic in this iteration
- Building a general-purpose moderation dashboard outside Telegram

## Current Behavior

Current Telegram review/reporting behavior in the repo:

- `integrations/telegram-capture/telegram_bridge.py`
  - on clean auto-approval, replies with a short count-only status
  - on uncertain or duplicate cases, sends a `Record` / `Ignore` prompt
- `recipes/dictation-import/import-dictation.py`
  - for Telegram-origin artifacts, also replies with a short count-only status
  - on uncertain or duplicate cases, also falls back to `Record` / `Ignore`
- `recipes/shared_telegram_review_state.py`
  - already provides persisted pending-action state for Telegram review flows

So the system already has:

- Telegram reply support
- inline callback handling
- persisted pending action state

What it does not yet have is:

- per-thought presentation
- per-thought approval state
- edit-in-place review sessions
- optional raw-source reveal

## Product Decision

### 1. Telegram review becomes a first-class approval loop

For Telegram-origin captures, Telegram should become the primary review surface, not just the final notifier.

When candidate thoughts exist, the bot should send a review message that includes:

- a short header
- the candidate thoughts, numbered
- the current decision state for each thought
- inline actions for approval/edit/deny
- whole-session actions for commit and deny-all
- an optional `View Raw` action

This should replace the current success-only message in the review-enabled mode.

### 2. Review should support both automatic and explicit modes

Add a Telegram review mode setting with at least:

- `exceptions_only`
  - current behavior
  - only prompt when the system is uncertain, duplicate-heavy, or extracted no durable thought
- `full`
  - always present extracted thoughts in Telegram and wait for human review before ingest

Recommended default for the owner's direct Telegram capture path:

- `full`

Reason:

- it matches the user's stated need for editorial control
- it avoids storing a wrong thought before the user sees it

Compatibility rule:

- `exceptions_only` must remain available for lower-friction operation

### 3. Ingest should happen only on explicit session completion in `full` mode

In `full` mode, extracted thoughts should not be written immediately.

Instead:

- the bridge or importer creates a pending review session
- the user approves, edits, or denies thoughts
- storage happens only when the user commits the reviewed set

This avoids awkward rollback semantics after the fact.

### 4. Raw-source view is optional and text-only

The raw view should reveal the textual source that produced the thought candidates:

- for direct text capture:
  - the original Telegram message text
- for Telegram-origin dictation:
  - the cleaned transcript or canonical source text used for thought extraction

It should not:

- expose raw audio bytes
- auto-post the raw text in every review message

Instead, it should be available behind an explicit `View Raw` action.

## Proposed UX

### Review message shape

Example:

```text
OB1 extracted 3 candidate thoughts from this Telegram capture.

1. I want to replace the office espresso machine next month.
   Status: pending

2. I prefer the Linea Micra over the Decent for home use.
   Status: pending

3. Budget target is under $4,500.
   Status: pending
```

Inline actions:

- per thought:
  - `Approve 1`
  - `Edit 1`
  - `Deny 1`
  - repeated for thoughts 2 and 3
- session-wide:
  - `Approve All`
  - `Commit`
  - `Deny All`
  - `View Raw`

### Edit flow

Telegram does not provide rich inline text editing for bot-created review rows.
So the edit interaction should be a small state machine:

1. user taps `Edit 2`
2. bot replies:
   - `Send the replacement text for thought 2.`
3. the replacement text must be sent as a direct reply to that bot-issued edit prompt
4. only that reply-to message is consumed as the edit payload
5. if the user sends a non-reply plain-text message instead, it is treated as a normal new Telegram capture, not as edit text
6. only one active edit target may exist per chat at a time
7. if the user taps `Edit` on another thought before finishing the first edit, the earlier edit target is cancelled and replaced explicitly
8. the review message is updated to show:
   - new text
   - status `edited`

This reply-to requirement is mandatory.
The implementation must not use "next plain-text message in chat" as the edit discriminator.

### Raw-source flow

When the user taps `View Raw`, the bot should reply with the raw textual source that produced the current thought set.

Rules:

- send it as a separate Telegram message, not embedded in every review card
- if the source exceeds Telegram-safe message length, truncate and clearly mark truncation
- preserve the pending review session after raw view

## Data And State Model

The current pending-action model stores:

- one source payload
- one list of thought payloads
- one action token

The review-loop design needs richer pending state, including:

- session id or action token
- source payload
- raw source preview or recoverable source text
- review origin:
  - `telegram_text`
  - `telegram_dictation`
- candidate thoughts with stable indexes
- per-thought review state:
  - `pending`
  - `approved`
  - `edited`
  - `denied`
- optional edited replacement text
- session mode:
  - `exceptions_only`
  - `full`
- whether raw view is enabled
- optional pending edit target:
  - `thought_index`
- optional active edit prompt message id
- for Telegram-origin dictation sessions:
  - importer artifact reference key
  - importer sync-log dedupe key
  - importer pending status handle

For `telegram_dictation` review sessions, the session state must carry enough information to update the dictation importer sync log when the review resolves.

The session must remain durable across bot restarts using the existing JSON-backed review state, unless or until that state store is formally replaced.

## Ingest Semantics

### Direct Telegram text capture

In `full` mode:

1. receive Telegram text message
2. extract candidate thoughts
3. send Telegram review message with candidate list
4. wait for user actions
5. on `Commit`:
   - ingest one source row
   - ingest only thoughts currently marked `approved` or `edited`
6. on `Deny All`:
   - ingest nothing

### Telegram-origin dictation artifact

In `full` mode:

1. dictation importer reads canonical artifact
2. extracts candidate thoughts
3. writes importer sync-log state as `review_pending`
4. sends Telegram review message back to the originating chat
5. waits for user actions
6. on `Commit`:
   - ingest one source row
   - ingest only thoughts currently marked `approved` or `edited`
   - move the importer sync-log entry from `review_pending` to `ingested`
7. on `Deny All`:
   - ingest nothing
   - move the importer sync-log entry from `review_pending` to `ignored`
8. on session expiry:
   - ingest nothing
   - move the importer sync-log entry from `review_pending` to `expired`

This sync-log transition is required.
The importer must not leave Telegram-origin dictation artifacts stranded in `review_pending` after commit, deny, or expiry.

### Zero-thought case

If no durable thoughts are extracted:

- keep the simpler `Record source anyway or ignore it?` path
- add optional `View Raw`

That is a separate UX from per-thought review because there are no candidate thoughts to moderate.

## Acceptance Criteria

1. For a direct Telegram text capture in review-enabled mode, the bot sends a review message containing the extracted candidate thoughts instead of only a count summary.
2. The user can approve one thought without approving all thoughts.
3. The user can deny one thought without denying the entire capture.
4. The user can edit one candidate thought and then commit the edited result.
5. The user can tap `View Raw` and see the source text that produced the candidates.
6. In `full` mode, no Telegram-origin thought rows are written before the user commits the review.
7. On commit, OB1 writes:
   - one source row
   - only the approved or edited thoughts
8. On deny-all, nothing is written.
9. The same interaction model works for:
   - direct Telegram text capture
   - Telegram-origin dictation importer review
10. Expired review sessions fail cleanly, tell the user the prompt expired, and move Telegram-origin dictation importer state out of `review_pending`.
11. Edit text is accepted only when the user replies directly to the active bot-issued edit prompt for that session.
12. A normal non-reply Telegram message sent while a review session is open is still treated as a new capture, not implicitly consumed as edit text.

## Risks

- Telegram inline keyboards can become busy if every thought gets three actions plus session-wide controls.
- Edit mode needs careful session routing so ordinary follow-up chat messages are not misinterpreted as edits.
- Raw-source view can leak more context than the concise thought list, so it should remain explicit and optional.
- `full` review mode adds friction and may slow capture compared with today's auto-record path.
- If source row ingest is coupled to commit, the system must ensure retries do not create duplicates after partial failures.

## Recommendation

Implement this as a new Telegram review mode rather than a hard replacement of the current flow.

Recommended rollout:

1. add the PRD-approved state model and review message format
2. implement `full` review mode for direct Telegram text capture
3. extend the same review surface to Telegram-origin dictation importer notifications
4. keep `exceptions_only` as the fallback compatibility mode

This is the smallest clean step that turns Telegram into a usable thought-review inbox instead of a blind success notifier.
