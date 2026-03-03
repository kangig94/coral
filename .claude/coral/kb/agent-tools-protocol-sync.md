# Agent Tools List Must Stay in Sync with Protocol

## Rule
When updating an agent's protocol to perform new actions requiring tools (e.g., adding a `Read` step), you must also update the `tools:` line in the agent's frontmatter. The protocol and tools list are separate and do not auto-sync — the protocol tells the agent what to do, but the framework enforces which tools the agent can actually call.

## Why
If the protocol says "Read(session_dir + '/result.md')" but `Read` is not in the `tools:` frontmatter, the agent silently cannot execute that step. The agent receives instructions it cannot follow, leading to failure or workaround behavior. This is a common oversight when refactoring agent protocols to add new I/O steps.

## Pattern
```yaml
# Before (protocol says only Glob + codex):
---
tools: Glob, mcp__plugin_coral_ax__codex
---
<Agent_Prompt>
  ... exec → show response directly from MCP response ...
</Agent_Prompt>

# After (protocol now requires reading result files):
---
tools: Read, Glob, mcp__plugin_coral_ax__codex   ← add Read here
---
<Agent_Prompt>
  ... exec → wait → Read(session_dir/result.md) → show response ...
</Agent_Prompt>
```

The tools list is the agent's capability boundary. Protocol changes that cross tool boundaries require both the protocol text AND the tools list to be updated together.
