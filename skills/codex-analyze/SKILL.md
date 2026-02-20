---
name: codex-analyze
description: Deep analysis via Codex delegation with Claude post-processing
argument-hint: "[investigation target or question]"
---

# Deep Analysis via Codex

Codex investigates. Claude verifies and presents.

Announce at start: "Using codex-analyze to investigate via Codex with Claude verification."

## Execution

1. **Load protocol**: Read `agents/codex-analyst.md` for the prompt template and system instructions
2. **Gather context**: From the conversation, collect:
   - Investigation target and specific question
   - File paths, error messages, stack traces
   - What has been tried or ruled out
3. **Call Codex**: Use `codex_session_create` (or `codex_session_send` for follow-ups) directly, following the protocol's prompt template. Pass `working_directory` and `reasoning_effort: "xhigh"`.
4. **Post-process** the raw Codex response:
   - **Verify references**: For CRITICAL/HIGH findings, Read the cited file:line to confirm accuracy. Drop findings with incorrect references.
   - **Filter**: Remove findings unrelated to the user's question
   - **Restructure**: Present findings ordered by severity with verified references
   - **Synthesize**: Add a 2-3 sentence summary connecting findings to the original question

## Error Policy

If `agents/codex-analyst.md` cannot be read, report the error to the user. Do not fall back to inline analysis — the agent protocol is a required dependency.
