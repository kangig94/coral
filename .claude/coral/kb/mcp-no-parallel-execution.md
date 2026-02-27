# MCP Tools Cannot Execute in Parallel Within a Single Agent

## Rule
Claude Code prevents a single agent from executing multiple MCP tool calls simultaneously. To parallelize MCP-dependent work (e.g., multiple Codex calls), spawn separate subagents — each makes its own independent MCP call.

## Why
MCP tool calls are serialized within an agent's context. Attempting to call the same MCP tool in parallel from one agent results in sequential execution, negating the performance benefit. This is a Claude Code platform constraint, not an MCP protocol limitation.

## Pattern
```
# WRONG: Single agent calling codex MCP tool in a loop (sequential)
for group in file_groups:
    codex({ op: "exec", prompt: group })  # waits for each to finish

# RIGHT: Spawn parallel subagents, each with its own MCP call
for group in file_groups:
    Task(subagent_type: "coral:codex-proxy", prompt: group)  # truly parallel
```

For non-Codex parallel work (Claude-native), use `subagent_type: "general-purpose"` — these also get independent MCP access.
