# Plugin SKILL.md Frontmatter Hooks Do Not Fire

## Rule
Plugin skills' SKILL.md frontmatter hooks (PreToolUse, PostToolUse, Stop) do not fire. All hooks for plugin skills must be registered in `hooks/hooks.json`. Use script-internal conditions for scoping (state files, session flag files).

## Why
Frontmatter hooks appear to only work for project-level skills (`.claude/skills/`), not plugin skills. Assuming frontmatter hooks work and debugging from there wastes significant time — the hooks silently don't register.

## Pattern
```
# WRONG: Frontmatter hooks in plugin SKILL.md (silently ignored)
---
name: ralph
hooks:
  Stop:
    - command: "./hooks/kb-promote-reminder.sh"
---

# RIGHT: Register in hooks/hooks.json with script-level scoping
# hooks/hooks.json
"Stop": [{ "hooks": [{ "type": "command", "command": "...", "timeout": 5 }] }]

# Script checks state file to scope to specific skills:
STATE_FILE=".claude/coral/tmp/kb-active"
[ ! -f "$STATE_FILE" ] && exit 0

# SKILL.md creates state file via inline Bash instruction in prose:
# Before starting, run Bash(`mkdir -p .claude/coral/tmp && touch .claude/coral/tmp/kb-active`).
#
# NOTE: Do NOT use ```! blocks for this — they bypass PermissionRequest hooks entirely.
# Claude Code checks the raw markdown block against sensitive-path rules before hooks fire,
# causing "sensitive file" errors on .claude/ paths with no hook-based workaround.
```

Verified against claude-code v2.1.50: all official plugins (hookify, ralph-wiggum, security-guidance) register hooks exclusively in hooks.json. Zero plugins use SKILL.md frontmatter hooks.
