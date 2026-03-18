# Claude Code Rules: `paths:` Frontmatter Key

## Rule
Use `paths:` (not `globs:`) for file-scoped rules in `.claude/rules/*.md`. The `globs:` key is undocumented in Claude Code and comes from Cursor conventions — it silently does nothing if used.

## Why
If a rule file uses `globs:` instead of `paths:`, the file-scoping silently fails. The rule is either ignored or applied universally (not just to matching files), defeating the purpose of path-based activation. This is a non-obvious silent failure.

## Pattern
```yaml
# CORRECT — Claude Code official format
---
paths:
  - "src/**/*.ts"
  - "hooks/**/*"
---

# WRONG — Cursor convention, not Claude Code
---
globs: "src/**/*.ts"
---
```

Additional notes:
- `.claude/rules/*.md` files are auto-loaded with the same priority as `CLAUDE.md` — no `@import` needed
- `@import` is for non-auto-loaded files like external docs or reference materials
- Rule files with `paths:` frontmatter only activate when the files being edited match those patterns
