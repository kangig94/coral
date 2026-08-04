---
name: bugfix
description: "Use when encountering a bug, error, or unexpected behavior that needs diagnosis and fix."
argument-hint: "[--delegate] <bug description or error message>"
---

# Bug Debugging

Diagnose bugs, plan fixes, and execute - end-to-end.

## Argument Routing

| Argument | Mode |
|----------|------|
| `<prompt>` | Self-execute on current host (default) |
| `--delegate` | Delegate to the other host (Claude → Codex, Codex → Claude, Copilot → Codex; current host comes from SessionStart `Current host:`) |
| `--delegate <prompt>` | Same with prompt |

Strip the `--delegate` flag before passing the prompt to the execution path.

## Execution

1. **Diagnose**:
   - **Self-execute (default)**: Spawn `Agent({ subagent_type: "coral:debugger", prompt: "--deep " + prompt })`.
     Wait for the agent to return its diagnosis in `<Output_Format>` structure.
   - **Delegate (`--delegate`)**: Run `coral-cli <other-host> debugger -i "<--deep prompt>" --work-dir "<work_dir>" -d` (`<other-host>` = the delegation target for the current host: Claude → Codex, Codex → Claude, Copilot → Codex).
     Capture `job` from `Job <job> <launchState> (session <session>)`, then run `coral-cli wait jobs <job> --embed` → the terminal output always includes `Result path: <path>`; read that path for the full artifact and treat inline preview text as optional convenience for findings.
     On error, stop with the error message.
     Verify cited file:line references. Drop findings with incorrect references.

2. **Record diagnosis**: Write the diagnosis to `CORAL_PROJECT/plans/debug-{short-bug-description}.md`
   using the debugger's output format (Symptom, Reproduction Path, Hypothesis Log, Root Cause, Fix Specification).
   Gate on hypothesis verdicts:
   - **One confirmed root cause** → proceed to step 3.
   - **Multiple hypotheses survived** → present to user, ask which to pursue before proceeding.
   - **All refuted or inconclusive** → stop and report findings to user.

3. **Plan fix**: Invoke `Skill({ skill: "coral:plan", args: (if --delegate: "--delegate ") + "round=3 --no-handoff fix-{short-bug-description}" })`.
   The plan references `CORAL_PROJECT/plans/debug-{short-bug-description}.md` for diagnosis context.
   Plan should include: what to change, why, and how to verify the fix.

4. **Execute fix**: Invoke `Skill({ skill: "coral:ralph", args: (if --delegate: "--delegate ") + "implement the plan from step 3" })`.

5. **Project validation**: If project instructions define workflow rules (e.g., review gates,
   post-implementation steps), follow them.
