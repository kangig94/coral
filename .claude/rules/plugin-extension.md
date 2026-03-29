---
paths:
  - "{agents,skills,hooks,methods}/**/*"
---

# Plugin Extension Rules

## Agent Definitions

- Agent files in `agents/` use `<Agent_Prompt>` XML structure (see `skills/init-project/templates/agents/AGENT.md.template`)
- Agent names use kebab-case: `architect.md`, `persona-generator.md`
- Agent markdown is injected as protocol instructions — keep concise and actionable

## SKILL.md Requirements

- Every skill directory must contain a `SKILL.md` file
- Frontmatter fields: `name`, `description`, and optionally `argument-hint`
- Skill names in frontmatter must match the directory name
- Skills that spawn subagents must declare `subagent_type` in their protocol

## Cross-Reference Convention

When agent or skill files reference other coral plugin files, use path aliases to distinguish
plugin files from project files. Two read patterns and one spawn pattern exist — never mix them:

| Pattern | Usage | Example |
|---------|-------|---------|
| `CORAL_METHODS/xxx.md` | **Read** the file (Read/Glob tool) | `CORAL_METHODS/HOW-REVIEW.md` |
| `CORAL_PROJECT` | **Read/write** project-local data | `CORAL_PROJECT/plans/`, `CORAL_PROJECT/memo/` |
| `coral:xxx` | **Spawn** subagent (Agent tool) | `coral:scanner` |

- **Skills**: `coral-skill-vars.mjs` hook injects CORAL_PROJECT and CORAL_METHODS
  as additionalContext on UserPromptSubmit and PreToolUse(Skill).
- **Agents**: spawned via `Agent({ subagent_type: "coral:<name>" })` or `codex({ op: "coral:<name>" })`.
  The framework resolves agent files — do not read agent files directly from skills.
- `coral:xxx` references are for Agent tool's `subagent_type` only — the framework resolves them.
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
