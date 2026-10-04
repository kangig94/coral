---
name: bugfix
description: 'Use when encountering a bug, error, or unexpected behavior that needs diagnosis and fix.'
argument-hint: '[--delegate] <bug description or error message>'
---

# Bug Debugging

Diagnose bugs, plan fixes, and execute - end-to-end.

## Argument Routing

| Argument              | Mode                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `<prompt>`            | Self-execute on current host (default)                                                                                             |
| `--delegate`          | Delegate to the other host (Claude → Codex, Codex → Claude, Copilot → Codex; current host comes from SessionStart `Current host:`) |
| `--delegate <prompt>` | Same with prompt                                                                                                                   |

Strip the `--delegate` flag before passing the prompt to the execution path.

## Execution

1. **Diagnose**:
   - **Self-execute (default)**: Spawn `Agent({ subagent_type: "coral:debugger", prompt: "--deep " + prompt })`.
     Wait for the agent to return its diagnosis in `<Output_Format>` structure.
   - **Delegate (`--delegate`)**: Run `coral-cli <other-host> debugger --work-dir "<work_dir>" -d -i - <<'CORAL_INPUT'` with the `<--deep prompt>` as the body of that quoted heredoc, closed by a `CORAL_INPUT` line (`<other-host>` = the delegation target for the current host: Claude → Codex, Codex → Claude, Copilot → Codex).
     Capture `job` from `Job <job> <launchState> (session <session>)`, then run `cd "<work_dir>" && coral-cli wait jobs <job> --embed`. Classify the result from its rendered output, not exit code `75` alone: `Result path: <path>` identifies an available terminal artifact, so read it even when a terminal `provider_exit` propagated code `75`, and follow any printed continuation for remaining collection work; a status beginning `Still waiting` with `(cursor: <cursor>)` means collection still has work, so resume with `cd "<work_dir>" && coral-cli wait jobs <job> --cursor <cursor> --embed`. If a transient error instead prints `remediation:`, run that exact command from the same directory — `cd "<work_dir>" && <the printed coral-cli wait jobs command>` — since `wait` scopes from the shell's cwd. A non-zero `provider_exit` code is terminal and is passed through unchanged (0–255).
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

Artifact collection: the outcome is final even without a result path. For `Unverified result path: <path>`, read the file if it exists; the older coordinator cannot certify availability. `no longer kept: past the N-day retention window` means the artifact is gone. `the outcome above is final; Coral is writing the result file` keeps artifact collection in the printed continuation; `result file now available` supplies its available `Result path:` without replaying the outcome. A `failed` artifact line reports its cause and whether maintenance retries it; collect full retained content with `coral-cli jobs detail <jobId> --full`. Follow the exact cursor-aware continuation for remaining results, progress, discovery or artifact settlement. `--now` reads an immediate snapshot with labeled terminal previews; dropping `--now` from its continuation opens a blocking wait. A saved-cursor replay notice means earlier outcomes may repeat; a membership-change notice replays progress while keeping collected outcomes acknowledged.
