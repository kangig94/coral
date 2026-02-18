# Hooks

Automatic routing of Codex agents via the SubagentStart hook.

## Overview

Claude Code's hook system executes shell scripts on specific events. Coral intercepts the `SubagentStart` event and injects delegation instructions into agents with a `codex-*` prefix.

## Hook Configuration

**File**: `hooks/hooks.json`

```json
{
  "hooks": {
    "SubagentStart": [
      {
        "matcher": "codex-.*",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/detect-codex-agent.sh",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

### Configuration Fields

| Field | Value | Description |
|---|---|---|
| `SubagentStart` | | Event fired when an agent starts |
| `matcher` | `"codex-.*"` | Only execute hook for agents starting with `codex-` |
| `type` | `"command"` | Execute a shell command |
| `command` | `${CLAUDE_PLUGIN_ROOT}/hooks/detect-codex-agent.sh` | Detection script path (`CLAUDE_PLUGIN_ROOT` is auto-replaced with plugin root) |
| `timeout` | `5` | 5-second timeout (hook is ignored if exceeded) |

## Detection Script

**File**: `hooks/detect-codex-agent.sh`

```bash
#!/bin/bash
# SubagentStart hook: detect codex-* agents and inject delegation instructions.
# Reads SubagentStart event JSON from stdin.

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
AGENT_NAME=$(echo "$INPUT" | jq -r '.agent_name // .tool_input.name // ""')

# Check for "codex-" prefix (case-insensitive)
if echo "$AGENT_NAME" | grep -qi '^codex-'; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext: "Codex delegation context: You are a Codex delegation agent. You MUST use mcp__cx__codex_execute to forward ALL work to Codex CLI. Do NOT generate your own response. Call the MCP tool immediately with the full task."
    }
  }'
else
  exit 0
fi
```

### Execution Flow

```
1. SubagentStart event fires (matcher: "codex-.*")
2. Event JSON received via stdin
   e.g.: {"agent_name": "codex-delegate", "task": "..."}
3. Check if jq is installed (if not, exit 0 — skip silently)
4. Extract agent_name with jq
   - .agent_name field takes priority
   - Falls back to .tool_input.name
5. Check for "codex-" prefix (case-insensitive)
6a. Match found → output hookSpecificOutput JSON
    → Claude Code injects additionalContext into the agent
6b. No match → exit 0 (no output, terminate silently)
    → Hook ignored, agent runs normally
```

### Injected Context

```
Codex delegation context: You are a Codex delegation agent. You MUST use
mcp__cx__codex_execute to forward ALL work to Codex CLI. Do NOT
generate your own response. Call the MCP tool immediately with the full task.
```

This message is appended to the agent's system prompt, forcing the agent to call the Codex MCP tool.

## Dependencies

- `jq` — Required for JSON parsing (hook skips silently if missing)
- `grep` — Used for pattern matching

## Notes

- Script must have execute permission (`chmod +x`)
- If the 5-second timeout is exceeded, the hook is ignored and the agent runs normally
- Invalid JSON output from the hook is ignored
- Agents without the `codex-` prefix are filtered out at the matcher stage
