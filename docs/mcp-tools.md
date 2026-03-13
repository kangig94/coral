# MCP Tools

Coral exposes one MCP server plus a backend HTTP server:

- **`ax` (Agent Execution)**: tools (`codex`, `claude`, `wait`, `abort`, `workflow`, `backend`, plus discuss tools) for Codex/Claude CLI session management, backend control, pipeline orchestration, and discuss session control. Prefix: `mcp__plugin_coral_ax__`

> **Note**: The `dc` MCP server and Agent Teams-based discuss tools (`discuss`, `discuss_lead`) have been removed. Discuss sessions are now controlled via backend tools (`discuss_seed`, `discuss_start`, `discuss_watch`, `discuss_participate`, `discuss_abort`) exposed through the `ax` bridge. The doc sections below on `discuss_lead` ops describe the legacy architecture.

All tool inputs are validated at runtime with Zod schemas (`src/providers/codex/schemas.ts`, `src/providers/claude/schemas.ts`, `src/discuss/schemas.ts`). Model names only allow the `[a-zA-Z0-9][a-zA-Z0-9._-]*` pattern (flag injection prevention).

---

# Codex Tools (`ax`)

## codex

Single entry point for all Codex execution. Use the required `op` discriminator.

### Input Envelope

| Parameter | Type | Required | Description |
|---|---|---|---|
| `op` | string | Yes | `exec`, `list`, `fork`, or `coral:<agent-name>` |

---

### op: coral:*

Delegate a Codex call through an agent file in `agents/`. The server reads
`agents/<agent-name>.md`, prepends it to the prompt as plain text, then dispatches through
the same background session pipeline as `op: exec`.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `op` | string | Yes | Must match `coral:[a-z0-9][a-z0-9-]*` |
| `prompt` | string | Yes | User prompt appended after agent content |
| `session` | string | No | Existing coral session UUID to resume |
| `work_dir` | string | No | Working directory |

### Behavior Notes

- Unknown agent files return an MCP error: `Agent file not found: agents/<agent>.md`
- Agent YAML frontmatter is parsed for metadata (`model`, `methods`, `deep`) then stripped before injection
- `model` from frontmatter is used as the default model for the agent
- Path traversal is blocked by op validation before filesystem reads

---

### op: exec

Start a new Codex session (omit `session`) or resume an existing one (pass `session`). Returns immediately — execution runs in background.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | Yes | Prompt to send to Codex (min 1 char) |
| `session` | string | No | Coral session UUID from a prior `exec`/`fork` response. Omit to start a new session. |
| `work_dir` | string | No | Working directory |

### Output

Returns immediately. Codex runs in background. Accepted launches return one of:

```json
{
  "status": "running",
  "job": "job-uuid",
  "session": "session-uuid"
}
```

```json
{
  "status": "queued",
  "job": "job-uuid",
  "session": "session-uuid"
}
```

`status: "queued"` is a normal accepted launch outcome, not an error. The job will auto-execute when a launch slot frees up.

`job` is the job ID used with `wait` and `abort`. `session` is the session ID for resume/fork continuity. Use the `wait` tool to stream progress, then `Read` the result from `/tmp/coral-jobs/<job>/result.md`.

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
      "model": "gpt-5.4",
      "created_at": "2026-02-18T08:30:00.000Z",
      "last_used_at": "2026-02-18T09:15:00.000Z",
      "work_dir": "/home/user/project",
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
| `prompt` | string | No | Additional prompt for the forked session |
| `work_dir` | string | No | Working directory |

### Output

Returns immediately. Same accepted format as `exec` (`status: "running"` or `status: "queued"`):

```json
{
  "status": "running",
  "job": "job-uuid",
  "session": "session-uuid"
}
```

`status: "queued"` means the fork request was accepted and will auto-execute when capacity is available.

Use `wait({ jobs: [job] })` to get the fork response. Completed waits always include `result.path` and may also include `result.content` when the serialized response fits the inline budget.

---

## Usage Pattern

```
exec → { status: "running" | "queued", job, session }
wait({ jobs: [job] }) → { state, result.path, result.content?, ... }
if state == "ended" and result.content:
  use result.content
if state == "ended" and !result.content:
  Read(result.path) → response text (workflow-safe fallback; provider path is best-effort)
if state == "running":
  wait again with cursor, or abort({ jobs: [job] })
```

## Session Continuity

`job` (from exec/fork response) is the job ID for `wait`/`abort` and result file access. `session` (from exec/fork response) is the session ID for resume/fork continuity.

| Field | Source | Purpose |
|-------|--------|---------|
| `job` | exec/fork response | Pass to `wait`/`abort`; completed waits return `result.path` for artifact access |
| `session` | exec/fork response | Pass to next `exec`/`fork` for session continuity |

Do NOT pass `job` as the `session` parameter on subsequent exec calls.

---

# Claude Tools (`ax`)

## claude

Single entry point for Claude CLI execution. Use the required `op` discriminator.

### Input Envelope

| Parameter | Type | Required | Description |
|---|---|---|---|
| `op` | string | Yes | `exec`, `list`, `fork`, or `coral:<agent-name>` |

### Official Input Schema

```json
{
  "name": "claude",
  "description": "Execute a prompt with Claude CLI. Use op field to select exec/list/fork. For agent delegation, use op: \"coral:<agent-name>\" (e.g., coral:architect, coral:critic).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "op": { "type": "string", "description": "Operation: exec/list/fork, or coral:<agent-name> for agent delegation" },
      "prompt": { "type": "string", "description": "Prompt to send (exec required)" },
      "session": { "type": "string", "description": "Session ID for resume (exec with existing session)" },
      "work_dir": { "type": "string", "description": "Working directory for execution" }
    },
    "required": ["op"]
  }
}
```

### op: exec

Starts a new Claude CLI run (or resumes when `session` is provided). Accepted launches return either:

```json
{
  "status": "running",
  "job": "job-uuid",
  "session": "session-uuid"
}
```

```json
{
  "status": "queued",
  "job": "job-uuid",
  "session": "session-uuid"
}
```

`status: "queued"` is a normal accepted launch outcome. Claude will auto-dispatch when capacity is available.

Execution details:
- Uses `claude -p --output-format json`
- Prompt is sent via stdin (not argv)
- System prompt is injected internally for `coral:*` ops via `--append-system-prompt`
- Resume mode uses `--resume <session-id>`
- `--no-session-persistence` is not used

### op: coral:*

Delegate a Claude CLI call through an agent file. Same schema as the Codex `coral:*` op:

| Parameter | Type | Required | Description |
|---|---|---|---|
| `op` | string | Yes | Must match `coral:[a-z0-9][a-z0-9-]*` |
| `prompt` | string | Yes | User prompt appended after agent content |
| `session` | string | No | Existing coral session UUID to resume |
| `work_dir` | string | No | Working directory |

- `coral:<agent>`: loads `agents/<agent>.md`, parses frontmatter metadata, strips it, and injects into `--append-system-prompt`
- `coral:<skill>`: returns `isError` (skills require Claude Code tool environment and are only supported through the `codex` tool)

### op: list

Returns registered Claude sessions in the same session-list format as Codex.

### op: fork

Fork an existing Claude session into a new branch. Uses `claude -p --resume <thread-id> --fork-session --output-format stream-json`.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Source session identifier (must exist in Coral registry) |
| `prompt` | string | No | Additional prompt for the forked session |
| `work_dir` | string | No | Working directory |

### Output

Accepted launches use the same response format as `exec`: `status: "running"` or `status: "queued"`, plus `job` and `session`. `status: "queued"` means the fork was accepted and will auto-execute when a slot frees up.

### Missing `session_id` Behavior

If CLI JSON output does not include `session_id`, the run is marked non-resumable:
- response still returns normally
- metadata includes `non_resumable: true`
- no persisted provider session mapping is created

---

# Wait Tool (`ax`)

## wait

Provider-agnostic wait for background jobs from any AX adapter. Wait returns when the first requested job completes, errors, or timeout elapses.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `jobs` | string[] | Yes | Job IDs to monitor (min 1, from exec/fork response). |
| `timeout_seconds` | number | No | Max wait time in seconds (1-1200, default 600). |
| `cursor` | string | No | Opaque stream cursor returned by the previous wait call (for incremental streaming). |

### Output — Ended

`state: "ended"` means the waited job terminated — this includes normal completion, errors, and aborts. Inspect `result` fields (`notice`, `failed`, `aborted`, `exitCode`) to distinguish outcomes.

```json
{
  "state": "ended",
  "completedJobId": "job-uuid",
  "sessionId": "session-uuid",
  "remainingJobIds": [],
  "result": { "durationMs": 1234, "path": "/tmp/coral-jobs/job-uuid/result.md", "content": "..." }
}
```

`result.content` is omitted when the serialized response exceeds the inline budget; use `Read(result.path)` as fallback.

Workflow jobs follow the same contract — `result.path` is always present and `result.content` is optional:
```json
{
  "state": "ended",
  "completedJobId": "workflow-job",
  "sessionId": "workflow-session",
  "remainingJobIds": [],
  "result": {
    "notice": "Step 2, atom 'resolver' failed: primary failure",
    "workflow": {
      "steps": [
        {
          "agent": "architect",
          "step": 1,
          "atom": 1,
          "provider": "codex",
          "start": 3,
          "end": 3
        }
      ]
    },
    "path": "/tmp/coral-jobs/workflow-job/result.md",
    "content": "..."
  }
}
```

### Queued Launches

When all launch slots are busy, `exec`, `resume`, or `fork` may return:

```json
{
  "status": "queued",
  "job": "job-uuid",
  "session": "session-uuid"
}
```

This is a normal accepted launch outcome, not an error. The job auto-dispatches when capacity becomes available. While it waits, `wait()` emits `queued (position N)` progress notifications. If nothing completes before `timeout_seconds`, the `wait` tool still returns the normal timeout payload below.

### Output — Running

```json
{
  "state": "running",
  "runningJobIds": ["job-uuid"]
}
```

### Wait Semantics

- **Any-semantics**: returns on the first completion in `jobs`.
- **Cross-provider**: accepts mixed Codex/Claude job IDs in one call.
- **Progress notifications**: incremental updates are emitted through `notifications/progress`.
- **Incremental streaming**: pass `cursor` from a previous wait response to resume from where the last call left off.
- **Content field**: `result.path` is always present. `result.content` is optional enrichment — present when the serialized response fits within the inline budget.
- **Selective read**: `Read(result.path)` loads the full artifact. Use `result.workflow.steps[N].start` and `end` to read only the step you need with `Read(result.path, start, limit)`.
- **Workflow fallback**: use `result.content ?? Read(result.path)`, then use `result.workflow.steps[N].start` and `end` to read only the step you need.
- **Workflow line semantics**: `start` and `end` bound the content block for each step (line numbers in the artifact file).

---

# Abort Tool (`ax`)

## abort

Provider-agnostic abort for active jobs. Works for codex, claude, and workflow jobs.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `jobs` | string[] | Yes | Job IDs to abort (min 1). |

### Output (JSON)

```json
{
  "aborted": ["job-uuid-1"],
  "notFound": ["job-uuid-2"]
}
```

`notFound` lists jobs that already finished or were never active — not an error condition.

---

# Workflow Tool (`ax`)

## workflow

Deterministic multi-agent pipeline executor. Chains coral agents via a DSL expression without LLM mediation between steps. Each step's output becomes the next step's prompt.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `expression` | string | Yes | Pipeline DSL expression (min 1 char). See grammar below. |
| `init_prompt` | string | Yes | Initial prompt fed to the first step (min 1 char). |
| `context` | string | No | Shared context prepended to every atom's prompt in every step. |
| `provider` | string | No | Default provider for atoms without `@provider` suffix. `claude` (default) or `codex`. |
| `work_dir` | string | No | Working directory for spawned atoms. Overrides the caller's project root. |
| `atoms` | object | No | Per-atom config: `{ atomName: { effort?, instruction? } }`. See Atoms below. |

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

### Atoms

`atoms` keys must match atom names in the expression. Each atom config accepts:
- `effort` (string) — `low`, `medium`, `high`, `xhigh`
- `instruction` (string) — appended to the atom's prompt after pipeline data

Unknown keys are rejected.
Atoms config applies to ALL occurrences of that atom name across steps (global matching).
Per-occurrence atom overrides are intentionally out of scope in v1; use distinct atom names when different per-step config is required.

### Output

Returns immediately (same as `codex`/`claude` exec). Pipeline runs in background.

```json
{
  "status": "running",
  "job": "job-uuid",
  "session": "session-uuid"
}
```

Use `wait({ jobs: [job] })` then `result.content ?? Read(result.path)` for the pipeline result. Successful, failed, and aborted workflow waits include `result.workflow.steps` so callers can read only the relevant section without loading the full artifact.

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
workflow({ expression: "architect -> resolver", init_prompt: "Review auth.ts" })

# Parallel review with synthesis
workflow({
  expression: "(architect, critic) -> resolver",
  init_prompt: "Analyze the login flow",
  provider: "codex",
  atoms: { architect: { effort: "high" }, critic: { instruction: "Focus on edge cases." } }
})

# Mixed providers: codex for analysis, claude for writing
workflow({
  expression: "scanner@codex -> architect@claude",
  init_prompt: "Map and review the API layer"
})
```

---

# Backend Tool (`ax`)

## backend

Bridge-local backend control tool. It is intercepted in the AX bridge and is never proxied through the backend `/tool` route.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `op` | string | Yes | `status` or `shutdown`. |

### op: status

Returns the current backend health payload when the daemon is running:

```json
{
  "status": "ok",
  "version": "0.4.3",
  "instanceId": "backend-instance",
  "uptime": 12345,
  "activeChildren": 0,
  "activeJobs": 0,
  "inflightRequests": 1
}
```

If the bridge cannot confirm a live backend process, the tool returns an MCP error: `Backend is not running`.

If the backend is already draining and still answers `/health`, the tool returns:

```json
{
  "status": "shutting_down"
}
```

### op: shutdown

Requests graceful backend shutdown through `POST /admin/shutdown`.

Successful shutdown requests return:

```json
{
  "status": "shutting_down"
}
```

Behavior notes:

- Returns the same success payload when the backend is already draining.
- Returns MCP error `not_running` when no live backend can be reached.
- Returns MCP error `unauthorized` when `backend.json` contains a stale token.
- Never auto-starts the backend for `status` or `shutdown`.

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
