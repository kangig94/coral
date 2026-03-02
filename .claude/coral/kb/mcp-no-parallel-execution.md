# Codex Parallelism with Background Exec

## Rule
When using the Codex MCP tool, a single agent can dispatch many jobs in parallel by issuing multiple `codex({ op: "exec" | "coral:<agent>" })` calls, collecting `job_id`s, then using a cursor-aware `wait` loop until the pending set is empty. Subagents are optional, not required for Codex parallelism.

## Why
`exec` now returns immediately with `{ job_id, job_dir, status: "running" }`. The bottleneck is not job start but completion tracking. `wait` has any-semantics (returns one completed job or timeout), so callers must loop and update `pendingJobIds` + `cursors` to consume all completions without replaying progress.

## Pattern
```
# Dispatch N jobs quickly from one agent
pending = set()
for group in file_groups:
    job = codex({ op: "exec", prompt: group, working_directory })
    pending.add(job.job_id)

cursors = {}
while pending:
    w = codex({ op: "wait", job_ids: list(pending), timeout_seconds: 30, cursors })
    if w.status == "timeout":
        cursors = w.cursors
        continue
    if w.status == "completed":
        Read(w.job_dir + "/result.md")
        pending.remove(w.completed_job_id)
        cursors = w.cursors
        continue
    if w.status == "error":
        Read(w.job_dir + "/status.json")  # extract error
        pending.remove(w.completed_job_id)
        cursors = w.cursors
```

Use subagents when work itself must branch across independent reasoning contexts, not as a workaround for Codex MCP parallel dispatch.
