---
paths:
  - "{agents,skills,hooks,methods}/**/*"
---

# Plugin Extension Rules

## Agent Definitions

- Agent files in `agents/` use `<Agent_Prompt>` XML structure (see `.claude/templates/AGENT.md`)
- Agent names use kebab-case: `architect.md`, `discuss-lead.md`
- Agent markdown is injected as protocol instructions — keep concise and actionable

## SKILL.md Requirements

- Every skill directory must contain a `SKILL.md` file
- Frontmatter fields: `name`, `description`, and optionally `argument-hint`
- Skill names in frontmatter must match the directory name
- Skills that spawn subagents must declare `subagent_type` in their protocol

## Cross-Reference Convention

When agent or skill files reference other coral plugin files, use path aliases to distinguish
plugin files from project files. Three read patterns and one spawn pattern exist — never mix them:

| Pattern | Usage | Example |
|---------|-------|---------|
| `CORAL_AGENTS/xxx.md` | **Read** the file (Read/Glob tool) | `CORAL_AGENTS/scanner.md` |
| `CORAL_SKILLS/xxx/` | **Read** the file (Read/Glob tool) | `CORAL_SKILLS/plan/SKILL.md` |
| `CORAL_METHODS/xxx.md` | **Read** the file (Read/Glob tool) | `CORAL_METHODS/HOW-REVIEW.md` |
| `coral:xxx` | **Spawn** subagent (Task tool) | `coral:scanner` |

- Every file using these aliases must define them at the top (after frontmatter):
  ```
  > **CORAL_AGENTS**: `Bash("echo ~/.claude/plugins/cache/coral/coral/*/agents/")`
  > **CORAL_SKILLS**: `Bash("echo ~/.claude/plugins/cache/coral/coral/*/skills/")`
  > **CORAL_METHODS**: `Bash("echo ~/.claude/plugins/cache/coral/coral/*/methods/")`
  ```
- Never use bare `agents/xxx.md`, `skills/xxx/`, or `methods/xxx.md` — these resolve relative
  to the user's project directory, which breaks when the plugin is used outside its own repo.
- `coral:xxx` references are for Task tool's `subagent_type` only — the framework resolves them.
  Do not use `coral:xxx` when the intent is to read a file.

## Hook Safety

- Hook scripts are Node.js ESM modules (`.mjs`) — no shell scripts
- `hooks.json` timeout values are in seconds (not milliseconds)
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
Caller invokes codex MCP:
  -> codex({ op: "coral:<agent>", prompt, ... })
  -> server validates op with coralAgentSchema
  -> server reads agents/<agent>.md
  -> server prepends agent content to prompt
  -> launchJob(handleSessionCreate/handleSessionSend) → { job, ... }
  -> wait({ jobs: [job] }) → result.content ?? Read(result.path)
```

`ensureMultiAgent()` runs in `codex-executor.ts` before Codex spawn. No SubagentStart hook is involved in Codex delegation.
