# Codex MCP Exec Response: No `thread_id`, Use `session_name`

## Rule
The codex MCP `exec` response never includes a `thread_id` field. What IS returned is `session` (the internal UUID) and `session_name` (the human-readable name). Skills tracking session continuity must look for `session_name`, not `thread_id`. `session_name` is safe to show the user; the raw `session` UUID should stay hidden.

## Why
Codex CLI emits `thread_id` in its JSONL output, but `output-parser.ts:43` explicitly maps it to `sessionId` at the parser boundary: `sessionId = event.thread_id`. The MCP layer then surfaces `sessionId` as the `session` field (UUID) and pairs it with `session_name`. Any skill instruction that says "never show `thread_id`" or "look for thread_id in conversation history" is referencing a field that is never present in the MCP response — session continuity was silently broken.

## Pattern
```
// MCP exec response shape (server-handlers.ts:239-246):
{
  response: string,        // Codex output — show this
  session: string,         // UUID — hide from user
  session_name: string,    // human name — show this, track for continuity
  model: string,           // hide unless asked
  duration_ms: number,     // hide unless asked
}

// Skill session continuity — correct:
// Check for session_name from a prior exec call, pass it as `session` param
codex({ op: "exec", session: session_name, prompt, working_directory })

// Skill presentation — correct:
// Show response, then append: `session: <session_name>`
// Never show raw session UUID, model, duration_ms

// Skill presentation — WRONG (old pattern):
// "Never show thread_id" — field doesn't exist
// "Look for thread_id in conversation history" — never present
```
