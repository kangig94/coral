---
paths:
  - "{agents,skills,hooks}/**/*"
---

# Plugin Extension Rules

## Agent Definitions

- Agent files in `agents/` use `<Agent_Prompt>` XML structure (see `.claude/templates/AGENT.md`)
- Agent names use kebab-case: `codex-proxy.md`, `discuss-lead.md`
- Codex delegation agents must have the `codex-` prefix for hook matcher detection
- Agent markdown is injected as protocol instructions — keep concise and actionable

## SKILL.md Requirements

- Every skill directory must contain a `SKILL.md` file
- Frontmatter fields: `name`, `description`, and optionally `argument-hint`
- Skill names in frontmatter must match the directory name
- Skills that spawn subagents must declare `subagent_type` in their protocol

## Cross-Reference Convention

When agent or skill files reference other coral plugin files, use path aliases to distinguish
plugin files from project files. Two patterns exist — never mix them:

| Pattern | Usage | Example |
|---------|-------|---------|
| `CORAL_AGENTS/xxx.md` | **Read** the file (Read/Glob tool) | `CORAL_AGENTS/scanner.md` |
| `CORAL_SKILLS/xxx/` | **Read** the file (Read/Glob tool) | `CORAL_SKILLS/plan/HOW-REVIEW.md` |
| `coral:xxx` | **Spawn** subagent (Task tool) | `coral:codex-proxy` |

- Every file using `CORAL_AGENTS` or `CORAL_SKILLS` must define them at the top (after frontmatter):
  ```
  > **CORAL_AGENTS**: `~/.claude/plugins/cache/coral/**/agents/` — locate via Glob
  > **CORAL_SKILLS**: `~/.claude/plugins/cache/coral/**/skills/` — locate via Glob
  ```
- Never use bare `agents/xxx.md` or `skills/xxx/` — these resolve relative to the user's
  project directory, which breaks when the plugin is used outside its own repo.
- `coral:xxx` references are for Task tool's `subagent_type` only — the framework resolves them.
  Do not use `coral:xxx` when the intent is to read a file.

## Hook Safety

- Hook scripts are Node.js ESM modules (`.mjs`) — no shell scripts
- `hooks.json` timeout values are in seconds (not milliseconds)
- Hook matchers use regex patterns: `"(^|:)codex-"` matches both `codex-*` and `coral:codex-*`
- Hook scripts must:
  - Read input from stdin (JSON event payload) using an async `readStdin()` helper
  - Exit 0 on no-op (condition does not match)
  - Write valid JSON to stdout when producing `hookSpecificOutput`
  - Never block on network calls or long-running operations
  - Wrap all logic in `try { ... } catch { process.exit(0); }` to fail-open

## Plugin.json Sync

- MCP tool declarations in `.claude-plugin/plugin.json` reference `.mcp.json` server config
- Agent declarations in plugin.json must match files in `agents/`
- Skill declarations must match directories in `skills/`
- When adding a new MCP tool: update server.ts, schemas.ts, and docs/mcp-tools.md

## Codex Delegation Pattern

```
SubagentStart hook fires
  -> detect-codex-agent.mjs reads event JSON from stdin
  -> extracts agent_name field
  -> if agent_name matches /(^|:)codex-/i:
       ensures ~/.codex/config.toml has multi_agent = true
       writes hookSpecificOutput to stdout with delegation instructions
  -> if no match: process.exit(0) (no-op)
```

The delegation instruction tells the agent to call `codex({ op: "exec", ... })` MCP tool immediately rather than generating its own response.
