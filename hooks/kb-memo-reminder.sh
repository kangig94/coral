#!/bin/sh
# kb-memo-reminder.sh - PreToolUse hook for memo writing reminder.
# Reminds Claude to write memos when discovering non-obvious lessons.
# Once per session: uses flag file keyed by session_id from stdin JSON.
#
# POSIX-portable: no bash-isms, no jq, no grep -P.

set -e

INPUT=$(cat)
SESSION_ID=$(printf '%s' "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

if [ -z "$SESSION_ID" ]; then
  exit 0
fi

FLAG="/tmp/coral-memo-reminded-${SESSION_ID}"
if [ -f "$FLAG" ]; then
  exit 0
fi

touch "$FLAG"

printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Memo reminder: When you discover something non-obvious during this task (painful root cause, unexpected gotcha, clever solution), write immediately to .claude/coral/memo/<timestamp>-<topic>.md. Keep brief - one paragraph + context."}}\n'
