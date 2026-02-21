---
name: codex-ralph
description: Persistent execution via Codex delegation (sonnet) — best for implementing an existing plan
argument-hint: "[task description]"
model: sonnet
disable-model-invocation: true
---

# Persistent Execution via Codex

Claude controls the loop. Codex executes each round. Claude verifies after each round.

Announce at start: "Using codex-ralph to execute this task via Codex with Claude-controlled verification loop."

## Execution

1. **Load protocol**: Read `agents/codex-proxy.md` for the prompt template and system instructions. Use the ralph role's prompt template (`### Role: ralph` section).
2. **Gather context**: Collect task description, acceptance criteria, file paths, constraints from conversation

## Execution Loop

1. **Call Codex**: Use `codex_session_create` (first round) or `codex_session_send` with saved thread_id (subsequent rounds). Follow the protocol's prompt template. Pass `working_directory` and `reasoning_effort: "high"`.
2. **Save thread_id** from the response for session continuity
3. **Verify** the changes yourself:
   - Read changed files
   - Run tests/build/lint as appropriate
   - Compare against acceptance criteria
4. **Loop decision**:
   - All criteria pass → exit loop, go to Post-Completion Review
   - Not complete → go to step 1 with thread_id + updated progress context
   - Max 5 rounds → ask user whether to continue or finalize

## Post-Completion Review

**Tests passing does not mean the work is correct.** Codex may produce code that passes tests but diverges from the plan — especially for untestable content (docs, prompts, config).

After the loop exits:
1. **Read every changed file** that Codex modified across all rounds
2. **Compare against the plan/requirements** — does each file match what was specified?
3. **Flag untestable content** — documentation, markdown, config: verify these match the plan
4. **Fix discrepancies yourself** — do not send back to Codex; fix them directly
5. **Report to the user** what was done correctly and what you corrected
6. **Post-implementation sequence** (strict order, fail-fast by cost):
   a. **Lint**: Run linter if available. Cheapest check first.
   b. **Parallel validation**: Spawn `coral:architect` for architecture review. Additionally, if project instructions define workflow rules (e.g., review-orchestrator), execute them as parallel subagents alongside architect. Both must pass before proceeding to build.
   c. **Build**: Run the project's build command.
   d. **Test**: Run the test suite after build succeeds.

## Sandbox bypass

When operating in bypass permissions mode, pass `dangerously_bypass_sandbox: true` to all `codex_session_create` and `codex_session_send` calls. Otherwise, omit the field.

## Error Policy

If `agents/codex-proxy.md` cannot be read, report the error to the user. Do not fall back to inline execution — the agent protocol is a required dependency.
