# AX Parallelism with Background Exec

## Rule
When using the AX MCP tools, a single agent can dispatch many sessions in parallel by issuing multiple `codex({ op: "exec" | "coral:<agent>" })` or `claude({ op: "exec" | "coral:<agent>" })` calls, collecting `session` UUIDs, then looping `wait` (standalone AX tool, provider-agnostic) until the pending set is empty. Subagents are optional, not required for parallelism.

## Why
`exec` returns immediately with `{ session, session_dir, status: "running" }`. The bottleneck is not launch but completion tracking. `wait` is a standalone AX tool that accepts sessions from any provider (codex or claude). It has any-semantics (returns one completed session or timeout), so callers must loop and update only `pendingSessions` until all launched sessions are handled.

## Pattern
```
# Dispatch N sessions quickly from one agent (any mix of codex/claude)
pending = set()
for group in file_groups:
    run = codex({ op: "exec", prompt: group, work_dir })
    pending.add(run.session)

while pending:
    w = wait({ sessions: list(pending), timeout_seconds: 30 })
    if w.status == "timeout":
        continue
    if w.status == "completed":
        Read(w.session_dir + "/result.md")
        pending.remove(w.completed_session)
        continue
    if w.status == "error":
        Read(w.session_dir + "/status.json")  # extract error
        pending.remove(w.completed_session)
```

Use subagents when work itself must branch across independent reasoning contexts, not as a workaround for AX parallel dispatch.
