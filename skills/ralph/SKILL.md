---
name: ralph
description: Persistent execution loop with verification — keeps working until done
argument-hint: "[task description]"
---

# Persistent Execution with Verification

Announce at start: "Using ralph to execute this task with verification loop."

## Execution

1. **Load protocol**: Read `agents/ralph.md` to load the full ralph protocol
2. **Apply the Iron Law**: NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
3. **Execute the task**: Follow the protocol's `<Investigation_Protocol>` steps (loops until all acceptance criteria pass)
4. **Verification Gate**: Before any completion claim:
   - IDENTIFY what command proves the claim
   - RUN the command (fresh, complete)
   - READ the output, check exit code
   - VERIFY the output confirms the claim
   - ONLY THEN make the claim
5. **Architect review**: Request architect verification before declaring task complete

## Context Enhancement

From the current conversation, identify and include:
- Task description and acceptance criteria
- File paths and code sections relevant to the work
- Current progress and any prior verification results
- Constraints or preferences stated by the user

## Error Policy

If `agents/ralph.md` cannot be read, report the error to the user. Do not fall back to inline execution — the agent protocol is a required dependency.
