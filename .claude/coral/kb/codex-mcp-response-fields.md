# Codex MCP Exec: Instant Return + File-Based Result Retrieval

## Rule
The codex MCP `exec` response returns immediately with `{ session, session_dir, session_name, status: "running" }` where `session` is the coral UUID. It never blocks and never includes response text inline. Callers must: (1) call `wait({ sessions: [...] })` to poll completion, and (2) read the terminal result by job kind: workflow callers use `result.content ?? Read(result.path)`, while provider callers prefer `result.content` and treat `result.path` as a best-effort recovery artifact when content is absent. Use the `session` UUID from the exec/fork response for continuity; do not extract continuity data from `status.json`.

## Why
Without this pattern, callers block expecting `{ response }` inline but receive a background handle instead, causing missing output handling. A universal `Read(session_dir + "/result.md")` rule also hides the workflow/provider split in the path-first wait contract. Continuity breaks when callers ignore the exec/fork `session` UUID and try to recover it from status metadata.

## Pattern
```
// MCP exec response shape (server-handlers.ts, launchJob):
{
  session: "uuid",           // coral session UUID — pass to wait/abort/resume
  session_dir: "/tmp/coral-sessions/uuid",  // directory path
  session_name: "my-review",        // display label — show to user, NOT a continuity key
  status: "running"
}

// After wait({ sessions: [session] }) returns status == "completed":
const result = wait({ sessions: [session] }).result;
if (result.workflow) {
  show(result.content ?? Read(result.path));
} else {
  show(result.content);
  // result.path is best-effort recovery only until provider persistence is hardened
}
// Use the same coral UUID for next exec call:
codex({ op: "exec", session: "uuid", prompt, work_dir })

// Skill presentation:
// Show response from result.md, then append: `session: <session_name>`
// Never show raw session UUID, model, duration_ms
```
