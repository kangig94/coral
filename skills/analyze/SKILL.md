---
name: analyze
description: "Deep analysis and investigation. Pass --codex to delegate to Codex CLI."
argument-hint: "[--codex] [investigation target or question]"
---

# Deep Analysis & Investigation

Execute a thorough analysis using Claude's native analysis capabilities, or delegate to Codex CLI.

## Argument Routing

| Argument | Mode |
|----------|------|
| `<prompt>` | Claude-native (default) |
| `--codex` | Codex delegation (context from conversation) |
| `--codex <prompt>` | Codex delegation |

Strip the `--codex` flag before passing the prompt to the execution path.

## Claude-native Execution (default)

1. **Load protocol**: Read `agents/analyst.md` to load the full analyst protocol
2. **Apply Investigation_Protocol**: Follow the numbered steps in the protocol's `<Investigation_Protocol>` section
3. **Use Claude-native tools**: Read, Grep, Glob, LSP tools to trace code paths and gather evidence
4. **Present findings**: Use the protocol's `<Output_Format>` to present findings by severity
5. **Prioritize**: Critical gaps first, nice-to-haves last

## Codex Delegation

1. **Load protocol**: Read `agents/codex-proxy.md` for the prompt template and system instructions. Use the analyst role's prompt template (`### Role: analyst` section). **You** call Codex directly - do NOT spawn a codex-proxy agent.
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

## Context Enhancement

From the current conversation, identify and include in your analysis:
- Error messages, stack traces, or symptoms being investigated
- Files and code paths relevant to the issue
- What has already been tried or ruled out

## Error Policy

If `agents/analyst.md` (Claude-native) or `agents/codex-proxy.md` (Codex delegation) cannot be read, report the error to the user. Do not fall back to inline analysis - the agent protocol is a required dependency.
