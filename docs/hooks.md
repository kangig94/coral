# Hooks

Two hooks provide automatic context injection and agent routing.

## Overview

Claude Code's hook system executes shell scripts on specific events. Coral uses two hooks:

1. **SessionStart** — Injects CLAUDE.md behavioral guidelines into every Claude session
2. **SubagentStart** — Injects delegation instructions into agents with a `codex-` prefix (with or without `coral:` namespace)

## Hook Configuration

**File**: `hooks/hooks.json`

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "cat \"${CLAUDE_PLUGIN_ROOT}/CLAUDE.md\"",
            "timeout": 3
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "matcher": "(^|:)codex-",
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

## SessionStart Hook

Injects the plugin's CLAUDE.md content into Claude's context at the start of every session. This ensures Claude always receives the behavioral guidelines (Simplicity First, Surgical Changes, etc.) and KB system instructions.

### Configuration Fields

| Field | Value | Description |
|---|---|---|
| `SessionStart` | | Event fired when a Claude session starts |
| `matcher` | `"*"` | Matches all sessions |
| `type` | `"command"` | Execute a shell command |
| `command` | `cat "${CLAUDE_PLUGIN_ROOT}/CLAUDE.md"` | Outputs CLAUDE.md content (stdout is injected as context) |
| `timeout` | `3` | 3-second timeout |

> **Note**: Codex sessions receive CLAUDE.md through a separate mechanism — the MCP server prepends it to the prompt in `executeOneShot()`. See [Core Modules](./core-modules.md) for details.

## SubagentStart Hook

### Configuration Fields

| Field | Value | Description |
|---|---|---|
| `SubagentStart` | | Event fired when an agent starts |
| `matcher` | `"(^|:)codex-"` | Execute hook for agents with `codex-` prefix (bare or namespaced, e.g., `coral:codex-architect`) |
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

# Check for "codex-" prefix (case-insensitive, with optional namespace prefix)
if echo "$AGENT_NAME" | grep -qiE '(^|:)codex-'; then
  # Ensure multi_agent feature is enabled in Codex config
  CODEX_CONFIG="$HOME/.codex/config.toml"
  if [ ! -f "$CODEX_CONFIG" ]; then
    mkdir -p "$HOME/.codex"
    printf '[features]\nmulti_agent = true\n' > "$CODEX_CONFIG"
  elif ! grep -q 'multi_agent' "$CODEX_CONFIG"; then
    if grep -q '^\[features\]' "$CODEX_CONFIG"; then
      sed -i '/^\[features\]/a multi_agent = true' "$CODEX_CONFIG"
    else
      printf '\n[features]\nmulti_agent = true\n' >> "$CODEX_CONFIG"
    fi
  fi

  jq -n '{
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext: "Codex delegation context: You are a Codex delegation agent. You MUST use the appropriate Codex MCP tool (codex_session_create or codex_session_send) to forward ALL work to Codex CLI. Do NOT generate your own response in place of calling Codex. Call the MCP tool immediately with the full task."
    }
  }'
else
  exit 0
fi
```

### Execution Flow

```
1. SubagentStart event fires (matcher: "(^|:)codex-")
2. Event JSON received via stdin
   e.g.: {"agent_name": "codex-architect", "task": "..."}
3. Check if jq is installed (if not, exit 0 — skip silently)
4. Extract agent_name with jq
   - .agent_name field takes priority
   - Falls back to .tool_input.name
5. Check for "codex-" prefix (case-insensitive, supports `coral:codex-*` namespace)
6a. Match found → output hookSpecificOutput JSON
    → Claude Code injects additionalContext into the agent
6b. No match → exit 0 (no output, terminate silently)
    → Hook ignored, agent runs normally
```

### Injected Context

```
Codex delegation context: You are a Codex delegation agent. You MUST use
the appropriate Codex MCP tool (codex_session_create or codex_session_send)
to forward ALL work to Codex CLI. Do NOT generate your own response in
place of calling Codex. Call the MCP tool immediately with the full task.
```

This message is appended to the agent's system prompt, forcing the agent to call the Codex MCP tool.

## Dependencies

- `jq` — Required for JSON parsing (hook skips silently if missing)
- `grep` — Used for pattern matching

## Notes

- Script must have execute permission (`chmod +x`)
- If the 5-second timeout is exceeded, the hook is ignored and the agent runs normally
- Invalid JSON output from the hook is ignored
- Agents without the `codex-` prefix (bare or namespaced) are filtered out at the matcher stage
