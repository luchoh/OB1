---
name: ob1-autodream-brain-sync
description: |
  Syncs Claude Code's local memory system to Open Brain. Triggers whenever memories are
  saved via dreaming, autodream, or explicit "remember this" requests. After every local
  memory file write, captures the same content to Open Brain via mcp__ob1__capture_thought
  so that memories are accessible from all connected AI clients (ChatGPT, Claude Desktop,
  Codex) and across all devices. Trigger on: memory saves, autodream, dreaming, "remember",
  "save to memory", or any write to the .claude/projects/*/memory/ directory.
author: rumbitopi
version: 1.1.0
---

# Autodream Brain Sync

## Problem

Claude Code's auto-memory system (dreaming/autodream) saves memories to local files under `.claude/projects/*/memory/`. These files are only accessible to Claude Code on the same machine. If you use multiple AI clients (ChatGPT, Claude Desktop, Codex) or multiple devices, those memories are invisible to your other sessions.

## Trigger Conditions

- Any write to a memory file in `.claude/projects/*/memory/` (excluding `MEMORY.md` index)
- User says "remember this", "save to memory", "dream", "autodream"
- End-of-session memory saves (auto-dreaming)
- Explicit `/memory` command usage

## Process

1. Write the memory to its local file as normal (following the standard memory system format with frontmatter)
2. Update `MEMORY.md` index as normal
3. **Choose the destination brain** (Open Brain agent-estate routing). The
   capture tool accepts an optional `brain` argument (slug or UUID); the memory
   type is the routing signal:
   - `[project]` memories (specific to one codebase/repo) → **omit `brain`**; it
     defaults to the repo brain.
   - `[user]`, `[feedback]`, `[reference]` memories about tools, techniques, or
     cross-project operator preferences → pass **`brain="agent-common"`** so
     every repo agent can recall them.
   - When unsure, omit `brain` (repo brain). The common brain is curated.
4. **Immediately after each memory file write**, call `mcp__ob1__capture_thought` with the memory content
   - Use the memory content (not the frontmatter) as the thought
   - Prefix with the memory type in brackets for context, e.g. `[feedback] Don't mock the database in integration tests`
   - Set `brain` per step 3 (omit for `[project]`; `agent-common` for cross-cutting)
   - If the memory references a specific project, include the project name

## Output

Each memory save produces:
- A local `.md` file in the memory directory (standard behavior)
- An updated `MEMORY.md` index (standard behavior)
- A corresponding Open Brain thought capture (added by this skill), or — if the capture failed — a visible failure notice in the session output

## Guard Rails

- **Do not capture the MEMORY.md index file itself** — it's just pointers, not content
- **Do not duplicate** — if updating an existing memory file, capture the updated version (Open Brain handles dedup via embeddings)
- **Fail loudly, never silently** — if `mcp__ob1__capture_thought` is unavailable or the call fails (tool name does not resolve, MCP server down, network or auth error), complete the local memory save anyway, then **report the failure to the user in the session output**. State what failed, the error, and which memory did not sync. Do not merely "note" it internally: a sync that failed silently went unnoticed for five weeks.
- **Confirm the capture landed** — treat the capture as done only if the tool returns success. A call that errors or returns nothing is a failure and must be reported per the rule above.
- **Respect memory exclusions** — if the standard memory system says "don't save this", don't capture to Open Brain either

## Notes for Other Clients

This skill is specific to Claude Code's auto-memory system. Other clients don't have local memory files, so they capture directly to Open Brain without needing this sync step. The skill ensures Claude Code's local memories don't become an isolated silo.
