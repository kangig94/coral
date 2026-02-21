# MCP Tools

Coral exposes two MCP servers, each with its own tool set:

- **`cx` (Codex)**: 4 tools for Codex CLI session management. Prefix: `mcp__plugin_coral_cx__`
- **`dc` (Discuss)**: 8 tools for moderated multi-agent discussions. Prefix: `mcp__plugin_coral_dc__`

All tool inputs are validated at runtime with zod schemas (`src/codex/schemas.ts`, `src/discuss/schemas.ts`). Model names only allow the `[a-zA-Z0-9][a-zA-Z0-9._-]*` pattern (flag injection prevention).

---

# Codex Tools (`cx`)

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

---

# Discuss Tools (`dc`)

The discuss MCP server manages moderated multi-agent discussion sessions. Sessions are stored as directories under `{project}/.claude/coral/discuss/`. State mutations are serialized via a cross-process `mkdir`-based lock.

Session IDs follow the format `yymmdd-HHmm-xxxx` (compact timestamp + 4-char random suffix). Legacy format `YYYYMMDD-HHmmss-xxxx` is also accepted.

---

## discuss_create

Initialize a new discussion session with agent personas.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `topic` | string | Yes | Discussion topic |
| `agents` | array | Yes | 2–8 agents, each with `name` (ASCII identifier) and `persona` (text) |
| `quota_per_epoch` | integer | No | Max speeches per agent per epoch (default: 3, max: 10) |
| `recent_turns` | integer | No | Recent turns shown in transcript (default: 5, max: 20) |

### Output (JSON)

```json
{
  "session_id": "260221-1430-a1b2",
  "session_dir": "260221-1430-a1b2-ai-ethics",
  "team_name": "coral-dc-260221-1430-a1b2",
  "agents": ["alice", "bob", "charlie"],
  "topic": "AI ethics in healthcare",
  "status": "setup"
}
```

---

## discuss_bid

Submit a speaking desire score. During regular bidding: 0–100 (higher = stronger desire to speak). During voting: 0 = agree to end, 1 = disagree (triggers new epoch).

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Session ID |
| `agent_name` | string | Yes | Agent name |
| `score` | integer | Yes | Desire score 0–100 (voting: 0=agree, 1=disagree) |

### Output (JSON)

```json
{
  "accepted": true,
  "pending_bidders": ["charlie"]
}
```

---

## discuss_wait

Block until a condition is fulfilled or timeout expires. This is the primary coordination mechanism — replaces manual polling of `discuss_state`.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Session ID |
| `condition` | string | Yes | `all_bids`, `speech_delivered`, or `action_needed` |
| `timeout_seconds` | number | Yes | Max wait (limits: all_bids=60, speech_delivered=120, action_needed=180) |
| `agent_name` | string | Conditional | Required for `action_needed` condition |

### Conditions

| Condition | Blocks Until | Used By |
|---|---|---|
| `all_bids` | All agents have submitted bids. Auto-resolves winner. | discuss-lead |
| `speech_delivered` | Current speaker has called discuss_speak | discuss-lead |
| `action_needed` | This agent has an action to perform (bid/speak/vote) | discussant |

### Output — `all_bids` (auto-resolve)

Returns one of 4 result shapes:

```json
{ "fulfilled": true, "winner": "alice", "resolve_type": "normal", "step": 3 }
{ "fulfilled": true, "vote_required": true, "step": 3, "all_bids": {...} }
{ "fulfilled": true, "no_winner": true, "step": 3, "reason": "..." }
{ "fulfilled": true, "end_vote": true, "unanimous": true }
```

### Output — `action_needed`

```json
{ "fulfilled": true, "action": "bid", "elapsed_ms": 1200 }
{ "fulfilled": true, "action": "speak", "elapsed_ms": 500 }
{ "fulfilled": true, "action": "vote", "elapsed_ms": 800 }
```

### Output — timeout

```json
{ "fulfilled": false, "elapsed_ms": 60000 }
```

---

## discuss_speak

Record a speech. Only allowed when the calling agent is the current speaker.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Session ID |
| `agent_name` | string | Yes | Speaking agent name (must match current_speaker) |
| `content` | string | Yes | Speech content |

### Output (JSON)

```json
{
  "recorded": true,
  "step": 3,
  "quota_remaining": 2
}
```

---

## discuss_transcript

Read the discussion transcript. Three modes: `recent` (default, last N entries), `full` (restricted: current speaker or ended session), `summary` (epoch-level overview).

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Session ID |
| `agent_name` | string | No | Caller agent name (required for `full` mode unless session ended) |
| `mode` | string | No | `full`, `recent`, or `summary` (default: `recent`) |
| `last_n` | integer | No | Override `recent_turns` setting (1–50) |

### Output

Returns formatted markdown transcript text.

---

## discuss_state

Query current session state. Bid scores are NOT exposed — they are only visible via `discuss_wait(all_bids)` auto-resolve results.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Session ID |

### Output (JSON)

```json
{
  "session_id": "260221-1430-a1b2",
  "status": "bidding",
  "step": 5,
  "epoch": 1,
  "current_speaker": null,
  "agents": {
    "alice": { "quota_remaining": 2, "total_speaks": 1 },
    "bob": { "quota_remaining": 3, "total_speaks": 0 }
  }
}
```

---

## discuss_end

Finalize the discussion. Normal end includes an optional synthesis. Force-end requires a reason string (used for timeouts or errors).

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Session ID |
| `synthesis` | string | No | Conclusion/synthesis text |
| `force` | boolean | No | Force-end during active speech or voting (default: false) |
| `reason` | string | Conditional | Required when `force=true` |

### Output (JSON)

```json
{
  "ended": true,
  "session_id": "260221-1430-a1b2",
  "final_step": 12,
  "total_speeches": 8
}
```

---

## discuss_epoch_summary

Append an epoch summary to the transcript. Teamlead-only. One summary per epoch, must match current epoch number.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Session ID |
| `epoch` | integer | Yes | Epoch number (must match current epoch, min: 1) |
| `summary` | string | Yes | Summary of the completed epoch |

### Output (JSON)

```json
{
  "recorded": true,
  "epoch": 1
}
```

---

# cx ↔ dc Integration

The `cx` (Codex) and `dc` (Discuss) MCP servers do **not** communicate directly at runtime. They are independent processes with no shared state or IPC.

## Coupling Points

The coupling is through the **agent protocol layer**, not the MCP servers themselves:

| Component | Role |
|-----------|------|
| `discuss-lead.md` | Spawns `persona-generator` agents (via Task tool) and `discussant` teammates for discussions |
| `agents/codex-*.md` | Codex-delegated agents that can be spawned independently or within discuss workflows |
| `hooks/detect-codex-agent.sh` | SubagentStart hook detects `codex-` prefix in agent names, injects delegation instructions to call `codex_session_create` |

The discuss system itself does **not** spawn codex-prefixed agents. The coupling only exists when a user or external workflow spawns a codex-delegated agent that happens to run within a discuss context.

## Session Naming Convention

- Discuss session IDs: `yymmdd-HHmm-xxxx` (managed by dc)
- Discuss session dirs: `{session_id}-{topic_slug}` (managed by dc)
- Discuss teams: `coral-dc-{session_id}` (managed by Claude Code Agent Teams)
- Codex sessions: `session-{timestamp}` or user-provided name (managed by cx)

These namespaces do not overlap. Collision risk is between discuss sessions only (mitigated by 4-char random suffix per timestamp-minute).

## Contract

1. **dc never calls cx tools** — the discuss MCP server has no dependency on the codex MCP server
2. **cx never reads dc state** — Codex sessions have no awareness of discuss sessions
3. **Hook is the sole bridge** — `detect-codex-agent.sh` is the single point where a codex-delegated workflow and the Codex CLI connect
4. **Modifying either server independently is safe** — as long as the hook contract (agent name prefix matching) is preserved
