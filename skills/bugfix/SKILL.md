---
name: bugfix
description: "Systematic bug diagnosis, planning, and fix execution."
argument-hint: "[--codex] <bug description or error message>"
---

> **CORAL_AGENTS**: `~/.claude/plugins/cache/coral/**/agents/` — locate via Glob
> **CORAL_SKILLS**: `~/.claude/plugins/cache/coral/**/skills/` — locate via Glob

# Bug Debugging

Before starting, run Bash(`mkdir -p .claude/coral/tmp && touch .claude/coral/tmp/kb-active`).

Diagnose bugs, plan fixes, and execute - end-to-end.

## Argument Routing

| Argument | Mode |
|----------|------|
| `<prompt>` | Claude-native (default) |
| `--codex` | Codex delegation (context from conversation) |
| `--codex <prompt>` | Codex delegation |

Strip the `--codex` flag before passing the prompt to the execution path.

## Execution

1. **Diagnose**:
   - **Default**: Read `CORAL_AGENTS/debugger.md`. **You** execute it directly — follow
     `<Investigation_Protocol>` steps with conversation context.
     Present diagnosis in `<Output_Format>` structure.
   - **`--codex`**: Read `CORAL_AGENTS/codex-proxy.md`, use `### Role: debugger` prompt template.
     Call `codex({ op: "exec", ... })` with the bug description as task context.
     Pass `working_directory` and `reasoning_effort: "xhigh"`.
     Verify cited file:line references. Drop findings with incorrect references.

2. **Plan fix**: Read `CORAL_SKILLS/plan/PROTOCOL.md`.
   **You** execute it directly — follow the protocol steps with diagnosis context.
   Pass `--codex` flag if present (the plan protocol handles Codex delegation internally).
   - Plan name: `fix-{short-bug-description}`
   - Task context: diagnosis result from step 1
     (root cause, affected files, reproduction steps)
   - Plan should include: what to change, why, and how to verify the fix

3. **Execute fix**:
   - **Default**: Read `CORAL_SKILLS/ralph/PROTOCOL.md`. **You** execute it directly — implement the plan
     from step 2.
   - **`--codex`**: Read `CORAL_AGENTS/codex-proxy.md`, use `### Role: ralph` prompt template.
     Call `codex({ op: "exec", ... })` with the plan as task context.
     Pass `working_directory` and `reasoning_effort: "high"`.
     Verify all changes against the plan. Fix discrepancies directly.

4. **Project validation**: If project instructions define workflow rules (e.g., review gates,
   post-implementation steps), follow them.

## Sandbox bypass

Pass `bypass: true` only when the user explicitly requests bypass mode. Otherwise, omit the field.

## Error Policy

If `CORAL_AGENTS/debugger.md` cannot be read, report the error to the user.
