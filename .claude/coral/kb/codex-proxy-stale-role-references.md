# Codex Proxy: Stale `### Role:` Section References

## Rule
After the codex-proxy refactor (removed embedded `### Role:` prompt templates in favor of file references), three skills still contain stale references to those removed sections. These paths are broken and will fail silently when exercised. Fix in priority order: ralph first (route 4c of `/codex` directly exercises it).

## Why
The old `codex-proxy.md` had inline `### Role: scanner`, `### Role: debugger`, `### Role: ralph` etc. sections that skills read directly. After the refactor, codex-proxy reads agent files at runtime via Glob/Read — the `### Role:` sections are gone. Skills that still reference them will read an agent file and get no usable content.

## Pattern
```
// Stale references to fix (as of 2026-02-28):

skills/ralph/SKILL.md:190
  "Read CORAL_AGENTS/codex-proxy.md for the prompt template (### Role: ralph section)"
  → HIGHEST PRIORITY: route 4c of /codex delegates to ralph --codex, exercises this path
  → Fix: ralph's --codex mode should construct its own codex prompt from CORAL_AGENTS/ralph
    protocol (but note circular reference risk: ralph/SKILL.md has --codex mode that references
    codex-proxy → can't use codex-proxy for ralph). Solution: inline a minimal ralph prompt in
    ralph/SKILL.md's --codex execution path directly.

skills/bugfix/SKILL.md:31
  "Read CORAL_AGENTS/codex-proxy.md, use ### Role: debugger prompt template"
  → Fix: spawn coral:codex-proxy with Role: debugger via Task tool (matches analyze skill pattern)

skills/code-simplify/SKILL.md:68
  "read CORAL_AGENTS/codex-proxy.md (### Role: ralph section)"
  → Fix: needs careful thought — code-simplify wants single-pass execution, not ralph's
    persistent loop. Consider direct codex() MCP call with the simplification prompt, or
    a new dedicated role in codex-proxy.

docs/skills.md:38-39
  Documents session create/session send — ops not in MCP schema, stale documentation.
```
