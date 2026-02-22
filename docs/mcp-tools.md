# MCP Tools

Coral exposes two MCP servers, each with its own tool set:

- **`cx` (Codex)**: 1 tool for Codex CLI session management. Prefix: `mcp__plugin_coral_cx__`
- **`dc` (Discuss)**: 2 tools for moderated multi-agent discussions. Prefix: `mcp__plugin_coral_dc__`

All tool inputs are validated at runtime with zod schemas (`src/codex/schemas.ts`, `src/discuss/schemas.ts`). Model names only allow the `[a-zA-Z0-9][a-zA-Z0-9._-]*` pattern (flag injection prevention).

---

# Codex Tools (`cx`)

## codex

Single entry point for all Codex execution. Use the required `op` discriminator.

### Input Envelope

| Parameter | Type | Required | Description |
|---|---|---|---|
| `op` | string | Yes | One of: `exec`, `list`, `fork`, `abort` |

### op: exec

Create a new Codex session when `session` is omitted (calls `executeOneShot()`) or resume an existing session when `session` is present (calls `executeResume()`).

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | No | Session name (auto-generated as `session-{timestamp}` if omitted) |
| `prompt` | string | Yes | Prompt to send to Codex (min 1 char) |
| `model` | string | No | Model to use (default: `gpt-5.3-codex`, configurable via `CORAL_CODEX_MODEL`) |
| `working_directory` | string | No | Working directory |
| `reasoning_effort` | string | No | Model reasoning effort: `low`, `medium`, `high`, `xhigh` |
| `background` | boolean | No | Run in background (default: `false`). Returns immediately with progress info. |
| `bypass` | boolean | No | Bypass Codex sandbox and approval checks (default: `false`). Only set to `true` when the user explicitly requests bypass mode. |

### Output - Foreground (default)

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

### Output - Background (`background: true`)

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

### op: exec

Send a follow-up prompt to an existing session. Uses `codex exec resume THREAD_ID` to continue the conversation.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | No | Session name or Codex thread ID (min 1 char). Omit to start a new session. |
| `prompt` | string | Yes | Prompt to send (min 1 char). Required for both create and resume cases. |
| `model` | string | No | Model to use |
| `working_directory` | string | No | Working directory |
| `reasoning_effort` | string | No | Model reasoning effort: `low`, `medium`, `high`, `xhigh` |
| `background` | boolean | No | Run in background (default: `false`) |
| `bypass` | boolean | No | Bypass Codex sandbox and approval checks (default: `false`). Only set to `true` when the user explicitly requests bypass mode. |

### Lookup Logic

1. `SessionManager.get(session)` - search by name first
2. If name doesn't match, search by `codexThreadId`
3. If not in registry, return error (`Session not found`). Raw thread IDs are not accepted - all sessions must be created via `codex({ op: "exec", ... })`.

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

### op: list

Return the list of registered sessions.

### Input Schema

No parameters (empty object). This envelope is strict.

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
      "working_directory": "/home/user/project",
      "status": "completed"
    }
  ],
  "total": 1
}
```

`status` is `"running"` while a prompt is being executed, `"completed"` otherwise.

Only shows sessions registered in the Coral registry.

---

### op: fork

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
| `bypass` | boolean | No | Bypass Codex sandbox and approval checks (default: `false`). Only set to `true` when the user explicitly requests bypass mode. |

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

### op: abort

Abort an active execution.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Session name or thread ID |

### Output (JSON)

```json
{
  "session_name": "my-review",
  "status": "abort_requested"
}
```

---

# Discuss Tools (`dc`)

The discuss MCP server manages moderated multi-agent discussion sessions. Sessions are stored as directories under `{project}/.claude/coral/discuss/`. State mutations are serialized via a cross-process `mkdir`-based lock.

Session IDs follow the format `yymmdd-HHmm-xxxx` (compact timestamp + 4-char random suffix). Legacy format `YYYYMMDD-HHmmss-xxxx` is also accepted.

---

## discuss (agent tool)

Agent-facing MCP tool for participant actions only:

| Operation | Input |
|---|---|
| `bid` | `session`, `agent_name`, `score` (0-100) |
| `speak` | `session`, `agent_name`, `content` |

`bid` returns one of:

- `{ action: 'speak' }`
- `{ action: 'listen'; speaker; content }` (includes epoch summaries with `speaker: null`)
- `{ action: 'session_ended'; reason; content }`

`speak` records speech and returns the updated status/step on success.

## discuss_lead (moderator tool)

Moderator-only MCP tool for control and lifecycle:

| Operation | Input |
|---|---|
| `_1_seed` | `controversy_axes`, `n`, optional `seed` |
| `_2_create` | `topic`, `agents`, optional `quota_per_epoch`, `recent_turns` |
| `_3_step` | `session`, `timeout_seconds` (1-120), optional `speech_force_timeout` |
| `_4_transcript` | `session`, `mode`, optional `last_n` |
| `_5_epoch` | `session`, `epoch`, `summary` |
| `_6_state` | `session` |
| `_7_end` | `session`, optional `synthesis`, optional `force`, optional `reason` |

`_3_step` is a mode-specific block:

- setup: moves setup → bidding, returns `{ status: 'setup', phase: 'not_ready' }` if not ready.
- bidding: runs hold/release cycle and returns one of:
  - `{ status: 'bidding', phase: 'bidding', pending_bidders, hold_count }`
  - `{ status: 'bidding', phase: 'resolved', winner }`
  - `{ status: 'bidding', phase: 'epoch_transition', epoch }`
- `{ status: 'bidding', phase: 'ended', reason }` (`all_below_threshold`, `max_epochs_reached`, `all_blocked`, `no_participants`)
- `{ status: 'bidding', phase: 'expelled', agents, hint }`
- speaking: waits for speech or auto process:
  - `{ status: 'speaking', phase: 'speech_done', speaker, content }`
  - `{ status: 'speaking', phase: 'speech_pending', elapsed }`
  - `{ status: 'speaking', phase: 'speech_timeout', speaker }`
  - `{ status: 'ended', phase: 'ended', reason }`

`_7_end` finalizes sessions. On already-ended sessions, it records a synthesis if provided and no-ops otherwise.

---

# cx ↔ dc Integration

The `cx` (Codex) and `dc` (Discuss) MCP servers do **not** communicate directly at runtime. They are independent processes with no shared state or IPC.

## Coupling Points

The coupling is through the **agent protocol layer**, not the MCP servers themselves:

| Component | Role |
|-----------|------|
| `discuss-lead.md` | Spawns `persona-generator` agents (via Task tool) and `discussant` teammates for discussions |
| `agents/codex-*.md` | Codex-delegated agents that can be spawned independently or within discuss workflows |
| `hooks/detect-codex-agent.sh` | SubagentStart hook detects `codex-` prefix in agent names, injects delegation instructions to call `codex({ op: "exec", ... })` |

The discuss system itself does **not** spawn codex-prefixed agents. The coupling only exists when a user or external workflow spawns a codex-delegated agent that happens to run within a discuss context.

## Session Naming Convention

- Discuss session IDs: `yymmdd-HHmm-xxxx` (managed by dc)
- Discuss session dirs: `{session_id}-{topic_slug}` (managed by dc)
- Discuss teams: `coral-dc-{session_id}` (managed by Claude Code Agent Teams)
- Codex sessions: `session-{timestamp}` or user-provided name (managed by cx)

These namespaces do not overlap. Collision risk is between discuss sessions only (mitigated by 4-char random suffix per timestamp-minute).

## Contract

1. **dc never calls cx tools** - the discuss MCP server has no dependency on the codex MCP server
2. **cx never reads dc state** - Codex sessions have no awareness of discuss sessions
3. **Hook is the sole bridge** - `detect-codex-agent.sh` is the single point where a codex-delegated workflow and the Codex CLI connect
4. **Modifying either server independently is safe** - as long as the hook contract (agent name prefix matching) is preserved
