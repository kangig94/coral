---
name: bugfix
description: "Systematic bug diagnosis, planning, and fix execution."
argument-hint: "[--codex] <bug description or error message>"
---

> **CORAL_AGENTS**: `Glob(pattern: "**/agents/", path: "~/.claude/plugins/cache/coral/")`
> Pass `~` literally to the Glob tool — it expands to the home directory. Do not resolve it yourself.

# Bug Debugging

Before starting, run Bash(`mkdir -p .claude/coral/tmp && touch .claude/coral/tmp/kb-active`).

Diagnose bugs, plan fixes, and execute - end-to-end.

## Argument Routing

| Argument | Mode |
|----------|------|
| `<prompt>` | Claude-native (default) |
| `--codex` | Codex delegation (context from conversation) |
| `--codex <prompt>` | Codex delegation |

Strip the `--codex` flag before passing the prompt to the execution path.

## Execution

1. **Diagnose**:
   - **Default**: Read `CORAL_AGENTS/debugger.md`. **You** execute it directly — follow
     `<Investigation_Protocol>` steps with conversation context.
     Present diagnosis in `<Output_Format>` structure.
   - **`--codex`**: Call `codex({ op: "coral:debugger", prompt, working_directory, reasoning_effort: "xhigh" })`.
     Capture `{ session, session_dir }` from the exec response, then wait in a timeout loop (`wait({ sessions: [session], timeout_seconds })`).
     On completion, read `session_dir/result.md` for findings.
     On error, read `session_dir/status.json` and stop with the Codex error.
     Verify cited file:line references. Drop findings with incorrect references.

2. **Plan fix**: Invoke `Skill({ skill: "coral:plan", args: "--no-handoff fix-{short-bug-description}" })`.
   If `--codex` was passed, append `--codex` to the plan args.
   The plan protocol gathers context from the conversation (diagnosis from step 1).
   Plan should include: what to change, why, and how to verify the fix.

3. **Execute fix**: Invoke `Skill({ skill: "coral:ralph", args: "implement the plan from step 2" })`.
   If `--codex` was passed, append `--codex` to the ralph args.

4. **Project validation**: If project instructions define workflow rules (e.g., review gates,
   post-implementation steps), follow them.

## Sandbox bypass

Pass `bypass: true` only when the user explicitly requests bypass mode. Otherwise, omit the field.

## Error Policy

If `CORAL_AGENTS/debugger.md` cannot be read, report the error to the user.
