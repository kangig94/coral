# MCP Tools

Coral exposes two MCP servers, each with its own tool set:

- **`cx` (Codex)**: 1 tool for Codex CLI session management. Prefix: `mcp__plugin_coral_cx__`
- **`dc` (Discuss)**: 2 tools for moderated multi-agent discussions. Prefix: `mcp__plugin_coral_dc__`

All tool inputs are validated at runtime with Zod schemas (`src/codex/schemas.ts`, `src/discuss/schemas.ts`). Model names only allow the `[a-zA-Z0-9][a-zA-Z0-9._-]*` pattern (flag injection prevention).

---

# Codex Tools (`cx`)

## codex

Single entry point for all Codex execution. Use the required `op` discriminator.

### Input Envelope

| Parameter | Type | Required | Description |
|---|---|---|---|
| `op` | string | Yes | One of: `exec`, `list`, `fork`, `abort` |

---

### op: exec

Create a new Codex session when `session` is omitted (calls `executeOneShot()`) or resume an existing session when `session` is present (calls `executeResume()`).

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | No | Session identifier (name or thread ID). Omit to start a new session. |
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
  "session": "codex-session-uuid",
  "session_name": "my-review",
  "model": "gpt-5.3-codex",
  "duration_ms": 4100,
  "errors": [],
  "warnings": []
}
```

If no session ID is returned, registration is skipped with a `notice` field. `errors`/`warnings`/`exit_code` are conditionally included.

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

### Lookup Logic (resume path)

1. `SessionManager.get(session)` - search by name first
2. If name doesn't match, search by `codexThreadId`
3. If not in registry, return error (`Session not found`). All sessions must be created via `codex({ op: "exec", ... })`.

On success, the `lastUsedAt` timestamp is automatically updated.

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
      "session": "uuid-1",
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
| `session` | string | Yes | Source session identifier (must exist in Coral registry) |
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
  "session": "new-session-uuid",
  "forked_from": "original-session-uuid",
  "session_name": "forked-review",
  "model": "gpt-5.3-codex",
  "duration_ms": 3500
}
```

`errors`/`warnings`/`exit_code` conditionally included. If `name` is not specified, the session exists only in Codex and is not registered in the Coral registry.

---

### op: abort

Abort an active execution.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Session identifier |

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

- `{ action: 'speak' }` - you won, deliver your speech
- `{ action: 'listen'; speaker; content }` - another agent won (includes epoch summaries with `speaker: null`)
- `{ action: 'session_ended'; reason; content }` - discussion is over

`speak` records speech and returns the updated status/step on success.

---

## discuss_lead (moderator tool)

Moderator-only MCP tool for control and lifecycle:

| Operation | Input |
|---|---|
| `_1_seed` | `controversy_axes`, `n`, optional `seed`, optional `demographics` (see [Persona Seeding Algorithm](#persona-seeding-algorithm-_1_seed)) |
| `_2_create` | `topic`, `agents` |
| `_3_step` | `session`, `timeout_seconds` (1-120), optional `force_stop` |
| `_4_transcript` | `session`, `mode`, optional `last_n` |
| `_5_epoch` | `session`, `summary` |
| `_6_state` | `session` |
| `_7_end` | `session`, optional `synthesis`, optional `force`, optional `reason` |

`_3_step` is a mode-specific blocking call:

- **setup**: moves setup → bidding under lock; returns `{ status: 'setup', phase: 'not_ready' }` if participants not yet registered.
- **bidding**: waits for all bids (blocking via `waitForCondition(allBidsIn)`), then resolves winner under lock. Returns one of:
  - `{ status: 'bidding', phase: 'bidding', pending_bidders, hold_count }` - still collecting bids
  - `{ status: 'bidding', phase: 'resolved', winner }` - winner selected
  - `{ status: 'bidding', phase: 'epoch_transition', epoch }` - auto-transitioned to new epoch
  - `{ status: 'bidding', phase: 'ended', reason }` - discussion ended (`all_below_threshold`, `max_epochs_reached`, `all_blocked`, `no_participants`)
  - `{ status: 'bidding', phase: 'expelled', agents, hint }` - agents expelled for timeout
- **speaking**: waits for speech delivery (blocking via `waitForCondition(speechDelivered)`). Returns one of:
  - `{ status: 'speaking', phase: 'speech_done', speaker, content }` - speech delivered
  - `{ status: 'speaking', phase: 'speech_pending', elapsed }` - still waiting
  - `{ status: 'speaking', phase: 'speech_timeout', speaker }` - speaker timed out
  - `{ status: 'ended', phase: 'ended', reason }` - session ended during wait

`_7_end` finalizes sessions. On already-ended sessions, it records a synthesis if provided and no-ops otherwise.

---

## Persona Seeding Algorithm (`_1_seed`)

`_1_seed` generates maximally diverse persona position assignments using **k-DPP (Determinantal Point Process)** sampling, then optional demographics-based origin assignment. Reference: Kulesza & Taskar (2012), "Determinantal Point Processes for Machine Learning".

### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `controversy_axes` | array | Yes | 1–10 axes, each with 1–10 unique positions. Axis names must be unique. |
| `n` | integer | Yes | Number of persona assignments to generate (1–8) |
| `seed` | integer \| null | No | RNG seed for reproducibility. `null` = random seed. |
| `demographics.origin_weights` | object | No | Finite positive origin weights, keyed by origin label (e.g., country code, institution type) |
| `demographics.outlier_ratio` | number | No | Fraction of outliers from low-weight pool (`0` to `0.5`, default `0.2`). |

### Pipeline

1. **Pool generation**: Cartesian product of all axis positions. Each element is a position tuple (one position per axis). Pool size = product of all axis sizes.

2. **Validation & subsampling**:
   - Estimated pool size > 100,000 → error `pool_too_large` (guard against materializing huge products)
   - `pool_size > 256` → **auto-subsample**: shuffle pool with seeded RNG, take first 256 items. Result includes `subsampled: true` and `original_pool_size`.
   - `pool_size = 1` and `n > 1` → error `pool_degenerate` (hint: all axes have single position)

3. **RNG**: mulberry32 PRNG seeded with the provided or auto-generated seed. Deterministic — same seed always produces the same assignments.

4. **Selection** (uniqueCount = min(n, pool_size)):
   - `uniqueCount = 0` → empty
   - `uniqueCount = 1` → uniform random pick
   - `uniqueCount = pool_size` → take all (no sampling needed)
   - Otherwise → **k-DPP sampling**:
     - **σ** = √(axes_count / 2) — Gaussian RBF bandwidth
     - **Kernel**: L[i][j] = exp(-hamming(i,j)² / 2σ²) — similarity matrix over pool
     - **Eigendecompose**: Jacobi rotation on the symmetric kernel
     - **Phase A**: ESP (elementary symmetric polynomial) backward sampling selects k eigenvectors
     - **Phase B**: Sequential item sampling from selected eigenvector subspace with Gram-Schmidt orthogonalization

5. **Reuse** (when `n > pool_size`): Extra slots assigned by largest Hamming distance from the selected set, cycling through ranked reuse order. Each reused assignment carries `shared_position_with: <source_slot_index>`.

6. **Tone assignment**: 2×2×2 = 8 combinations of `{formality, evidence, pace}` shuffled via seeded RNG and assigned cyclically:
  - `formality`: `formal` | `conversational`
  - `evidence`: `data-driven` | `narrative`
  - `pace`: `concise` | `detailed`

7. **Demographics layer** (optional, second RNG stage): When `demographics` is provided, assigns `suggested_origin` and `is_outlier` per slot using weighted pools split by `outlier_ratio` (default `0.2`, clamped to `0–0.5`).

### Output

```json
{
  "ok": true,
  "value": {
    "seed_used": 3141592653,
    "sigma_used": 1.0,
    "pool_size": 256,
    "subsampled": true,
    "original_pool_size": 3125,
    "assignments": [
      {
        "positions": { "stance": "pro", "priority": "cost" },
        "tone": { "formality": "formal", "evidence": "data-driven", "pace": "concise" },
        "suggested_origin": "DE",
        "is_outlier": false,
        "persona_seed": 1827364590
      },
      {
        "positions": { "stance": "con", "priority": "quality" },
        "tone": { "formality": "conversational", "evidence": "narrative", "pace": "detailed" },
        "suggested_origin": "US",
        "is_outlier": true,
        "persona_seed": 3049182736,
        "shared_position_with": 0
      }
    ]
  }
}
```

### Error Responses

| Error | Condition | Recovery |
|---|---|---|
| `pool_too_large` | Estimated pool > 100,000 (OOM guard, not materialized) | Reduce positions on largest axis or merge axes, retry |
| `pool_degenerate` | Pool = 1, n > 1 | Add a second position to at least one axis, retry |

### Moderator Setup Workflow

The moderator (`discuss-lead`) uses `_1_seed` within a 3-phase setup:

**Phase 1 — Controversy Analysis** (LLM inline, before `_1_seed` call):
- Extract 3–4 controversy axes from the topic, each with 2–3 positions
- **Pool budget**: keep product of all axis sizes ≤ 81 (e.g., 3×3×3×3 = 81). If product exceeds 81, trim the largest axis to 2 positions or merge axes. This is a recommended guideline — the hard limit is 256.
- Assign agent names with `dc-` prefix (e.g., `dc-architect`)
- Assign distinct `name_culture` per agent (e.g., Korean, Nigerian, Brazilian)
- If debate topic: prepend `{ axis: "stance", positions: ["pro", "con"] }` as the first axis
- Generate `n` persona briefs: 1–2 sentence background differentiation per slot

**Phase 2 — DPP Seeding** (`_1_seed` MCP call):
- Call `_1_seed({ controversy_axes, n, demographics, seed: null })`
- Result: `assignments[i].positions` (axis → position map), `assignments[i].tone` ({ formality, evidence, pace }), `assignments[i].persona_seed` (uint32), `assignments[i].suggested_origin`, `assignments[i].is_outlier` (if demographics provided)
- Pool > 256 is auto-subsampled (no action needed). Response includes `subsampled: true`, `original_pool_size`.
- On `pool_too_large` (> 100,000): reduce positions on largest axis, retry
- On `pool_degenerate`: add a second position to at least one axis, retry

**Phase 3 — Merge & Spawn** (parallel persona generation):
- For each slot, spawn `persona-generator` with: `role`, `topic`, `team_roles`, `name_culture`, `positions` (from assignments), `tone` (from assignments), `brief` (from Phase 1), `devil_advocate` (if stance imbalance), `shared_position_with` (if reused slot)
- **Stance imbalance check**: if stance axis exists, count pro vs con. If imbalanced, set `devil_advocate: true` for one agent on overrepresented side.

---

# cx ↔ dc Integration

The `cx` (Codex) and `dc` (Discuss) MCP servers do **not** communicate directly at runtime. They are independent processes with no shared state or IPC.

## Coupling Points

The coupling is through the **agent protocol layer**, not the MCP servers themselves:

| Component | Role |
|-----------|------|
| `discuss-lead.md` | Spawns `persona-generator` agents (via Task tool) and `discussant` teammates for discussions |
| `agents/codex-*.md` | Codex-delegated agents that can be spawned independently or within discuss workflows |
| `hooks/detect-codex-agent.mjs` | SubagentStart hook detects `codex-` prefix in agent names, injects delegation instructions to call `codex({ op: "exec", ... })` |

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
3. **Hook is the sole bridge** - `detect-codex-agent.mjs` is the single point where a codex-delegated workflow and the Codex CLI connect
4. **Modifying either server independently is safe** - as long as the hook contract (agent name prefix matching) is preserved
