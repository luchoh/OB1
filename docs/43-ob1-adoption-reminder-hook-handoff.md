# Handover → system-config: OB1 adoption reminder hook

Date: 2026-06-16 (amended 2026-06-23 — code-verified preconditions added)
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

## Precondition: the reminder only works where OB1 is wired (verified in code)

A reminder to "use `search_thoughts`" is **noise in any harness that has no OB1
MCP server configured** — the tool isn't there. And the endpoint is **not
anonymous**: `/mcp` runs `resolveAccessContext` first and returns **401 without a
valid access key / human JWT** (auth.mjs:476-487). So per harness, system-config
must first confirm OB1 is configured *with a working credential* before wiring the
nudge; otherwise it points at a tool the agent cannot call.

Two more code-verified caveats for the grill:
- **Capture can 403 where search succeeds.** `capture_thought` needs write
  authorization — editor/owner or estate-admin (auth.mjs:571; access-policy.mjs:172-187).
  A viewer-scoped key can search but is **refused on capture**, so a *capture*
  reminder aimed at a read-only principal cannot be obeyed.
- **The credential IS the blast radius (the leak surface).** OB1 has no per-agent
  identity; it scopes by *principal/key*. An unscoped read fans out across **every
  brain that key's principal has membership to** (access-policy.mjs:402-415). A key
  with membership to a shared/common brain, placed in an untrusted harness, lets
  that agent read the common brain — hook or not. Mitigation is operational, not
  in the hook: mint **narrowly-scoped keys per harness** (a principal whose
  memberships = only the brains that agent should see), or a brain-level DENY row;
  never distribute a broad/common-brain key to a foreign harness.

## BEFORE implementing: /grill-me (the owner) on the EXACT hook

- **Timing (lean: AFTER, not before):** owner leans toward firing *after the work
  is done* (Claude/Codex `Stop` / session-end — "did you capture the durable
  findings?") rather than `UserPromptSubmit` (before the prompt — "search first").
  The reflex that actually lapsed this session was CAPTURE, not search.
- **Wording:** what the nudge says; search-reminder vs capture-reminder vs both.
- **Scope:** per-prompt vs per-session; which harness first.
- **Credential scope (security):** which harnesses get OB1 wired, and with what
  key-scope. The reminder is only *meaningful* where OB1 is configured and only
  *safe* where the key is narrowly scoped (see Precondition above).

Do not implement before that grill resolves the event + message.
