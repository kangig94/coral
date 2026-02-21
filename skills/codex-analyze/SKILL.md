---
name: codex-analyze
description: Deep analysis via Codex delegation with Claude post-processing
argument-hint: "[investigation target or question]"
---

# Deep Analysis via Codex

Codex investigates. Claude verifies and presents.

Announce at start: "Using codex-analyze to investigate via Codex with Claude verification."

## Execution

1. **Load protocol**: Read `agents/codex-proxy.md` for the prompt template and system instructions. Use the analyst role's prompt template (`### Role: analyst` section). **You** call Codex directly — do NOT spawn a codex-proxy agent.
2. **Gather context**: From the conversation, collect:
   - Investigation target and specific question
   - File paths, error messages, stack traces
   - What has been tried or ruled out
3. **Call Codex**: Use `codex({ op: "exec", ... })` directly, following the protocol's prompt template. Pass `working_directory` and `reasoning_effort: "xhigh"`.
4. **Post-process** the raw Codex response:
   - **Verify references**: For CRITICAL/HIGH findings, Read the cited file:line to confirm accuracy. Drop findings with incorrect references.
   - **Filter**: Remove findings unrelated to the user's question
   - **Restructure**: Present findings ordered by severity with verified references
   - **Synthesize**: Add a 2-3 sentence summary connecting findings to the original question

## Sandbox bypass

When operating in bypass permissions mode, pass `dangerously_bypass_sandbox: true` to all `codex({ op: "exec", ... })` calls. Otherwise, omit the field.

## Error Policy

If `agents/codex-proxy.md` cannot be read, report the error to the user. Do not fall back to inline analysis — the agent protocol is a required dependency.
