# SKILL.md ```! Blocks Bypass PermissionRequest Hooks

## Rule
SKILL.md `\`\`\`!` auto-execute blocks do NOT go through the PermissionRequest hook pipeline. Claude Code checks the raw markdown block text (including backticks) against its own sensitive-path rules before any hook fires. Commands targeting `.claude/` paths will always be blocked in normal mode. Use inline prose instructions ("Before starting, run: `command`") instead, which route through the Bash tool's normal PermissionRequest flow.

## Why
Three layers of failure discovered:
1. `$CLAUDE_PROJECT_DIR` is unset in Claude Code sessions → paths resolve to root filesystem
2. `\`\`\`!` blocks pass the full markdown block (with backticks) to permission checks, not the extracted command
3. `.claude/` is treated as a sensitive path — PermissionRequest hooks cannot override this for `\`\`\`!` blocks

## Pattern
```markdown
# WRONG: ```! block — bypasses PermissionRequest hooks, blocked by sensitive-path check
```!
mkdir -p .claude/coral/tmp && touch .claude/coral/tmp/some-flag
```

# RIGHT: Inline instruction — Claude executes via Bash tool, PermissionRequest hook can auto-approve
Before starting, run: `mkdir -p .claude/coral/tmp && touch .claude/coral/tmp/some-flag`

# BEST: Move flag creation to a hook with session_id access (no SKILL.md Bash needed)
# PreToolUse(Skill) hook creates session-scoped flags automatically
```
