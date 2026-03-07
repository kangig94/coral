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

# Script checks session-scoped flag to scope to specific skills:
FLAG=".claude/coral/tmp/kb-active-${session_id}"
[ ! -f "$FLAG" ] && exit 0

# Flag created by a PreToolUse(Skill) hook — NOT by SKILL.md Bash.
# The hook has access to input.session_id for multi-session isolation.
# See hooks/kb-promote-reminder.mjs for the session-scoped pattern.
```

Verified against claude-code v2.1.50: all official plugins (hookify, ralph-wiggum, security-guidance) register hooks exclusively in hooks.json. Zero plugins use SKILL.md frontmatter hooks.
