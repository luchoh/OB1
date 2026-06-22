# Handover → system-config: OB1 adoption reminder hook

Date: 2026-06-16
Status: DECISION + handover — grill the owner before implementing
Companion: docs/42 (superseded exploration), branch `parking/http-search-route`

## Decision

The OB1 adoption hook **REMINDS** the agent to use OB1; it does **not** retrieve.
The agent does the actual `search_thoughts` itself via the MCP tool it already
has — better queries, full context, no new surface. A `UserPromptSubmit` hook's
output is injected as `additionalContext` the model sees, so a one-way nudge is
enough to guide it.

We **rejected** the design where the hook curls OB1 and injects results — that
needed a new HTTP `/search` route. That implementation (route + MCP `instructions`
hint + tests, verified/critiqued SAFE) is parked on `parking/http-search-route`
in case hook-side retrieval is ever wanted. **OB1 ships nothing for adoption.**

## What system-config owns

A trivial reminder hook for **Claude Code AND Codex** (both expose the events).
It calls nothing, can't fail, needs no auth — it just injects a short nudge.

## BEFORE implementing: /grill-me (the owner) on the EXACT hook

- **Timing (lean: AFTER, not before):** owner leans toward firing *after the work
  is done* (Claude/Codex `Stop` / session-end — "did you capture the durable
  findings?") rather than `UserPromptSubmit` (before the prompt — "search first").
  The reflex that actually lapsed this session was CAPTURE, not search.
- **Wording:** what the nudge says; search-reminder vs capture-reminder vs both.
- **Scope:** per-prompt vs per-session; which harness first.

Do not implement before that grill resolves the event + message.
