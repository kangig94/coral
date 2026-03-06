# Claude Agent SDK Bundle Size and Tool Boundary

## Rule
`@anthropic-ai/claude-agent-sdk` wraps the entire Claude Code runtime (~80MB) — it is not a lightweight API client. Agent SDK sessions also lack access to Claude Code-specific tools (`Agent` for subagent spawning) and MCP servers (coral's `ax` tools). CLI spawn (`claude -p`) with `--resume` remains the only practical integration path for bundled plugins that need full Claude Code capabilities.

## Why
Without this knowledge, you might attempt to use Agent SDK for coral protocol execution (preplan, plan, discuss) or try to bundle it into the `bridge/` output. SDK sessions cannot run protocols that use `Agent("coral:architect")` or `mcp__plugin_coral_ax__codex()`. The 1000x size disparity vs Codex SDK (~70KB) also makes bundling infeasible.

## Pattern
```
# Wrong: Agent SDK for coral protocols
import { Agent } from '@anthropic-ai/claude-agent-sdk';
// Missing: Agent subagent tool, MCP servers, hooks

# Right: CLI spawn for full environment
spawn('claude', ['-p', '--resume', sessionId, '--output-format', 'json']);
// Inherits: all tools, MCP servers, hooks, plugins
```

| Capability | Agent SDK Session | CLI Spawn |
|------------|------------------|-----------|
| Claude Code tools (Agent, Read, Edit) | No | Yes |
| MCP servers (coral ax/dc) | No | Yes |
| Hooks | No | Yes |
| Bundle size | ~80MB | N/A (system binary) |
| Use case | Simple interactive conversation | Full protocol execution |
