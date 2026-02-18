---
name: codex-ralph
description: Persistent execution via Codex delegation — keeps working until done
argument-hint: "[task description]"
allowed-tools: mcp__cx__codex_execute, mcp__cx__codex_session_send, mcp__cx__codex_session_create
---

# Persistent Execution via Codex

Announce at start: "Using codex-ralph to execute this task via Codex with persistent verification loop."

## Execution

1. **Load protocol**: Read `agents/codex-ralph.md` to load the full codex-ralph protocol
2. **Check session continuity**: Look for a previous `thread_id` from a `/codex-ralph` call in conversation history
   - **Previous thread_id exists** → use `mcp__cx__codex_session_send` to continue
   - **No previous thread_id** → use `mcp__cx__codex_session_create` to start a new session
   - **User says "new" or wants a fresh start** → use `mcp__cx__codex_execute` regardless
3. **Construct prompt**: Follow the protocol's `<Prompt_Template>` to assemble [SYSTEM]/[CONTEXT]/[TASK]
4. **Enhance with context**: Add relevant file paths, code snippets, progress, and working_directory from the conversation
5. **Call Codex**: Send the assembled prompt. MUST pass `working_directory` on every call.
6. **Verify completion**: If Codex claims "done" without evidence, send a follow-up asking for verification output
7. **Pause after 5 rounds**: Confirm direction with the user before continuing

## Context Enhancement

From the current conversation, identify and include:
- Task description and acceptance criteria
- File paths and code sections relevant to the work
- Current progress and any prior verification results
- Error messages or symptoms if debugging
- Constraints or preferences stated by the user

## Error Policy

If `agents/codex-ralph.md` cannot be read, report the error to the user. Do not fall back to inline execution — the agent protocol is a required dependency.
