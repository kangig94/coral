# MCP Progress Notifications in Claude Code

## Rule
Claude Code displays `notifications/progress` with `{ progressToken, progress, message }` during MCP tool execution. The `message` field is rendered in the UI. `notifications/message` has no visible effect in the current Claude Code UI.

Progress notifications are sent **only during `wait`** — not during `exec` (which returns instantly). `handleWait` polls each session's `progress.jsonl` every 500ms and forwards the **last complete line** as `notifications/progress` when the raw `message` field changes (dedup via `lastSent` Map per session).

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

MCP protocol provides **one `progressToken` per tool call**. When `wait` polls multiple sessions simultaneously, all progress is sent through that single token. The `[session_name]` text prefix is the only way to distinguish which session produced which message.

Each tick sends at most one notification per session (only when the `message` field changes). The counter (`progress: ++notifCounter`) increments globally — Claude sees one continuous progress stream.

## Partial-line safety

`progress.jsonl` is appended by the Codex executor while `wait` reads it. To avoid parsing in-flight partial writes, `handleWait` uses `lastIndexOf('\n')` to find the last complete line before parsing.
