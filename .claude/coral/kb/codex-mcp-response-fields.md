# Codex MCP Exec: Instant Return + File-Based Result Retrieval

## Rule
The codex MCP `exec` response returns immediately with `{ job_id, job_dir, session_name, status: "running" }`. It never blocks and never includes the Codex response text inline. Callers must: (1) call `wait(job_ids)` to poll completion, (2) `Read(job_dir + "/result.md")` for the response text, (3) `Read(job_dir + "/status.json")` for the `session` field (Codex thread UUID) when session continuity is needed. `session_name` in the exec response is a display label only — do NOT pass it as the `session` parameter.

## Why
Without this pattern, callers block expecting `{ response, session }` inline but receive `{ job_id, job_dir }` instead — resulting in missing response text and broken session continuity. The `session` UUID lives in `status.json` only after the job completes, so callers that try to capture `session` from the exec response get `undefined`.

## Pattern
```
// MCP exec response shape (server-handlers.ts, launchJob):
{
  job_id: "uuid",           // UUID — pass to wait()
  job_dir: "/tmp/coral-jobs/uuid",  // directory path
  session_name: "my-review",        // display label — show to user, NOT a continuity key
  status: "running"
}

// After wait({ job_ids: [job_id] }) returns status == "completed":
Read(job_dir + "/result.md")   → response text (show this)
Read(job_dir + "/status.json") → { session: "codex-thread-uuid", session_name, status, ... }
// Use session UUID for next exec call:
codex({ op: "exec", session: "codex-thread-uuid", prompt, working_directory })

// Skill presentation:
// Show response from result.md, then append: `session: <session_name>`
// Never show raw session UUID, model, duration_ms
```
