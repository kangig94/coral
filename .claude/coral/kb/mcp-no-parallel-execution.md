# MCP Tools Cannot Execute in Parallel Within a Single Agent

## Rule
Claude Code prevents a single agent from executing multiple MCP tool calls simultaneously. To parallelize MCP-dependent work (e.g., multiple Codex calls), spawn separate subagents — each makes its own independent MCP call.

## Why
MCP tool calls are serialized within an agent's context. Attempting to call the same MCP tool in parallel from one agent results in sequential execution, negating the performance benefit. This is a Claude Code platform constraint, not an MCP protocol limitation.

## Pattern
```
# exec returns instantly (job_id), but wait() is still a blocking MCP call.
# A single agent calling wait on multiple jobs blocks sequentially per call.

# Sequential (within one agent — each wait blocks until done):
for group in file_groups:
    result = codex({ op: "exec", prompt: group })  # instant return
    codex({ op: "wait", job_ids: [result.job_id] })  # blocks here

# Truly parallel (each subagent handles its own exec+wait):
for group in file_groups:
    Task(subagent_type: "coral:codex-proxy", prompt: group)
```

For non-Codex parallel work (Claude-native), use `subagent_type: "general-purpose"` — these also get independent MCP access.
