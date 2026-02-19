# MCP Tools

The Coral MCP server provides 5 tools, all accessible via the `mcp__cx__` prefix.

All tool inputs are validated at runtime with zod schemas (`src/mcp/schemas.ts`). Model names only allow the `[a-zA-Z0-9][a-zA-Z0-9._-]*` pattern (flag injection prevention).

## codex_execute

One-shot Codex CLI execution. The most basic tool.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | Yes | Prompt to send to Codex (min 1 char) |
| `model` | string | No | Model to use (default: `gpt-5.3-codex`, configurable via `CORAL_CODEX_MODEL`) |
| `working_directory` | string | No | Codex working directory |
| `save_session` | string | No | If specified, auto-registers the session with this name |

### Output (JSON)

```json
{
  "response": "Codex response text",
  "thread_id": "codex-thread-uuid-or-null",
  "model": "gpt-5.3-codex",
  "duration_ms": 3200,
  "saved_as": "my-session",
  "exit_code": 1,
  "errors": ["fatal error message"],
  "warnings": ["warning message"]
}
```

`exit_code`, `errors`, and `warnings` are conditionally included — only present when non-zero exit code or non-empty arrays.

### Internal Behavior

1. Zod schema validation (`codexExecuteSchema`)
2. Check CLI existence via `detectCodexCli()` (cached)
3. Prepend CLAUDE.md content to prompt (behavioral guidelines for Codex)
4. Run `codex exec -m MODEL --json --full-auto`
5. Pass prompt via stdin then close
6. Parse stdout JSONL with `parseCodexJsonl()` -> `{ response, threadId, errors, warnings }`
7. If `save_session` is specified, call `SessionManager.register()`

---

## codex_session_create

Create a named Codex session. Internally calls `executeOneShot()` and registers the returned thread ID.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Session name (min 1 char, used for later lookup/resume) |
| `prompt` | string | Yes | Session start prompt (min 1 char) |
| `model` | string | No | Model to use |
| `working_directory` | string | No | Working directory |

### Output (JSON)

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

---

## codex_session_send

Send a follow-up prompt to an existing session. Uses `codex exec resume THREAD_ID` to continue the conversation.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Session name or Codex thread ID (min 1 char) |
| `prompt` | string | Yes | Follow-up prompt (min 1 char) |
| `model` | string | No | Model to use |

### Lookup Logic

1. `SessionManager.get(session)` — search by name first
2. If name doesn't match, search by `codexThreadId`
3. If not in registry, use `session` value as raw Codex thread ID (passed to spawn without shell, so injection-safe)

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
| `session` | string | Yes | Source session name or thread ID (min 1 char) |
| `name` | string | No | New session name (registered if specified) |
| `prompt` | string | No | Additional prompt for the forked session |
| `model` | string | No | Model to use |

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
