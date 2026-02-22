#!/bin/sh
# kb-promote-reminder.sh - Stop/PreCompact hook for KB promotion.
# Reminds Claude to review memos for KB promotion on skill completion
# or before context compaction.
# Fail-open: errors default to exit 0 (no output).
#
# POSIX-portable: no bash-isms, no jq, no grep -P.

set -e

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

printf '{"decision":"block","reason":"Unprocessed memos found. Before completing, review .claude/coral/memo/ for KB promotion. Memos: %s. Check existing KB entries in .claude/coral/kb/ first - discard duplicates, update existing entries if a memo refines them, only create new files for genuinely absent knowledge. Delete processed memos after promotion.","systemMessage":"KB promotion reminder: unprocessed memos found in .claude/coral/memo/"}\n' "$memo_files"
