# MCP Progress Notifications in Claude Code

## Rule
Claude Code displays `notifications/progress` with `{ progressToken, progress, message }` during MCP tool execution. The `message` field is rendered in the UI. `notifications/message` has no visible effect in the current Claude Code UI.

## Why
MCP tool calls can take 10+ seconds (e.g., Codex CLI execution). Without progress notifications, users see no feedback during execution. Initially assumed `notifications/message` was the display mechanism, but empirical testing showed only `notifications/progress` `message` field renders in the UI.

## Pattern
```typescript
// Works - message displayed in Claude Code UI during execution
void sendNotification({
  method: 'notifications/progress',
  params: { progressToken, progress: ++counter, message: `[Codex] ${message}` },
}).catch(() => {});

// Does NOT display in Claude Code UI - removed from codebase
// void sendNotification({
//   method: 'notifications/message',
//   params: { level: 'info', data: message },
// }).catch(() => {});
```

Key details:
- `extra._meta?.progressToken` is provided by Claude Code in tool call requests
- `extra.sendNotification` is available in the handler's second argument
- Progress messages appear during execution, final JSON result overwrites them on completion
- Always use `.catch(() => {})` — notification failures must not break tool execution
- **Subagent limitation**: progress notifications do NOT propagate when MCP tool is called from a Task subagent. Use file-based progress (`progress.ts`) for subagent visibility — write JSONL to `{tmpdir}/coral-progress-{uuid}.jsonl`
