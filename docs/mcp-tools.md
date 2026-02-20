# MCP Tools

The Coral MCP server provides 4 tools. Inside Claude Code's plugin system, tools are accessible via the `mcp__plugin_coral_cx__` prefix (composed as `mcp__plugin_<plugin>_<server>__<tool>`).

All tool inputs are validated at runtime with zod schemas (`src/mcp/schemas.ts`). Model names only allow the `[a-zA-Z0-9][a-zA-Z0-9._-]*` pattern (flag injection prevention).

## codex_session_create

Create a Codex session. The sole entry point for all Codex execution. Internally calls `executeOneShot()` and registers the returned thread ID.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | No | Session name (auto-generated as `session-{timestamp}` if omitted) |
| `prompt` | string | Yes | Prompt to send to Codex (min 1 char) |
| `model` | string | No | Model to use (default: `gpt-5.3-codex`, configurable via `CORAL_CODEX_MODEL`) |
| `working_directory` | string | No | Working directory |
| `reasoning_effort` | string | No | Model reasoning effort: `low`, `medium`, `high`, `xhigh` |
| `background` | boolean | No | Run in background (default: `false`). Returns immediately with progress info. |

### Output — Foreground (default)

```json
{
  "response": "Codex response text",
  "thread_id": "codex-thread-uuid",
  "session_name": "my-review",
  "model": "gpt-5.3-codex",
  "duration_ms": 4100,
  "errors": [],
  "warnings": []
}
```

If no thread ID is returned, registration is skipped with a `notice` field. `errors`/`warnings`/`exit_code` are conditionally included.

During foreground execution, `[Codex]` prefixed progress messages are sent via `notifications/progress`.

### Output — Background (`background: true`)

```json
{
  "progress_id": "uuid",
  "progress_file": "/tmp/coral-progress-uuid.jsonl",
  "session_name": "my-review",
  "status": "launched"
}
```

Progress is written to the JSONL file with a terminal `completed` or `error` event on finish.

---

## codex_session_send

Send a follow-up prompt to an existing session. Uses `codex exec resume THREAD_ID` to continue the conversation.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Session name or Codex thread ID (min 1 char) |
| `prompt` | string | Yes | Follow-up prompt (min 1 char) |
| `model` | string | No | Model to use |
| `working_directory` | string | No | Working directory |
| `reasoning_effort` | string | No | Model reasoning effort: `low`, `medium`, `high`, `xhigh` |
| `background` | boolean | No | Run in background (default: `false`) |

### Lookup Logic

1. `SessionManager.get(session)` — search by name first
2. If name doesn't match, search by `codexThreadId`
3. If not in registry, return error (`Session not found`). Raw thread IDs are not accepted — all sessions must be created via `codex_session_create`.

### Output (JSON)

```json
{
  "response": "Codex follow-up response",
  "thread_id": "codex-thread-uuid",
  "session_name": "my-review",
  "model": "gpt-5.3-codex",
  "duration_ms": 2800
}
```

`errors`/`warnings`/`exit_code` conditionally included. On success, the `lastUsedAt` timestamp is automatically updated.

---

## codex_session_list

Return the list of registered sessions.

### Input Schema

No parameters (empty object).

### Output (JSON)

```json
{
  "sessions": [
    {
      "name": "my-review",
      "thread_id": "uuid-1",
      "model": "gpt-5.3-codex",
      "created_at": "2026-02-18T08:30:00.000Z",
      "last_used_at": "2026-02-18T09:15:00.000Z",
      "working_directory": "/home/user/project"
    }
  ],
  "total": 1
}
```

Only shows sessions registered in the Coral registry.

---

## codex_session_fork

Fork an existing session to continue the conversation in a new branch.

> **Note**: `codex fork` is a TUI-only command and cannot run headlessly. Internally uses `codex exec resume` for resume-based forking.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Source session name or registered thread ID (must exist in Coral registry) |
| `name` | string | No | New session name (registered if specified) |
| `prompt` | string | No | Additional prompt for the forked session |
| `model` | string | No | Model to use |
| `working_directory` | string | No | Working directory |
| `reasoning_effort` | string | No | Model reasoning effort: `low`, `medium`, `high`, `xhigh` |
| `background` | boolean | No | Run in background (default: `false`) |

### Output (JSON)

```json
{
  "response": "Forked session response",
  "thread_id": "thread-uuid",
  "forked_from": "original-thread-uuid",
  "session_name": "forked-review",
  "model": "gpt-5.3-codex",
  "duration_ms": 3500
}
```

`errors`/`warnings`/`exit_code` conditionally included. If `name` is not specified, the session exists only in Codex and is not registered in the Coral registry.
