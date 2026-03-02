# Codex Parallelism with Background Exec

## Rule
When using the Codex MCP tool, a single agent can dispatch many sessions in parallel by issuing multiple `codex({ op: "exec" | "coral:<agent>" })` calls, collecting `session` UUIDs, then using a cursor-aware `wait` loop until the pending set is empty. Subagents are optional, not required for Codex parallelism.

## Why
`exec` now returns immediately with `{ session, session_dir, status: "running" }`. The bottleneck is not launch but completion tracking. `wait` has any-semantics (returns one completed session or timeout), so callers must loop and update `pendingSessions` + `cursors` to consume all completions without replaying progress.

## Pattern
```
# Dispatch N sessions quickly from one agent
pending = set()
for group in file_groups:
    run = codex({ op: "exec", prompt: group, working_directory })
    pending.add(run.session)

cursors = {}
while pending:
    w = codex({ op: "wait", sessions: list(pending), timeout_seconds: 30, cursors })
    if w.status == "timeout":
        cursors = w.cursors
        continue
    if w.status == "completed":
        Read(w.session_dir + "/result.md")
        pending.remove(w.completed_session)
        cursors = w.cursors
        continue
    if w.status == "error":
        Read(w.session_dir + "/status.json")  # extract error
        pending.remove(w.completed_session)
        cursors = w.cursors
```

Use subagents when work itself must branch across independent reasoning contexts, not as a workaround for Codex MCP parallel dispatch.
