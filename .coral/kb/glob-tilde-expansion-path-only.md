# Glob tool cannot access plugin cache directory

## Rule
The Glob tool fails silently (0 matches) when `path` points to `~/.claude/plugins/cache/coral/`, regardless of pattern or whether `~` is expanded. As of Claude Code ~2.2+, this path is inaccessible to Glob. Use `Bash("echo ~/.claude/plugins/cache/coral/coral/*/methods/")` instead — shell glob `*` resolves the version directory dynamically.

## Why
Agents with `--deep` need to read HOW method files from the plugin cache. The previous Glob-based pattern (`Glob(pattern: "**/methods/", path: "~/.claude/plugins/cache/coral/")`) silently returns 0 results, causing agents to waste tokens on repeated failed searches.

## Pattern
```
# BROKEN — Glob cannot access cache/coral/ (confirmed 2026-03-07)
Glob(pattern: "**/methods/", path: "~/.claude/plugins/cache/coral/")
Glob(pattern: "**/*.md", path: "/home/user/.claude/plugins/cache/coral")

# WORKS — Bash shell glob resolves version dynamically
Bash("echo ~/.claude/plugins/cache/coral/coral/*/methods/")
Bash("cat ~/.claude/plugins/cache/coral/coral/*/methods/HOW-REVIEW.md")

# Agent blockquote format:
> **CORAL_METHODS**: !`echo ~/.claude/plugins/cache/coral/coral/*/methods/`
```
