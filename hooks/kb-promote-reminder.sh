#!/bin/sh
# kb-promote-reminder.sh - Stop/PreCompact hook for KB promotion.
# Stop: skill-scoped via .claude/coral-kb-active state file.
# PreCompact: always checks for unprocessed memos.
# Fail-open: errors default to exit 0 (no output).
#
# POSIX-portable: no bash-isms, no jq, no grep -P.

set -e

INPUT=$(cat)
EVENT=$(printf '%s' "$INPUT" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

STATE_FILE="${CLAUDE_PROJECT_DIR:-.}/.claude/coral/tmp/kb-active"

# Stop hook: skill-scoped via state file
if [ "$EVENT" = "Stop" ]; then
  if [ ! -f "$STATE_FILE" ]; then
    exit 0
  fi
  rm -f "$STATE_FILE"
fi

# Check for unprocessed memos
MEMO_DIR="${CLAUDE_PROJECT_DIR:-.}/.claude/coral/memo"
if [ ! -d "$MEMO_DIR" ]; then
  exit 0
fi

memo_files=""
for f in "$MEMO_DIR"/*; do
  [ -f "$f" ] || continue
  name=$(printf '%s' "$f" | sed 's|.*/||')
  if [ -z "$memo_files" ]; then
    memo_files="$name"
  else
    memo_files="$memo_files, $name"
  fi
done

if [ -z "$memo_files" ]; then
  exit 0
fi

if [ "$EVENT" = "Stop" ]; then
  printf '{"decision":"block","reason":"Unprocessed memos: %s. Review for KB promotion per CLAUDE.md rules, then delete processed memos."}\n' "$memo_files"
else
  printf '{"systemMessage":"KB promotion reminder: unprocessed memos found in .claude/coral/memo/ - %s"}\n' "$memo_files"
fi
