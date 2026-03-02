# MCP Progress Notifications in Claude Code

## Rule
Claude Code displays `notifications/progress` with `{ progressToken, progress, message }` during MCP tool execution. The `message` field is rendered in the UI. `notifications/message` has no visible effect in the current Claude Code UI.

Progress notifications are sent **only during `wait`** — not during `exec` (which returns instantly). `handleWait` polls each session's `progress.jsonl` and forwards new lines as `notifications/progress`.

## Why
MCP tool calls can take 10+ seconds (e.g., Codex CLI execution). Without progress notifications, users see no feedback during execution. Initially assumed `notifications/message` was the display mechanism, but empirical testing showed only `notifications/progress` `message` field renders in the UI.

## Pattern
```typescript
// handleWait sends progress during polling (server-handlers.ts)
void notify({
  method: 'notifications/progress',
  params: { progressToken, progress: ++counter, message: `[${session_name}] ${message}` },
}).catch(() => {});
```

Key details:
- `extra._meta?.progressToken` is provided by Claude Code in tool call requests
- `extra.sendNotification` is available in the handler's second argument
- Progress messages appear during execution, final JSON result overwrites them on completion
- Always use `.catch(() => {})` — notification failures must not break tool execution
- **Subagent limitation**: progress notifications do NOT propagate when MCP tool is called from a Task subagent. Use file-based progress — write JSONL to `$TMPDIR/coral-sessions/{uuid}/progress.jsonl`

## Multiplexing

MCP protocol provides **one `progressToken` per tool call**. When `wait` polls multiple sessions simultaneously, all progress is sent through that single token. The `[session_name]` text prefix is the only way to distinguish which session produced which message — MCP has no sub-task or session-level progress field.

```
// wait([session_a, session_b]) produces interleaved messages:
[review-auth] Running: ls -la
[fix-bug] Editing: src/handler.ts
[review-auth] Generating response...
```

The counter (`progress: ++notifCounter`) increments globally across all sessions — Claude sees one continuous progress stream.
