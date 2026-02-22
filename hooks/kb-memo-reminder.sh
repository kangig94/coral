#!/bin/sh
# kb-memo-reminder.sh - PreToolUse hook for memo writing reminder.
# Reminds Claude to write memos when discovering non-obvious lessons.
# Throttled: once per 15 minutes per session via flag file mtime check.
#
# POSIX-portable: no bash-isms, no jq, no grep -P.

set -e

INPUT=$(cat)
SESSION_ID=$(printf '%s' "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

if [ -z "$SESSION_ID" ]; then
  exit 0
fi

FLAG_DIR="${CLAUDE_PROJECT_DIR:-.}/.claude/coral/tmp"
FLAG="${FLAG_DIR}/memo-reminded-${SESSION_ID}"
# Skip if reminded within last 15 minutes (flag file mtime check)
if [ -f "$FLAG" ] && [ -z "$(find "$FLAG" -mmin +15 2>/dev/null)" ]; then
  exit 0
fi

mkdir -p "$FLAG_DIR"
touch "$FLAG"

printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Memo reminder: When you discover something non-obvious during this task (painful root cause, unexpected gotcha, clever solution), write immediately to .claude/coral/memo/<timestamp>-<topic>.md. Keep brief - one paragraph + context."}}\n'
