# OB1 Adoption — Cross-Harness Reflexive-Use Plan (proposal + handover)

Date: 2026-06-15
Status: PROPOSAL — OB1-side pieces buildable now; per-harness wiring is a system-config handover
Owner: OB1 (MCP server instructions + shared hook script); System-config (per-harness wiring)
Companion: AGENTS.md "Brain Protocol", docs/39 (PRD, Package 3 shelved)

## Why this is the priority

Every downstream question about OB1 — dedup (Package 3), retrieval-quality tuning
(the Qwen instruction-prefix) — is **unmeasurable until agents actually use the
brain**, and today they don't, consistently. You can't judge or calibrate
retrieval on a brain nothing reads. So adoption is the root of the tree;
Package 3 and retrieval tuning are deferred as premature until usage exists.

The dogfooding reflex we wrote this session lives only in OB1's own `AGENTS.md` —
i.e. it conditions an agent *working inside the OB1 repo*, which is not where the
brain gets used. The reflex has to reach **every agent context, every harness**.

## Mechanism per harness (researched, not assumed)

| Harness | Auto-retrieve hook? | Mechanism |
|---|---|---|
| **Claude Code** | YES | `UserPromptSubmit` hook returns `additionalContext` → injected into the turn |
| **Codex CLI 0.139** | **YES — identical to Claude** | `UserPromptSubmit` hook (PR #14626), returns `hookSpecificOutput.additionalContext`; `type="command"` runs arbitrary shell |
| **pi / lpi** | **NO — by design** | "Local Pi" forbids "Disallowed Prompt Injection"; reflex must be a tool/extension + instruction the agent *chooses* to call |

The key finding: **Claude and Codex share the exact same hook contract**
(`UserPromptSubmit` → command → `additionalContext`), so **one hook script serves
both**. pi is the user's own hardened fork that deliberately rejects auto-injected
context, so there the reflex is a capability (an OB1 extension) plus instruction,
not a forced inject.

## Architecture

Four layers, strongest to softest:

1. **Shared retrieve-hook (Claude + Codex):** one script, two harness configs.
   On every prompt it searches OB1 with the prompt as query and injects the top
   hits as `additionalContext`, so the agent *starts each task already holding
   the relevant memory* — zero discipline required. This is the load-bearing
   layer (instructions alone demonstrably under-fire — see this session).
2. **OB1 MCP server `instructions` (best-effort hint — NOT universal):** the MCP
   `initialize` response can carry an `instructions` string (settable in
   `server.mjs`, one line). But per the MCP spec this is an *optional hint* a
   client *MAY* surface to the model — the server only **offers** it; it cannot
   make any client use it. Coverage is **client-dependent and unverified** (we do
   not know which of Claude Code / Codex / ChatGPT / Claude Desktop inject server
   instructions). So this is a free, cheap backstop, NOT a reliable mechanism and
   NOT relied upon. The reliable layer is the hook (#1), because the harness
   enforces it client-side rather than hoping the client honors a server hint.
3. **pi extension + instruction:** an OB1 tool pi can call, plus a line in pi's
   instructions; respects pi's no-auto-inject principle.
4. **Capture side (soft, all harnesses):** the search-before / capture-after
   text in each harness's instruction surface (global `CLAUDE.md`,
   `~/.codex/AGENTS.md`, pi context); optionally a `Stop`/`SessionEnd` hook on
   Claude + Codex that nudges capture of durable findings.

## Boundary: what OB1 can and cannot do

OB1 **cannot make any agent consult it.** A server answers requests; it does not
drive clients. OB1's only contributions to adoption are passive: (1) **hint** —
the optional MCP `instructions` field (a client may ignore it); (2) **be
callable** — expose `search_thoughts`, and optionally ship a convenience script a
hook can invoke. The actual *enforcement* — running something on every prompt —
is a **harness hook** that lives in Claude/Codex config and is owned entirely by
system-config. **Adoption is a harness-configuration job, not an OB1 feature.**
The OB1-side items below are enablers for that job, not the job itself.

## In OB1's write scope (buildable now — proposal)

**A. MCP server `instructions` field** — `local/open-brain-mcp/src/server.mjs`.
Pass `{ instructions: "…" }` as the second arg to `new McpServer(...)` (currently
absent at `server.mjs:847`; SDK support verified at `server/index.js:50,279`).
The hint: "This is the OB1 memory. Before non-trivial work, `search_thoughts`.
Capture durable findings (decisions, calibrations, incident root-causes) with
`capture_thought` and a stable dedupe_key. Don't capture scratch." It is returned
in the `initialize` response — but a client surfaces it to the model only if it
chooses to (optional per spec). Cheap and free; do not count on it reaching every
client. **Worth verifying** which of our clients actually inject server
instructions before assigning it any weight.

**B. Shared retrieve-hook script** — `local/open-brain-mcp/scripts/ob1-retrieve-hook.sh`
(canonical artifact; harnesses reference it at the managed checkout path).
Contract:
- Reads the hook event JSON on stdin (Claude + Codex both provide the prompt).
- Calls OB1 `search_thoughts` (HTTP/MCP) with the prompt as the query, brain-
  scoped to the session's principal, `match_count` ~4.
- **Fail-open and signal-only:** if OB1 is unreachable, or no thought clears a
  relevance floor (e.g. similarity ≥ 0.7), emit empty output → no injection, no
  block. Never delays or blocks the prompt.
- On hits, emits `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit",
  "additionalContext":"<compact top-N: title + 1-line summary + id>"}}` — capped
  to keep per-turn context cost small.
- Same stdout contract works verbatim for Claude and Codex.

## System-config handover (operator — read-only for OB1 agents)

1. **Claude Code** — add a `UserPromptSubmit` hook in the managed `settings.json`
   pointing at the shared script (managed checkout path).
2. **Codex CLI** — enable hooks (`[features] hooks = true`) and register the same
   script as a `UserPromptSubmit` command hook. Push it as a **managed hook via
   `requirements.toml`** so it is policy-trusted (no per-hook manual trust) and
   uniform across sessions. Use the **user-level** `~/.codex/` location (repo-local
   hooks have a known non-fire bug in interactive sessions, issue #17532).
3. **pi / lpi** — package an OB1 retrieve/capture **extension** (pi's TS extension
   API) + a line in pi's instruction/context. (Confirm whether pi should speak
   MCP or call OB1 over HTTP — pi shows no MCP config today.)
4. **Global instruction propagation (capture side)** — put the search-before /
   capture-after reflex in the global `CLAUDE.md` and `~/.codex/AGENTS.md` that
   system-config manages, so the soft layer covers all sessions, not just the
   OB1 repo.

## Caveats (from research)

- **Context budget:** injecting on every prompt costs tokens each turn — hence
  the relevance floor + top-N cap + compact format. Tune N down if noisy.
- **Query quality:** the raw prompt as the search query can be noisy; acceptable
  for v1 (fail-open, signal-only), refine later.
- **Codex bug #15266:** `SessionStart` + `UserPromptSubmit` both fire on the
  first prompt — only register `UserPromptSubmit` to avoid double-fire.
- **Codex `PreToolUse.additionalContext`** is rejected in practice (#19385) —
  irrelevant to us (we use `UserPromptSubmit`), noted to avoid that trap.
- **pi principle:** auto-injection is out of scope by design; do not try to force
  it — use the extension+instruction path unless you decide to relax the rule.

## Open decisions for the owner

1. **pi:** extension + instruction (respecting the no-inject principle), or relax
   the principle to allow a retrieve-inject in your own harness?
2. **Capture automation:** soft instruction only, or also a `Stop`-hook nudge on
   Claude + Codex?
3. **Build order:** shall OB1 build (A) MCP instructions and (B) the shared hook
   script now, so the handover has concrete artifacts to wire?
