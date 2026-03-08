---
name: bugfix
description: "Use when encountering a bug, error, or unexpected behavior that needs diagnosis and fix."
argument-hint: "[--codex] <bug description or error message>"
---

> **CORAL_AGENTS**: `Bash("echo ~/.claude/plugins/cache/coral/coral/*/agents/")`

# Bug Debugging

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
   - **Default**: Read `CORAL_AGENTS/debugger.md`. **You** execute it directly with `--deep` —
     follow `<Investigation_Protocol>` steps with conversation context.
     Present diagnosis in `<Output_Format>` structure.
   - **`--codex`**: Call `codex({ op: "coral:debugger", prompt: "--deep " + prompt, work_dir })`.
     Capture `job` from the exec response, then `wait({ jobs: [job], inline: true })` → read `result.content` for findings.
     On error, stop with the error message.
     Verify cited file:line references. Drop findings with incorrect references.

2. **Plan fix**: Invoke `Skill({ skill: "coral:plan", args: "--no-handoff fix-{short-bug-description}" })`.
   If `--codex` was passed, append `--codex` to the plan args.
   The plan protocol gathers context from the conversation (diagnosis from step 1).
   Plan should include: what to change, why, and how to verify the fix.

3. **Execute fix**: Invoke `Skill({ skill: "coral:ralph", args: "implement the plan from step 2" })`.
   If `--codex` was passed, append `--codex` to the ralph args.

4. **Project validation**: If project instructions define workflow rules (e.g., review gates,
   post-implementation steps), follow them.

## Error Policy

If `CORAL_AGENTS/debugger.md` cannot be read, report the error to the user.
