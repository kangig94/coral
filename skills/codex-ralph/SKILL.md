---
name: codex-ralph
description: Persistent execution via Codex delegation — keeps working until done
argument-hint: "[task description]"
---

# Persistent Execution via Codex

Announce at start: "Using codex-ralph to execute this task via Codex with persistent verification loop."

## Execution

1. **Check session continuity**: Look for a previous `thread_id` from a `/codex-ralph` call in conversation history
2. **Gather context**: Collect from the conversation:
   - Task description and acceptance criteria
   - File paths and code sections relevant to the work
   - Current progress and any prior verification results
   - Error messages or symptoms if debugging
   - Constraints or preferences stated by the user
3. **Spawn agent**: Launch Task with `subagent_type: coral:codex-ralph` and the following prompt:
   ```
   thread_id: {previous thread_id, or omit this line}

   [CONTEXT]
   Working directory: /path/to/project
   Relevant files: {file list}
   {progress summary if continuing}

   [TASK]
   {User's original request}
   ```
4. **Post-completion review**: After the agent returns success, YOU (Claude) must review the actual changes before reporting to the user. See below.

## Post-Completion Review

**Tests passing does not mean the work is correct.** The agent may produce code that passes tests but diverges from the plan or requirements — especially for content that tests cannot cover (documentation, prompts, config files, CLAUDE.md, README, etc.).

After the agent reports completion:
1. **Read every changed file** that the agent modified
2. **Compare against the plan/requirements** — does each file match what was specified?
3. **Flag untestable content** — documentation, markdown, config, behavioral instructions: verify these match the plan verbatim where applicable
4. **Fix discrepancies yourself** — do not send back for corrections; fix them directly
5. **Report to the user** what was done correctly and what you corrected

This step is mandatory. Never relay the agent's "done" claim to the user without completing this review.
