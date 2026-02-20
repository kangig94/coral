#!/bin/bash
# SubagentStart hook: detect codex-* agents and inject delegation instructions.
# Reads SubagentStart event JSON from stdin.

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
AGENT_NAME=$(echo "$INPUT" | jq -r '.agent_name // .tool_input.name // ""')

# Check for "codex-" prefix (case-insensitive)
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
