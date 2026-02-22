#!/bin/sh
# kb-memo-reminder.sh - PreToolUse hook for memo writing reminder.
# Reminds Claude to write memos when discovering non-obvious lessons.
# Used with once: true in skill frontmatter (fires once at skill start).
#
# POSIX-portable: no bash-isms, no jq, no grep -P.

printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Memo reminder: When you discover something non-obvious during this task (painful root cause, unexpected gotcha, clever solution), write immediately to .claude/coral/memo/<timestamp>-<topic>.md. Keep brief - one paragraph + context."}}\n'
