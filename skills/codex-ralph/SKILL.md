---
name: codex-ralph
description: Persistent execution via Codex delegation — keeps working until done
argument-hint: "[task description]"
---

# Persistent Execution via Codex

Claude controls the loop. Codex executes each round. Claude verifies after each round.

Announce at start: "Using codex-ralph to execute this task via Codex with Claude-controlled verification loop."

## Execution Loop

1. **Gather context**: Collect task description, acceptance criteria, file paths, constraints from conversation
2. **Spawn agent**: Launch Task with `subagent_type: coral:codex-ralph`:
   ```
   thread_id: {thread_id from previous round, or omit on first round}

   [CONTEXT]
   Working directory: /path/to/project
   Relevant files: {file list}
   {progress summary: what's done, what remains}

   [TASK]
   {User's original request, or remaining work for this round}
   ```
3. **Extract thread_id**: Save the `thread_id` from the agent's response for session continuity
4. **Verify**: YOU (Claude, main context) verify the changes:
   - Read changed files
   - Run tests/build/lint as appropriate
   - Compare against acceptance criteria
5. **Loop decision**:
   - All criteria pass → exit loop, go to Post-Completion Review
   - Not complete → go to step 2 with thread_id + updated progress context
   - Max 5 rounds → ask user whether to continue or finalize

## Post-Completion Review

**Tests passing does not mean the work is correct.** Codex may produce code that passes tests but diverges from the plan — especially for untestable content (docs, prompts, config).

After the loop exits:
1. **Read every changed file** that Codex modified across all rounds
2. **Compare against the plan/requirements** — does each file match what was specified?
3. **Flag untestable content** — documentation, markdown, config: verify these match the plan
4. **Fix discrepancies yourself** — do not send back to Codex; fix them directly
5. **Report to the user** what was done correctly and what you corrected

## Error Policy

If agent spawn fails, report the error. Do not fall back to inline Codex calls — the agent is a required dependency.
