#!/bin/sh
# SubagentStart hook: detect codex-* agents and inject delegation instructions.
# Reads SubagentStart event JSON from stdin. No external dependencies, POSIX-portable.

INPUT=$(cat)

# Extract agent_name from JSON (POSIX-safe, no grep -P)
AGENT_NAME=$(echo "$INPUT" | sed -n 's/.*"agent_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -z "$AGENT_NAME" ] && AGENT_NAME=$(echo "$INPUT" | sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -z "$AGENT_NAME" ] && exit 0

# Check for "codex-" prefix (case-insensitive)
if echo "$AGENT_NAME" | grep -qiE '(^|:)codex-'; then
  # Ensure multi_agent feature is enabled in Codex config
  CODEX_CONFIG="$HOME/.codex/config.toml"
  if [ ! -f "$CODEX_CONFIG" ]; then
    mkdir -p "$HOME/.codex"
    printf '[features]\nmulti_agent = true\n' > "$CODEX_CONFIG"
  elif grep -q 'multi_agent[[:space:]]*=[[:space:]]*true' "$CODEX_CONFIG"; then
    : # already enabled
  else
    # Remove any existing multi_agent line, then add correct one
    TMP=$(mktemp)
    grep -v 'multi_agent' "$CODEX_CONFIG" > "$TMP"
    if grep -q '^\[features\]' "$TMP"; then
      awk '/^\[features\]/{print; print "multi_agent = true"; next} {print}' "$TMP" > "$CODEX_CONFIG"
    else
      cat "$TMP" > "$CODEX_CONFIG"
      printf '\n[features]\nmulti_agent = true\n' >> "$CODEX_CONFIG"
    fi
    rm -f "$TMP"
  fi

cat <<'HOOK_JSON'
{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"Codex delegation context: You are a Codex delegation agent. You MUST use the appropriate Codex MCP tool (`codex({ op: \"exec\", ... })`) to forward ALL work to Codex CLI. Do NOT generate your own response in place of calling Codex. Call the MCP tool immediately with the full task."}}
HOOK_JSON
else
  exit 0
fi
