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
