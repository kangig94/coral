---
name: bugfix
description: "Use when encountering a bug, error, or unexpected behavior that needs diagnosis and fix."
argument-hint: "[--codex] <bug description or error message>"
---

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
     Capture `job` from the exec response, then `wait({ jobs: [job] })` → read `result.content`; if absent, `Read(result.path)` is best-effort recovery for findings.
     On error, stop with the error message.
     Verify cited file:line references. Drop findings with incorrect references.

2. **Record diagnosis**: Write the diagnosis to `CORAL_PROJECT/plans/debug-{short-bug-description}.md`
   using the debugger's output format (Symptom, Reproduction Path, Hypothesis Log, Root Cause, Fix Specification).
   Gate on hypothesis verdicts:
   - **One confirmed root cause** → proceed to step 3.
   - **Multiple hypotheses survived** → present to user, ask which to pursue before proceeding.
   - **All refuted or inconclusive** → stop and report findings to user.

3. **Plan fix**: Invoke `Skill({ skill: "coral:plan", args: (if --codex: "--codex ") + "--deep --no-handoff fix-{short-bug-description}" })`.
   The plan references `CORAL_PROJECT/plans/debug-{short-bug-description}.md` for diagnosis context.
   Plan should include: what to change, why, and how to verify the fix.

4. **Execute fix**: Invoke `Skill({ skill: "coral:ralph", args: (if --codex: "--codex ") + "implement the plan from step 3" })`.

5. **Project validation**: If project instructions define workflow rules (e.g., review gates,
   post-implementation steps), follow them.

## Error Policy

If `CORAL_AGENTS/debugger.md` cannot be read, report the error to the user.
