---
name: codex-ralph
description: Persistent execution via Codex delegation (sonnet) - best for implementing an existing plan
argument-hint: "[--red] [task description]"
model: sonnet
disable-model-invocation: true
hooks:
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/kb-promote-reminder.sh"
          once: true
---

# Persistent Execution via Codex

Claude controls the loop. Codex executes each round. Claude verifies after each round.

Announce at start: "Using codex-ralph to execute this task via Codex with Claude-controlled verification loop."

## Execution

1. **Load protocol**: Read `agents/codex-proxy.md` for the prompt template and system instructions. Use the ralph role's prompt template (`### Role: ralph` section). **You** call Codex directly - do NOT spawn a codex-proxy agent.
2. **Gather context**: Collect task description, acceptance criteria, file paths, constraints from conversation

## Execution Loop

1. **Call Codex**: Use `codex({ op: "exec", ... })` (first round) or `codex({ op: "exec", session: <thread_id>, ... })` with saved thread_id (subsequent rounds). Follow the protocol's prompt template. Pass `working_directory` and `reasoning_effort: "high"`.
2. **Save thread_id** from the response for session continuity
3. **Verify** the changes yourself:
   - Read changed files
   - Compare against acceptance criteria
   - Use LSP/type-check only. NEVER run build or test during the execution loop.
4. **Loop decision**:
   - All criteria pass → exit loop, go to Post-Completion Review
   - Not complete → go to step 1 with thread_id + updated progress context
   - Max 5 rounds → ask user whether to continue or finalize

## Post-Completion Review

**Tests passing does not mean the work is correct.** Codex may produce code that passes tests but diverges from the plan - especially for untestable content (docs, prompts, config).

After the loop exits:
1. **Read every changed file** that Codex modified across all rounds
2. **Compare against the plan/requirements** - does each file match what was specified?
3. **Flag untestable content** - documentation, markdown, config: verify these match the plan
4. **Fix discrepancies yourself** - do not send back to Codex; fix them directly
5. **Report to the user** what was done correctly and what you corrected
6. **Post-implementation sequence** (strict order, fail-fast by cost):
   **Scope gate**: Steps a-d apply only when source-affecting files are modified (`src/`, `scripts/`, `package.json`, `tsconfig.json`). Non-source changes (`agents/`, `skills/`, `docs/`, `hooks/`, `.claude/`) skip directly to completion.

   **`--red` adversarial testing**: If `--red` is present in the task argument, spawn `coral:red-attacker` via Task tool in **background** (`run_in_background: true`) immediately before step a. Include in the prompt:
   - `implementer: codex` (Claude generates tests directly — no Codex delegation)
   - Changed files list or scope description
   - `plan_context: <plan summary>` (if a plan was used for this task)

   a. **Lint**: Run linter if available. Cheapest check first.
   b. **Parallel validation**: Spawn `coral:architect` for architecture review. Additionally, if project instructions define workflow rules (e.g., review-orchestrator), execute them as parallel subagents alongside architect. Both must pass before proceeding to build.
   c. **Build**: Run the project's build command.
   d. **Red-attacker gate** (if `--red`): Wait for background red-attacker to complete. Read its output for the list of generated test files.
   e. **Test**: Run the test suite after build succeeds. If `--red`, this now includes adversarial tests.
   f. **Red fix loop** (if `--red` and adversarial test failures): Fix failures → re-run test. Cap at **3 iterations** — if still failing, report remaining failures and escalate rather than looping indefinitely.

## Sandbox bypass

Pass `bypass: true` only when the user explicitly requests bypass mode. Otherwise, omit the field.

## Error Policy

If `agents/codex-proxy.md` cannot be read, report the error to the user. Do not fall back to inline execution - the agent protocol is a required dependency.
