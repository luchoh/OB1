# Sysadmin Handoff: Deploy `live-retrieval` Claude Code Skill

Date: 2026-06-01
Status: Awaiting system-config implementation
Owner: System-config / Claude Code provisioning
Companion: PRD `25-upstream-port-roadmap.md` §1.2

## Summary

Add a Nix-managed Claude Code skill named `live-retrieval` to user
`luchoh`'s `~/.claude/skills/` on every machine that runs Claude Code
against this Open Brain. The skill is a behavioral protocol — not a
service, not a daemon — and consists of three static files. No package
install, no service unit, no env. The deploy is purely "place these
three files at this path."

This skill is the "read side" of Open Brain: when Claude Code detects a
topic shift mid-conversation, it automatically calls
`search_thoughts` / `list_thoughts` MCP tools and surfaces relevant
thoughts as a brief in-line note. Silent on miss, brief on hit. No LLM
call beyond what Claude is already doing for the user's request.

## Source

Upstream `NateBJones-Projects/OB1`, branch `main`, path
`recipes/live-retrieval/`. The package ships three files:

- `README.md` — human prose; safe to omit from deploy if desired.
- `live-retrieval.skill.md` — the skill body (frontmatter + behavioral
  rules). This is what Claude Code reads.
- `metadata.json` — recipe-level metadata. Not consumed by Claude Code at
  runtime; safe to omit.

The only file Claude Code requires is the skill body. To match Claude
Code's `~/.claude/skills/<name>/SKILL.md` convention the file should be
renamed `SKILL.md` on copy.

Current verified content: ~80 lines of markdown. No code, no shell
commands, no template substitutions. Suitable to embed verbatim in the
Nix derivation source set.

## Target

Per machine, per user that runs Claude Code:

```
~/.claude/skills/live-retrieval/
├── SKILL.md
└── (optional) README.md
```

Owner `luchoh`, mode `0644` for files / `0755` for the directory. The
parent `~/.claude/skills/` already exists — many other skills are
present alongside (`acs-audit`, `acs-foreign-repo-operator`, `caveman`
symlink, `devenv-init`, etc.). Match whatever pattern those use.

## Runtime contract

- **Required MCP tools:** `search_thoughts`, `list_thoughts`. Both are
  exposed by our Node.js MCP server. The skill's prose references them
  by their unprefixed names; Claude Code resolves through whichever
  Open Brain connector is registered. No edit needed.
- **No env vars.** No secrets.
- **No service dependency** beyond the Open Brain MCP server already
  being connected to Claude Code.
- **No LLM call** beyond what Claude is already doing for the user.

## Source content

The canonical version lives in this repo's git history at
`upstream/main:recipes/live-retrieval/live-retrieval.skill.md`. Pin to
that path/revision in the Nix derivation rather than copying inline, so
upstream updates can be picked up via a SHA bump.

Reference command to fetch the file at any time:

```
git -C /path/to/OB1 show upstream/main:recipes/live-retrieval/live-retrieval.skill.md
```

## Versioning

Upstream's `metadata.json` declares `version: 1.0.0`. Bump
the system-config pin if upstream releases a 1.1.0+ that we want to pick
up.

## Test plan

After deploy, on a machine with Claude Code + Open Brain MCP connected:

1. Open a new Claude Code session.
2. Mention a topic that should hit our brain
   (e.g., "Let's revisit the Telegram review work").
3. Expected: a brief "OB1 context: …" prefix on Claude's first response,
   citing 1-3 thoughts from the brain.
4. Mention a deliberately unknown topic ("let's discuss the Esperanto
   parser") — expected: silence, no "I searched and found nothing"
   message.

If both behaviors observed, deploy is good.

## Out of scope

- Wholesale import of upstream's `recipes/live-retrieval/` directory
  into our repo. PRD-25 §1.2 originally assumed the skill landed during
  the Tier 0 skills tree import; that turned out to be wrong (upstream
  packs it under `recipes/`, not `skills/`). The repo-side fix would be
  to also import this single recipe into our `skills/` tree, but the
  ~/.claude/skills/ deploy is the operationally meaningful step and
  is the one we want Nix-managed.
- Other skills in upstream's `recipes/<*>/<*>.skill.md` form. There are
  none that we need today; if more appear, they follow the same
  pattern.
