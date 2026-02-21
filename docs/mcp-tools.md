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

## discuss

Unified discussion session tool. Select behavior with the required `op` field.

### Input Schema (Envelope)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `op` | string | Yes | One of: `create`, `bid`, `wait`, `speak`, `transcript`, `state`, `end`, `epoch_summary` |

### operation: create

Initialize a new discussion session with agent personas.

#### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `topic` | string | Yes | Discussion topic |
| `agents` | array | Yes | 2–8 agents, each with `name` (ASCII identifier) and `persona` (text) |
| `quota_per_epoch` | integer | No | Max speeches per agent per epoch (default: 3, max: 10) |
| `recent_turns` | integer | No | Recent turns shown in transcript (default: 5, max: 20) |

#### Output (JSON)

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

### op: bid

Submit a speaking desire score 0–100 (higher = stronger desire to speak).

#### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Session ID |
| `agent_name` | string | Yes | Agent name |
| `score` | integer | Yes | Desire score 0–100 |

#### Output (JSON)

```json
{
  "accepted": true,
  "pending_bidders": ["charlie"]
}
```

### op: wait

Block until a condition is fulfilled or timeout expires. This is the primary coordination mechanism and replaces manual polling of `discuss({ op: "state", ... })`.

#### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Session ID |
| `condition` | string | Yes | `all_bids`, `speech_delivered`, or `action_needed` |
| `timeout_seconds` | number | Yes | Max wait (limits: all_bids=60, speech_delivered=120, action_needed=180) |
| `agent_name` | string | Conditional | Required for `action_needed` condition |

#### Conditions

| Condition | Blocks Until | Used By |
|---|---|---|
| `all_bids` | All agents have submitted bids. Auto-resolves winner. | discuss-lead |
| `speech_delivered` | Current speaker has called `discuss({ op: "speak", ... })` | discuss-lead |
| `action_needed` | This agent has an action to perform (bid/speak) | discussant |

#### Output - `all_bids` (auto-resolve)

Returns one of 4 result shapes:

```json
{ "fulfilled": true, "winner": "alice", "resolve_type": "normal", "step": 3 }
{ "fulfilled": true, "no_winner": true, "step": 3, "reason": "epoch_transition", "new_epoch": true, "epoch": 2 }
{ "fulfilled": true, "no_winner": true, "step": 3, "reason": "all_below_threshold" }
```

#### Output - `action_needed`

```json
{ "fulfilled": true, "action": "bid", "epoch": 1, "your_speaks": 2 }
{ "fulfilled": true, "action": "speak", "epoch": 1, "your_speaks": 1 }
{ "fulfilled": true, "action": "session_ended", "epoch": 2, "your_speaks": 4 }
```

#### Output - timeout

```json
{ "fulfilled": false, "elapsed_ms": 60000 }
```

### op: speak

Record a speech. Only allowed when the calling agent is the current speaker.

#### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Session ID |
| `agent_name` | string | Yes | Speaking agent name (must match current_speaker) |
| `content` | string | Yes | Speech content |

#### Output (JSON)

```json
{
  "recorded": true,
  "step": 3,
  "quota_remaining": 2
}
```

### op: transcript

Read the discussion transcript. Three modes: `recent` (default, last N entries), `full` (restricted: current speaker or ended session), `summary` (epoch-level overview).

#### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Session ID |
| `agent_name` | string | No | Caller agent name (required for `full` mode unless session ended) |
| `mode` | string | No | `full`, `recent`, or `summary` (default: `recent`) |
| `last_n` | integer | No | Override `recent_turns` setting (1–50) |

#### Output

Returns formatted markdown transcript text.

### op: state

Query current session state. Bid scores are NOT exposed; they are only visible via `discuss({ op: "wait", condition: "all_bids", ... })` auto-resolve results.

#### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Session ID |

#### Output (JSON)

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

### op: end

Finalize the discussion. Normal end includes an optional synthesis. Force-end requires a reason string (used for timeouts or errors).

#### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Session ID |
| `synthesis` | string | No | Conclusion/synthesis text |
| `force` | boolean | No | Force-end during active speech (default: false) |
| `reason` | string | Conditional | Required when `force=true` |

#### Output (JSON)

```json
{
  "ended": true,
  "session_id": "260221-1430-a1b2",
  "final_step": 12,
  "total_speeches": 8
}
```

### op: epoch_summary

Append an epoch summary to the transcript. Teamlead-only. One summary per epoch, must match current epoch number.

#### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Session ID |
| `epoch` | integer | Yes | Epoch number (must match current epoch, min: 1) |
| `summary` | string | Yes | Summary of the completed epoch |

#### Output (JSON)

```json
{
  "recorded": true,
  "epoch": 1
}
```

---

## discuss_persona_seed

Generate diverse persona position assignments using k-DPP (Determinantal Point Process) sampling on controversy axes. Returns deterministic assignments with seed for reproducibility.

### Algorithm

1. Builds a Gaussian RBF kernel over the Cartesian product of all axis positions: `L[i][j] = exp(-hamming²/(2σ²))`, σ = √(dims/2)
2. Samples k items exactly from the k-DPP distribution (Kulesza & Taskar 2012, Algorithm 1): ESP backward sampling + Gram-Schmidt sequential sampling
3. Assigns tone independently via seeded shuffle of 8 TONE_AXES combinations: `{ formality, evidence, pace }`
4. When n > pool_size (and pool > 1): additional slots reuse existing assignments with `shared_position_with` index

Mathematical guarantee: identical position combinations have selection probability = 0 (determinant property).

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `controversy_axes` | array | Yes | Axes with positions. Axis names must be unique; positions within each axis must be unique. |
| `controversy_axes[].axis` | string | Yes | Axis name (e.g., "regulation", "stance") |
| `controversy_axes[].positions` | string[] | Yes | 1–10 positions for this axis |
| `n` | integer | Yes | Number of persona assignments (1–8) |
| `seed` | integer \| null | No | RNG seed for reproducibility. `null` = random (default) |

**Pool size constraint**: The Cartesian product of all axis sizes must not exceed 256. Recommended: keep product ≤ 81 (e.g., 3 axes × 3 positions, or 4 axes × 2-3 positions).

### Output (JSON)

```json
{
  "seed_used": 42,
  "sigma_used": 1.4142135623730951,
  "pool_size": 8,
  "assignments": [
    {
      "positions": { "stance": "pro", "regulation": "market-driven" },
      "tone": { "formality": "formal", "evidence": "data-driven", "pace": "concise" }
    },
    {
      "positions": { "stance": "con", "regulation": "market-driven" },
      "tone": { "formality": "conversational", "evidence": "narrative", "pace": "detailed" },
      "shared_position_with": 1
    }
  ]
}
```

`seed_used` can be passed back as `seed` to reproduce identical assignments.
`shared_position_with` is a 0-based index into `assignments` - present only when n > pool_size.

### Error Responses

| Error | Cause | `detail` fields |
|---|---|---|
| `pool_too_large` | Cartesian product > 256 | `actual_pool_size`, `max_pool_size: 256`, `hint: "Reduce axes or positions"` |
| `pool_degenerate` | pool_size = 1 and n > 1 | `pool_size: 1`, `requested_n`, `hint: "All axes have single position"` |

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
