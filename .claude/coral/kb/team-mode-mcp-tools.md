# Team Mode: MCP Tools Available in Teammates

## Rule
Teammates (subagents spawned via Agent tool with `team_name`) have full access to MCP tools including `coral_ax__*`, `coral_dc__*`, and `context-mode__*`. A `general-purpose` teammate sees all 42 tools (27 built-in + 7 context-mode + 6 coral_ax + 2 coral_dc). This works in tmux backend.

## Why
Previously MCP tool calls from teammates in tmux would fail, limiting team mode to built-in tools only. Knowing this works enables parallel workflows where teammates independently call Codex, Claude, context-mode, or discuss tools.

## Pattern
```
# Spawn a teammate that uses MCP tools
Agent(
  team_name: "my-team",
  name: "worker",
  subagent_type: "general-purpose",
  prompt: "Use coral_ax__codex to run this task..."
)
```

Verified: 2026-03-08, tmux backend, Claude Code with coral plugin.
