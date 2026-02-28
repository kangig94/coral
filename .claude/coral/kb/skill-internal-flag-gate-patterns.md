# Internal Flag Gate Patterns for Skill Expansion

## Rule
When a skill's SKILL.md is invoked via `Skill()` by both standalone users AND caller skills that want to suppress part of the output, use an internal flag to gate what runs. The flag is documented in the Argument Routing table but **never** in `argument-hint` frontmatter.

**Exit gate** (`--no-handoff`): caller controls the next step after the protocol completes. Gate placed at the end of the output format. Post-completion handoff prompt is suppressed.

Before adding a gate, verify it's actually needed. If the default execution path already works for callers (e.g., `--codex` gating already isolates standalone-only sections), no flag is needed.

## Why
`Skill("coral:plan")` expands the full SKILL.md. When bugfix calls plan, it wants the full planning protocol but not the "implement with ralph?" handoff question. Without the exit gate, plan interrupts bugfix's own flow.

## Pattern
```markdown
# Exit gate — placed in <Output_Format> at the end:
**If `--no-handoff`**: stop after showing the summary. The caller controls the next step.
**Otherwise**: ask the user [handoff question].

# Callers pass internal flags:
Skill({ skill: "coral:plan",  args: "--no-handoff fix-auth-bug" })
```

**Anti-pattern**: Adding an entry gate (`--protocol-only`) when the default execution path already works for callers. Ralph's `--codex` gating naturally isolates standalone-only sections, so callers get exactly `<Ralph_Protocol>` without any special flag.
