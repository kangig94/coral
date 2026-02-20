---
paths:
  - "{agents,skills,hooks}/**/*"
---

# Plugin Extension Rules

## Agent Definitions

- Agent files in `agents/` follow the template structure in `.claude/agents/TEMPLATE.md`
- Agent names use kebab-case: `codex-delegate.md`, `codex-architect.md`
- Codex delegation agents must have the `codex-` prefix for hook matcher detection
- Agent markdown is injected as protocol instructions -- keep concise and actionable

## SKILL.md Requirements

- Every skill directory must contain a `SKILL.md` file
- Frontmatter fields: `name`, `description`, and optionally `arguments`
- Skill names in frontmatter must match the directory name
- Arguments use the format: `name: "argname" description: "..." required: true/false`
- Skills that spawn subagents must declare `subagent_type` in their protocol

## Hook Safety

- Hook scripts execute on Claude Code lifecycle events with strict timeouts
- `hooks.json` timeout values are in seconds (not milliseconds)
- Hook matchers use regex patterns: `"(^|:)codex-"` matches both `codex-*` and `coral:codex-*`
- Hook scripts must:
  - Read input from stdin (JSON event payload)
  - Exit 0 on no-op (agent name does not match)
  - Output valid JSON to stdout when producing `hookSpecificOutput`
  - Never block on network calls or long-running operations
  - Use POSIX-portable constructs: `sed`, `grep` (no `-P`), `cat`, `mktemp`

## Plugin.json Sync

- MCP tool declarations in `.claude-plugin/plugin.json` must match `tools` array in `src/mcp/server.ts`
- Agent declarations in plugin.json must match files in `agents/`
- Skill declarations must match directories in `skills/`
- When adding a new MCP tool: update server.ts, schemas.ts, plugin.json, and docs/mcp-tools.md

## Codex Delegation Pattern

```
SubagentStart hook fires
  -> detect-codex-agent.sh reads event JSON from stdin
  -> extracts agent_name field
  -> if agent_name matches "codex-" prefix:
       ensures ~/.codex/config.toml has multi_agent = true
       outputs hookSpecificOutput with delegation instructions
  -> if no match: exit 0 (no-op)
```

The delegation instruction tells the agent to call `codex_session_create` MCP tool immediately rather than generating its own response.
