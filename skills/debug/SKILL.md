---
name: debug
description: "Systematic bug diagnosis, planning, and fix execution."
argument-hint: "[--codex] <bug description or error message>"
---

# Bug Debugging

Diagnose bugs, plan fixes, and execute — end-to-end.

## Argument Routing

| Argument | Mode |
|----------|------|
| `<prompt>` | Claude-native (default) |
| `--codex` | Codex delegation (context from conversation) |
| `--codex <prompt>` | Codex delegation |

Strip the `--codex` flag before passing the prompt to the execution path.

## Claude-native Execution (default)

1. **Diagnose**: Read `agents/debugger.md`. **You** execute it directly - do NOT spawn
   a debugger agent. Follow `<Investigation_Protocol>` steps with conversation context.
   Present diagnosis in `<Output_Format>` structure.
2. **Plan fix**: Read `agents/planner.md`. **You** execute it directly - do NOT spawn
   a planner agent. Use diagnosis result as task context. Configure reviewers:
   `coral:architect` and `coral:critic` (full review loop, up to 5 rounds).
   Only reviewers are spawned as subagents.
3. **Execute fix**: Read `agents/ralph.md`. **You** execute it directly - do NOT spawn
   a ralph agent. Implement the plan from step 2.
4. **Project validation**: If project instructions define workflow rules (e.g., review gates,
   post-implementation steps), follow them.

## Codex Delegation

1. **Diagnose**: Read `agents/debugger.md` for diagnosis protocol, and `agents/codex-proxy.md`
   for the Codex prompt template. Use the analyst role's prompt template
   (`### Role: analyst` section). Call `codex({ op: "exec", ... })` with debugger protocol
   as task context. Pass `working_directory` and `reasoning_effort: "xhigh"`.
   Verify cited file:line references. Drop findings with incorrect references.
2. **Plan fix**: Read `agents/planner.md`. **You** execute it directly - do NOT spawn
   a planner agent. Use diagnosis result as task context. Configure multi-phase review:
   - Phase 1 reviewers: `coral:codex-proxy` with `Role: architect` and
     `coral:codex-proxy` with `Role: critic` (full review loop, up to 5 rounds)
   - Phase 2 cross-reviewers: `coral:architect` and `coral:critic`
     (single verification pass + one retry)
   Only reviewers are spawned as subagents.
3. **Execute fix**: Read `agents/codex-proxy.md`. Use the ralph role's prompt template
   (`### Role: ralph` section). Call `codex({ op: "exec", ... })` with the plan as task
   context. Pass `working_directory` and `reasoning_effort: "high"`.
   Verify all changes against the plan. Fix discrepancies directly.
4. **Project validation**: If project instructions define workflow rules, follow them.

## Sandbox bypass

Pass `bypass: true` only when the user explicitly requests bypass mode. Otherwise, omit the field.

## Error Policy

If `agents/debugger.md` cannot be read, report the error to the user.
