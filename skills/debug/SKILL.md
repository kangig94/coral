---
name: debug
description: "Systematic bug diagnosis via hypothesis testing and root cause analysis."
argument-hint: "[codex:|claude:]<bug description or error message>"
---

# Bug Diagnosis

Systematically diagnose bugs through hypothesis testing and evidence-based reasoning.

## Argument Routing

| Argument | Mode |
|----------|------|
| `<prompt>` (no prefix) | Claude-native (default) |
| `claude:<prompt>` | Claude-native |
| `codex` | Codex delegation (context from conversation) |
| `codex:<prompt>` | Codex delegation |

Strip the prefix before passing the prompt to the execution path.

## Claude-native Execution (default)

1. **Load protocol**: Read `agents/debugger.md`. **You** execute it directly - do NOT spawn a debugger agent.
2. **Gather symptoms**: Error messages, stack traces, failing tests from argument + conversation context
3. **Execute protocol**: Follow `<Investigation_Protocol>` steps
4. **Report**: Present diagnosis in `<Output_Format>` structure
5. **Handoff suggestion**: If fix is clear, suggest `/ralph` to implement

## Codex Delegation

1. **Load protocols**: Read `agents/debugger.md` for diagnosis protocol, and `agents/codex-proxy.md`
   for the Codex prompt template. Use the analyst role's prompt template (`### Role: analyst` section).
2. **Gather context**: Symptoms, file paths, error messages
3. **Call Codex**: Use `codex({ op: "exec", ... })` with debugger protocol as task context.
   Pass `working_directory` and `reasoning_effort: "xhigh"`.
4. **Verify**: Read cited file:line references, confirm findings accuracy
5. **Fix discrepancies**: Drop findings with incorrect references

## Sandbox bypass

When operating in bypass permissions mode, pass `dangerously_bypass_sandbox: true` to all
`codex({ op: "exec", ... })` calls. Otherwise, omit the field.

## Error Policy

If `agents/debugger.md` cannot be read, report the error to the user.
