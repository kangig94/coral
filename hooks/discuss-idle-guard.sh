#!/bin/sh
# discuss-idle-guard.sh - TeammateIdle hook for discuss sessions.
# Blocks idle when an agent has a pending bid, speech, or vote.
# Fail-open: unhandled errors default to exit 0 (allow idle).
#
# POSIX-portable: no bash-isms, no jq, no grep -P.

_exit_code=0
trap 'exit $_exit_code' EXIT
set -e

# Read stdin JSON event payload
event=$(cat)

# Extract teammate_name and team_name from JSON
teammate_name=$(printf '%s' "$event" | sed -n 's/.*"teammate_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
team_name=$(printf '%s' "$event" | sed -n 's/.*"team_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)

# Step 1 (prefix guard): Only process dc- teammates
case "$teammate_name" in
  dc-*) ;;
  *) exit 0 ;;
esac

# Step 2 (env guard): Require $PWD and .claude/coral/discuss/ directory
if [ -z "$PWD" ]; then
  printf '%s\n' "discuss-idle-guard: PWD not set" >&2
  exit 0
fi
if [ ! -d "$PWD/.claude/coral/discuss" ]; then
  printf '%s\n' "discuss-idle-guard: discuss directory not found at $PWD/.claude/coral/discuss" >&2
  exit 0
fi

# Step 3: Derive logical agent name (strip dc- prefix)
agent_name="${teammate_name#dc-}"

# Step 4: Extract session_id from team_name (coral-dc-{session_id})
session_id="${team_name#coral-dc-}"
if [ "$session_id" = "$team_name" ]; then
  # team_name didn't have coral-dc- prefix - not a discuss team
  exit 0
fi

# Step 5: Resolve session directory via glob (session_id_*)
state_file=""
for dir in "$PWD/.claude/coral/discuss/${session_id}"_*; do
  if [ -f "$dir/state.json" ]; then
    state_file="$dir/state.json"
    break
  fi
done

if [ -z "$state_file" ]; then
  printf '%s\n' "discuss-idle-guard: state.json not found for session $session_id" >&2
  exit 0
fi

# Step 6: Read state fields (flat top-level fields only - no nested parsing)
status=$(sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$state_file" | head -1)
current_speaker=$(sed -n 's/.*"current_speaker"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$state_file" | head -1)
pending_bidders=$(sed -n 's/.*"pending_bidders"[[:space:]]*:[[:space:]]*\(\[[^]]*\]\).*/\1/p' "$state_file" | head -1)

# Step 7: Block idle if agent has pending action

# Bidding: agent hasn't bid yet
if [ "$status" = "bidding" ]; then
  if printf '%s' "$pending_bidders" | grep -Fq "\"$agent_name\""; then
    printf '%s\n' "Call \`discuss\` with op: \"bid\" to submit your bid." >&2
    _exit_code=2
  fi
  exit 0
fi

# Speaking: agent has the floor
if [ "$status" = "speaking" ] && [ "$current_speaker" = "$agent_name" ]; then
  printf '%s\n' "Call \`discuss\` with op: \"speak\" to deliver your speech." >&2
  _exit_code=2
  exit 0
fi

# Voting: agent hasn't voted yet
if [ "$status" = "voting" ]; then
  if printf '%s' "$pending_bidders" | grep -Fq "\"$agent_name\""; then
    printf '%s\n' "Termination vote: call \`discuss\` with op: \"bid\" - 0=agree to end, 1=disagree." >&2
    _exit_code=2
  fi
  exit 0
fi

# All other statuses (ended, etc.) - allow idle
exit 0
