---
name: code-simplify
description: "Simplifies and refines code for clarity, consistency, and maintainability while preserving all functionality. Focuses on recently modified code unless instructed otherwise."
argument-hint: "[codex:|claude:]<scope or prompt>"
hooks:
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/kb-promote-reminder.sh"
          once: true
---

# Code Simplification

Simplify and refine code for clarity and maintainability while preserving functionality.

## Argument Routing

Parse the argument prefix to determine execution mode:

| Argument | Mode |
|----------|------|
| `<prompt>` (no prefix) | Claude-native (default) |
| `claude:<prompt>` | Claude-native |
| `codex` | Codex delegation (scope from conversation context) |
| `codex:<prompt>` | Codex delegation |

Strip the prefix before passing the prompt to the execution path.

## Claude-native Execution (default)

1. **Load protocol**: Read `agents/code-simplifier.md` to load the full code-simplifier protocol. **You** execute it directly - do NOT spawn a code-simplifier agent.
2. **Identify scope**: Use the provided argument or conversation context (files discussed, recently edited)
3. **Read standards**: Check the project's CLAUDE.md for coding conventions
4. **Apply simplifications**: Follow the protocol's `<Investigation_Protocol>` steps
5. **Self-review**: Re-read each change and confirm it is purely structural with zero logic alteration. If a change could affect behavior under any edge case, revert it. If the git diff is not excessively large and appears to be simplification work, use it as a reference for before/after comparison
6. **Verify**: Run build and tests to confirm no regressions. Note: uncommitted changes beyond simplification are expected — the user may have pending work that was never committed
7. **Report**: Summarize changes applied and any skipped opportunities

## Codex Delegation

1. **Load protocols**: Read `agents/code-simplifier.md` for the simplification protocol, and `agents/codex-proxy.md` for the Codex prompt template. Use the ralph role's prompt template (`### Role: ralph` section).
2. **Gather context**: Collect scope, file paths, and the code-simplifier protocol content
3. **Call Codex**: Use `codex({ op: "exec", ... })` with the code-simplifier protocol as task context. Pass `working_directory` and `reasoning_effort: "xhigh"`.
4. **Verify**: Read all changed files, compare against the protocol's `<Success_Criteria>`. Confirm each change is purely structural with zero logic alteration — revert any that could affect behavior under any edge case. If the git diff is not excessively large, use it as a reference for before/after comparison
5. **Fix discrepancies**: If Codex violated the protocol (behavior changes, scope creep), fix directly
6. **Post-implementation sequence**: Lint → Build → Test

## Sandbox bypass

Pass `bypass: true` only when the user explicitly requests bypass mode. Otherwise, omit the field.

## Context Enhancement

From the current conversation, identify and include:
- Files recently modified or discussed
- Coding standards or conventions mentioned
- Specific areas the user wants simplified

## Error Policy

If `agents/code-simplifier.md` cannot be read, report the error to the user. Do not fall back to inline execution - the agent protocol is a required dependency.
