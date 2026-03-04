# MCP Tools

Coral exposes two MCP servers, each with its own tool set:

- **`ax` (Agent Execution)**: 4 tools (`codex`, `claude`, `wait`, `workflow`) for Codex/Claude CLI session management and pipeline orchestration. Prefix: `mcp__plugin_coral_ax__`
- **`dc` (Discuss)**: 2 tools for moderated multi-agent discussions. Prefix: `mcp__plugin_coral_dc__`

All tool inputs are validated at runtime with Zod schemas (`src/codex/schemas.ts`, `src/claude/schemas.ts`, `src/discuss/schemas.ts`). Model names only allow the `[a-zA-Z0-9][a-zA-Z0-9._-]*` pattern (flag injection prevention).

---

# Codex Tools (`ax`)

## codex

Single entry point for all Codex execution. Use the required `op` discriminator.

### Input Envelope

| Parameter | Type | Required | Description |
|---|---|---|---|
| `op` | string | Yes | `exec`, `list`, `fork`, `abort`, or `coral:<agent-name>` |

---

### op: coral:*

Delegate a Codex call through an agent file in `agents/`. The server reads
`agents/<agent-name>.md`, prepends it to the prompt as plain text, then dispatches through
the same background session pipeline as `op: exec`.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `op` | string | Yes | Must match `coral:[a-z0-9][a-z0-9-]*` |
| `session` | string | No | Existing coral session UUID to resume |
| `name` | string | No | New session display name (when starting fresh) |
| `prompt` | string | Yes | User prompt appended after agent content |
| `model` | string | No | Model to use |
| `working_directory` | string | No | Working directory |
| `reasoning_effort` | string | No | `low`, `medium`, `high`, `xhigh` |
| `bypass` | boolean | No | Bypass sandbox/approvals only on explicit user request |

### Behavior Notes

- Unknown agent files return an MCP error: `Agent file not found: agents/<agent>.md`
- Agent content is prepended as-is (no frontmatter parsing/stripping)
- Path traversal is blocked by op validation before filesystem reads

---

### op: exec

Start a new Codex session (omit `session`) or resume an existing one (pass `session`). Returns immediately — execution runs in background.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | No | Coral session UUID from a prior `exec`/`fork` response. Omit to start a new session. |
| `name` | string | No | Session display name (auto-generated as `session-{timestamp}` if omitted) |
| `prompt` | string | Yes | Prompt to send to Codex (min 1 char) |
| `model` | string | No | Model to use (default: `gpt-5.3-codex`, configurable via `CORAL_CODEX_MODEL`) |
| `working_directory` | string | No | Working directory |
| `reasoning_effort` | string | No | Model reasoning effort: `low`, `medium`, `high`, `xhigh` |
| `bypass` | boolean | No | Bypass Codex sandbox and approval checks (default: `false`). Only set to `true` when the user explicitly requests bypass mode. |

### Output

Returns immediately. Codex runs in background.

```json
{
  "session": "uuid",
  "session_dir": "/tmp/coral-sessions/uuid",
  "session_name": "my-review",
  "status": "running"
}
```

`session_dir` is the filesystem path to the session run directory. Use the top-level AX `wait` tool to poll for completion, then `Read` files from `session_dir`.

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

`status` is `"running"` for sessions currently in the active session map, `"completed"` otherwise.

Only shows sessions registered in the Coral registry.

---

### op: fork

Fork an existing session to continue the conversation in a new branch. Returns immediately like `exec`.

> **Note**: `codex fork` is a TUI-only command and cannot run headlessly. Internally uses `codex exec resume` for resume-based forking.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Source session identifier (must exist in Coral registry) |
| `name` | string | No | New session display name |
| `prompt` | string | No | Additional prompt for the forked session |
| `model` | string | No | Model to use |
| `working_directory` | string | No | Working directory |
| `reasoning_effort` | string | No | Model reasoning effort: `low`, `medium`, `high`, `xhigh` |
| `bypass` | boolean | No | Bypass Codex sandbox and approval checks (default: `false`). Only set to `true` when the user explicitly requests bypass mode. |

### Output

Returns immediately. Same format as `exec`:

```json
{
  "session": "uuid",
  "session_dir": "/tmp/coral-sessions/uuid",
  "session_name": "forked-review",
  "status": "running"
}
```

Use `wait({ sessions: [session] })` then `Read(session_dir + "/result.md")` to get the fork response.

---

### op: abort

Abort an active execution by session UUID.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string (UUID) | Yes | Session UUID from a previous `exec`/`fork` response. Direct lookup in `activeJobs`. |

### Output (JSON)

```json
{
  "session": "uuid",
  "session_name": "my-review",
  "status": "abort_requested"
}
```

Abort is best-effort: if the session already finished or does not exist in this process, abort returns an error.

---

## Usage Pattern

```
exec → { session, session_dir }
wait({ sessions: [session] }) → { status, ... }
if status == "completed":
  Read(session_dir + "/result.md") → response text
if status == "error":
  Read(session_dir + "/status.json") → { error } for diagnostics
if status == "timeout":
  re-wait, or abort(session)
```

## Session Continuity

`session_name` (from exec response) is the human-readable display label. `session` (from exec/fork response) is the UUID needed for continuity.

| Field | Source | Purpose |
|-------|--------|---------|
| `session_name` | exec/fork response | Display label shown to user |
| `session` | exec/fork response | Pass to next `exec` for continuity |

Do NOT pass `session_name` as the `session` parameter on subsequent exec calls.

---

# Claude Tools (`ax`)

## claude

Single entry point for Claude CLI execution. Use the required `op` discriminator.

### Input Envelope

| Parameter | Type | Required | Description |
|---|---|---|---|
| `op` | string | Yes | `exec`, `list`, `abort`, or `coral:<agent-name>` |

### Official Input Schema

```json
{
  "name": "claude",
  "description": "Execute a prompt with Claude CLI. Use op field to select exec/list/abort. For agent delegation, use op: \"coral:<agent-name>\" (e.g., coral:architect, coral:critic). Skills (coral:<skill>) are not supported — use the codex tool for skill delegation.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "op": { "type": "string", "description": "Operation: exec/list/abort, or coral:<agent-name> for agent delegation (skills not supported)" },
      "prompt": { "type": "string", "description": "Prompt to send (exec required)" },
      "session": { "type": "string", "description": "Session ID for resume (exec with existing session)" },
      "name": { "type": "string", "description": "Session name (exec optional)" },
      "model": { "type": "string", "description": "Claude model to use (e.g., sonnet, opus, haiku)" },
      "working_directory": { "type": "string", "description": "Working directory for execution" },
      "system_prompt": { "type": "string", "description": "Custom system prompt (replaces default)" }
    },
    "required": ["op"]
  }
}
```

### op: exec

Starts a new Claude CLI run (or resumes when `session` is provided). Returns immediately with a Coral session UUID:

```json
{
  "session": "uuid",
  "session_dir": "/tmp/coral-sessions/uuid",
  "session_name": "my-session",
  "status": "running"
}
```

Execution details:
- Uses `claude -p --output-format json`
- Prompt is sent via stdin (not argv)
- Optional flags: `--model`, `--system-prompt`
- Resume mode uses `--resume <session-id>`
- `--no-session-persistence` is not used

### op: coral:*

- `coral:<agent>`: loads `agents/<agent>.md`, strips YAML frontmatter + `> **CORAL_...` directive lines, and injects into `--system-prompt`
- `coral:<skill>`: returns `isError` (skills require Claude Code tool environment and are only supported through the `codex` tool)

### op: list / abort

Same lifecycle contract as Codex for provider-local operations: `list` returns registered Claude sessions, and `abort` targets active Claude sessions.

### Missing `session_id` Behavior

If CLI JSON output does not include `session_id`, the run is marked non-resumable:
- response still returns normally
- metadata includes `non_resumable: true`
- no persisted provider session mapping is created

---

# Wait Tool (`ax`)

## wait

Provider-agnostic wait for background sessions from any AX adapter. Wait returns when the first requested session completes, errors, or timeout elapses.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessions` | string[] (UUID) | Yes | Session UUIDs to monitor (min 1). |
| `timeout_seconds` | integer | No | Max wait time in seconds (1-1200, default 600). |

### Output — Completed or Error

```json
{
  "status": "completed",
  "completed_session": "uuid",
  "session_dir": "/tmp/coral-sessions/uuid",
  "session_name": "my-review"
}
```

### Output — Timeout

```json
{
  "status": "timeout",
  "running_sessions": ["uuid1"]
}
```

### Wait Semantics

- **Any-semantics**: returns on the first completion in `sessions`.
- **Cross-provider**: accepts mixed Codex/Claude session UUIDs in one call.
- **Progress notifications**: incremental updates are emitted through `notifications/progress`.

---

# Workflow Tool (`ax`)

## workflow

Deterministic multi-agent pipeline executor. Chains coral agents via a DSL expression without LLM mediation between steps. Each step's output becomes the next step's prompt.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `expression` | string | Yes | Pipeline DSL expression (min 1 char). See grammar below. |
| `prompt` | string | Yes | Initial prompt fed to the first step (min 1 char). |
| `provider` | string | No | Default provider for atoms without `@provider` suffix. `codex` (default) or `claude`. |
| `args` | object | No | Per-atom argument overrides, keyed by atom name. See args routing below. |

### DSL Grammar

```
expression = step ( "->" step )*
step       = atom | "(" atom ( "," atom )* ")"
atom       = agent_ref | prompt_literal
agent_ref  = ( namespace ":" )? agent ( "@" provider )?
prompt_lit = ( "'" text "'" | '"' text '"' ) ( "@" provider )?
```

- **Bare name**: `architect` → defaults to `coral` namespace
- **Explicit namespace**: `coral:architect` → same as bare, but explicit
- **Provider override**: `architect@claude` → runs on Claude instead of default
- **Prompt literal**: `'What is 2+2?'@codex` → runs the quoted text directly on the specified provider, bypassing agent resolution
- **Parallel step**: `(architect, critic)` → launches concurrently, output XML-wrapped
- **Sequential chain**: `architect -> resolver` → step 1 output becomes step 2 prompt
- **Mixed parallel**: `(architect@claude, 'analyze this'@codex)` → agent refs and prompt literals can be mixed in a parallel step

Agent names: `[a-z][a-z0-9-]*`. Provider: `codex` or `claude`. Namespace: `[a-z][a-z0-9-]*` (v1 only allows `coral`). Prompt literals use single or double quotes; the `@provider` suffix is optional (defaults to the `provider` parameter).

### Args Routing

`args` keys must match atom names in the expression. Each atom's args object is split into:

**Execution params** (forwarded to dispatch payload):
- `model` (string) — model override
- `working_directory` (string) — working directory
- `reasoning_effort` (string) — `low`, `medium`, `high`, `xhigh`

**Prompt context** (serialized into the atom's prompt):
- `files` (string[]) — file paths read and injected as `<file path="...">content</file>`
- `flags` (string[]) — injected as `Flags: --a --b` text
- Any other key — injected as `Context:\n{JSON}` block

`bypass` is rejected in v1 (coral agent handlers force bypass internally).

Args keys apply to ALL occurrences of that atom name across steps (global matching).

### Output

Returns immediately (same as `codex`/`claude` exec). Pipeline runs in background.

```json
{
  "session": "uuid",
  "session_dir": "/tmp/coral-sessions/uuid",
  "session_name": "workflow-1709500000000",
  "status": "running"
}
```

Use `wait({ sessions: [session] })` then `Read(session_dir + "/result.md")` for the pipeline result.

### Step Output Format

- **Single atom**: raw output pass-through
- **Parallel step** (2+ atoms): XML-wrapped per atom:
  ```
  <architect>
  architect output
  </architect>

  <critic>
  critic output
  </critic>
  ```

### Orchestration Behavior

- **Concurrent launch**: parallel step atoms launch via `Promise.all`
- **Busy retry**: up to 3 attempts with exponential backoff (100ms, 200ms, 400ms). Detects busy from both immediate dispatch errors and async bootstrap failures.
- **Bootstrap polling**: 50ms intervals, 2s timeout — catches race window between `launchJob` return and CLI startup failure
- **Wait-for-all**: polls `readSessionStatus` directly (not the `wait` tool which has any-semantics)
- **Sibling abort on failure**: first failure triggers best-effort abort of siblings with 15s drain timeout

### v1 Limitations

- Non-coral namespaces rejected (`unsupported namespace` error)
- Raw-exec atoms (non-agent shell commands) not supported
- XML tag collision: agent output containing `</agent-name>` creates ambiguous XML (low probability)

### Examples

```
# Simple sequential: architect reviews, resolver synthesizes
workflow({ expression: "architect -> resolver", prompt: "Review auth.ts" })

# Parallel review with synthesis
workflow({
  expression: "(architect, critic) -> resolver",
  prompt: "Analyze the login flow",
  provider: "codex",
  args: { architect: { model: "o4-mini" }, critic: { flags: ["--deep"] } }
})

# Mixed providers: codex for analysis, claude for writing
workflow({
  expression: "scanner@codex -> architect@claude",
  prompt: "Map and review the API layer"
})
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
| `bid` | `session`, `agent_name`, `score` (0-100), `thought` (required) |
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
| `_7_end` | `session`, optional `force`, optional `reason` |
| `_8_synthesize` | `session`, `synthesis` |

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

`_7_end` finalizes sessions and is idempotent for already-ended sessions. `_8_synthesize` records synthesis text for ended sessions only (`not_ended` otherwise) and no-ops on duplicate synthesis writes.

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

# ax ↔ dc Integration

The `ax` (Codex) and `dc` (Discuss) MCP servers do **not** communicate directly at runtime. They are independent processes with no shared state or IPC.

## Coupling Points

The coupling is through the **agent protocol layer**, not the MCP servers themselves:

| Component | Role |
|-----------|------|
| `discuss-lead.md` | Spawns `persona-generator` agents (via Task tool) and `discussant` teammates for discussions |
| `codex({ op: "coral:<agent>" })` | Direct Codex agent delegation path that reads `agents/<agent>.md` and prepends it to prompts |

The discuss system itself does **not** call Codex tools unless a skill/workflow explicitly asks for it.

## Session Naming Convention

- Discuss session IDs: `yymmdd-HHmm-xxxx` (managed by dc)
- Discuss session dirs: `{session_id}-{topic_slug}` (managed by dc)
- Discuss teams: `coral-dc-{session_id}` (managed by Claude Code Agent Teams)
- Codex sessions: `session-{timestamp}` or user-provided name (managed by ax)

These namespaces do not overlap. Collision risk is between discuss sessions only (mitigated by 4-char random suffix per timestamp-minute).

## Contract

1. **dc never calls ax tools** - the discuss MCP server has no dependency on the codex MCP server
2. **ax never reads dc state** - Codex sessions have no awareness of discuss sessions
3. **Agent delegation is explicit** - Codex delegation uses `codex({ op: "coral:<agent>" })`; no hook bridge is involved
4. **Modifying either server independently is safe** - as long as tool input/output contracts are preserved
