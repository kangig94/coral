#!/bin/sh
# kb-lookup-reminder.sh - PostToolUseFailure hook for KB lookup.
# Reminds Claude to check .claude/coral/kb/ on any tool failure.
# Fail-open: errors default to exit 0 (no output).
#
# POSIX-portable: no bash-isms, no jq, no grep -P.

set -e

KB_DIR="${CLAUDE_PROJECT_DIR:-.}/.claude/coral/kb"
if [ ! -d "$KB_DIR" ]; then
  exit 0
fi

kb_files=""
for f in "$KB_DIR"/*.md; do
  [ -f "$f" ] || continue
  name=$(printf '%s' "$f" | sed 's|.*/||')
  if [ -z "$kb_files" ]; then
    kb_files="$name"
  else
    kb_files="$kb_files, $name"
  fi
done

if [ -z "$kb_files" ]; then
  exit 0
fi

printf '{"hookSpecificOutput":{"hookEventName":"PostToolUseFailure","additionalContext":"Error detected. Before debugging from scratch, check .claude/coral/kb/ for relevant knowledge: %s"}}\n' "$kb_files"
