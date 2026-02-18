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
      additionalContext: "Codex delegation context: You are a Codex delegation agent. You MUST use mcp__coral__codex_execute to forward ALL work to Codex CLI. Do NOT generate your own response. Call the MCP tool immediately with the full task."
    }
  }'
else
  exit 0
fi
