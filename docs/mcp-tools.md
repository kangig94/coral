# MCP Tools

Coral exposes one MCP server (`ax`) backed by one local HTTP daemon. MCP clients still see a single tool catalog, but execution is now split between bridge-local handlers, dedicated backend routes, and the generic `/tool` proxy.

| Tool family | Advertised by | Execution path |
|---|---|---|
| Provider tools (`codex`, `claude`, future registered providers) | Backend `GET /tools` | Bridge/CLI -> `POST /provider/:name` |
| `workflow` | Backend `GET /tools` | Bridge/CLI -> `POST /workflow` |
| `abort` | Backend `GET /tools` | Bridge/CLI -> `POST /abort` |
| `discuss_*` and `kb_*` | Backend `GET /tools` | Bridge/CLI -> `POST /tool` -> `routeToolCall()` |
| `wait` | Bridge-local | Bridge -> `POST /wait/stream` |
| `backend` | Bridge-local | Handled in the bridge only |

`GET /tools` is the source of truth for every backend-routed descriptor: live provider descriptors plus discuss, KB, `workflow`, and `abort`. The bridge appends the bridge-local `wait` and `backend` descriptors before returning MCP `ListTools`.

Provider operations, workflow launches, and job aborts are no longer handled by the generic `/tool` route. `/tool` now exists only for `discuss_*` and `kb_*`.

All tool inputs are validated at runtime with Zod schemas (`src/providers/codex/schemas.ts`, `src/providers/claude/schemas.ts`, `src/discuss/schemas.ts`). Model names only allow the `[a-zA-Z0-9][a-zA-Z0-9._-]*` pattern (flag injection prevention).

---

# Codex Tools (`ax`)

## codex

Single entry point for all Codex execution. Use the required `op` discriminator.

Routing note: Codex is advertised by backend `GET /tools`, but execution goes through the dedicated `POST /provider/codex` endpoint, not `/tool`. Public discovery exposes the provider contract (`exec`, `list`, `fork`, and `coral:*`; resume is `exec` + `session`) and intentionally does not expose internal-only launch fields such as `bypass_exec`, `bypass_permissions`, or `system_prompt`.

### Input Envelope

| Parameter | Type | Required | Description |
|---|---|---|---|
| `op` | string | Yes | `exec`, `list`, `fork`, or `coral:<agent-name>` |
| `prompt` | string | No | Prompt for `exec` and `coral:*`; optional follow-up prompt for `fork`. |
| `session` | string | No | Resume target for `exec`, or source session for `fork`. |
| `work_dir` | string | No | Working directory override. |
| `model` | string | No | Optional model override. |
| `owner` | string | No | Owner identifier used by `coral:*` dispatch. |

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

`job` is the job ID used with `wait` and `abort`. `session` is the session ID for resume/fork continuity. Use the `wait` tool to stream progress, then `Read` the result from `<os-tmpdir>/coral-jobs/<job>/result.md`.

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

## CLI Examples

CLI provider commands use subcommands instead of the MCP `op` discriminator, but they hit the same `POST /provider/:name` endpoints.

```bash
# Launch a new Codex job and return the launch decision immediately
coral codex exec --prompt "Review auth.ts" -d

# Resume by reusing the same session ID (public MCP equivalent: op=exec + session)
coral codex exec --session <session-id> --prompt "Continue from the previous response" -d

# Fork an existing session on a provider that supports headless fork
coral claude fork --session <session-id> --prompt "Try an alternative approach" -d

# Dispatch through a Coral agent
coral codex coral architect --prompt "Review auth.ts" -d

# List sessions for any provider
coral codex list
coral claude list
```

---

# Claude Tools (`ax`)

## claude

Single entry point for Claude CLI execution. Use the required `op` discriminator.

Routing note: Claude is advertised by backend `GET /tools`, but execution goes through `POST /provider/claude`, not `/tool`. The public MCP descriptor matches Codex: `exec`, `list`, `fork`, and `coral:*`, with resume represented as `exec` plus `session`.

### Input Envelope

| Parameter | Type | Required | Description |
|---|---|---|---|
| `op` | string | Yes | `exec`, `list`, `fork`, or `coral:<agent-name>` |
| `prompt` | string | No | Prompt for `exec` and `coral:*`; optional follow-up prompt for `fork`. |
| `session` | string | No | Resume target for `exec`, or source session for `fork`. |
| `work_dir` | string | No | Working directory override. |
| `model` | string | No | Optional model override. |
| `owner` | string | No | Owner identifier used by `coral:*` dispatch. |

### Official Input Schema

```json
{
  "name": "claude",
  "description": "Execute a prompt with Claude CLI. Use op field to select exec/list/fork. For agent delegation, use op: \"coral:<agent-name>\" (e.g., coral:architect, coral:critic).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "op": { "type": "string", "description": "Operation: exec/list/fork, or coral:<agent-name> for agent delegation. Resume is exec plus session." },
      "prompt": { "type": "string", "description": "Prompt to send (exec required)" },
      "session": { "type": "string", "description": "Session ID for resume (exec with existing session)" },
      "work_dir": { "type": "string", "description": "Working directory for execution" },
      "model": { "type": "string", "description": "Optional model override" },
      "owner": { "type": "string", "description": "Owner identifier used by coral:* dispatch" }
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

Routing note: `wait` is bridge-local. The backend does not advertise it in `GET /tools`; the bridge appends the descriptor and proxies the call to `POST /wait/stream`.

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
  "result": { "durationMs": 1234, "path": "<os-tmpdir>/coral-jobs/job-uuid/result.md", "content": "..." }
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
    "path": "<os-tmpdir>/coral-jobs/workflow-job/result.md",
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
- **Content field**: `result.path` is always present. `result.content` is optional enrichment — present when the fully serialized `CallToolResult` body fits within `MAX_INLINE` (10K chars). Measured on `JSON.stringify(jsonResult(payload))` which includes pretty-print overhead and MCP envelope fields.

  Empirical distribution from 199 job results (non-empty only):

  | Size range | Regular | Workflow | Total |
  |------------|---------|----------|-------|
  | 1 ~ 1K | 9 | 2 | 11 |
  | 1K ~ 5K | 41 | 1 | 42 |
  | 5K ~ 10K | 33 | 0 | 33 |
  | 10K ~ 20K | 10 | 14 | 24 |
  | 20K ~ 30K | 6 | 8 | 14 |
  | 30K+ | 1 | 2 | 3 |

  Regular jobs under 10K: 97%. Workflow jobs over 10K: 59%. This makes 10K a natural boundary — regular results inline for zero-latency reads, workflow results return path references for selective step access.
- **Selective read**: `Read(result.path)` loads the full artifact. Use `result.workflow.steps[N].start` and `end` to read only the step you need with `Read(result.path, start, limit)`.
- **Workflow fallback**: use `result.content ?? Read(result.path)`, then use `result.workflow.steps[N].start` and `end` to read only the step you need.
- **Workflow line semantics**: `start` and `end` bound the content block for each step (line numbers in the artifact file).

---

# Abort Tool (`ax`)

## abort

Provider-agnostic abort for active jobs. Works for codex, claude, and workflow jobs.

Routing note: `abort` is advertised by backend `GET /tools`, but bridge and CLI callers send it to the dedicated `POST /abort` endpoint. It no longer executes through `/tool`.

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

### CLI Example

```bash
coral abort --jobs job-uuid-1,job-uuid-2
```

---

# Workflow Tool (`ax`)

## workflow

Deterministic multi-agent pipeline executor. Chains coral agents via a DSL expression without LLM mediation between steps. Each step's output becomes the next step's prompt.

Routing note: `workflow` is advertised by backend `GET /tools`, but bridge and CLI callers launch it through the dedicated `POST /workflow` endpoint. It no longer executes through `/tool`.

### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `expression` | string | Yes | Pipeline DSL expression (min 1 char). See grammar below. |
| `start_prompt` | string | Yes | Start prompt fed to the first step (min 1 char). |
| `context` | string | No | Shared context prepended to every atom's prompt in every step. |
| `provider` | string | No | Default provider for atoms without `@provider` suffix. `claude` (default) or `codex`. |
| `work_dir` | string | No | Working directory for spawned atoms. Overrides the caller's project root. |

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

```bash
# Simple sequential: architect reviews, resolver synthesizes
coral workflow "architect -> resolver" "Review auth.ts"

# Parallel review with synthesis
coral workflow "(architect, critic) -> resolver" "Analyze the login flow" -p codex

# Mixed providers: codex for analysis, claude for writing
coral workflow "scanner@codex -> architect@claude" "Map and review the API layer"

# Using flags instead of positional args
coral workflow -e "architect -> resolver" -s "Review auth.ts" -c "Security focus"
```

---

# Backend Tool (`ax`)

## backend

Bridge-local backend control tool. The backend does not advertise it in `GET /tools`; the bridge appends the descriptor and handles it locally without calling `/tool`.

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
  "liveDiscuss": 0,
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

# Knowledge Base Tools (`ax`)

These built-in tools are still routed through `POST /tool`, and backend `GET /tools` advertises the full KB surface: `kb_search`, `kb_principles`, `kb_read`, `kb_promote`, `kb_update`, `kb_delete`, `kb_source_import`, `kb_source_list`, `kb_source_delete`, `kb_memo`, `kb_memo_list`, `kb_memo_delete`, `kb_memo_purge`, and `kb_reindex`.

Agents still write memos directly under the active project's `memo/` directory, then use KB tools for search, promotion, updates, deletes, source management, memo management, principle lookup, and reindexing.

Additional KB operations:

- `kb_principles`: list or search indexed KB principles.
- `kb_read`: read a KB note, source, community, memo, or principle entry by slug.
- `kb_source_import`, `kb_source_list`, `kb_source_delete`: manage imported KB sources.
- `kb_memo_list`, `kb_memo_delete`, `kb_memo_purge`: inspect and clean up scoped project memos.

## kb_search

Searches KB note filename, principles, tags, title, and content with Orama BM25 text search.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Text query for BM25 search |
| `top_k` | integer | No | Max results to return (default `20`) |
| `scope` | string | No | Limit results to `notes`, `sources`, `communities`, or `all` (default). |

Returns `{ results, mode, warning? }`. Each result has `{ note, title, matchedBy, tags, principles, snippet?, communityContext? }` where `note` is a slug directly usable in `kb_update` and `kb_delete`. `communityContext` is an array of community summaries when results span a community's members. `mode` is `'text'` for Orama BM25 only and `'hybrid'` when text search is fused with vector and/or entity graph ranking.

## kb_memo

Writes a memo with auto-generated timestamp, path, and frontmatter. The project source is derived from the caller's working directory via `git remote`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `topic` | string | Yes | Kebab-case topic slug (e.g. `orama-threshold`) |
| `content` | string | Yes | Memo body text (one paragraph + context) |
| `owner` | string | Yes | Token-safe owner/session identifier. |

Returns `{ filename, path }`.

## kb_promote

Promotes a memo into a new KB note. Promotion is create-only: if the destination note already exists, the tool fails and the caller should use `kb_update` instead.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `memo` | string | Yes | Memo filename (e.g. `20260325-topic.md`), not a full path |
| `title` | string | Yes | Note title written as the H1 |
| `content` | string | Yes | Note body, typically `## Rule`, `## Why`, `## Pattern` |
| `domain` | string | Yes | Filename prefix |
| `topic` | string | Yes | Filename suffix |

Use `kb_search` first to check for duplicates before promotion.

## kb_update

Partially updates an existing KB note by note slug.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `note` | string | Yes | Note slug without path or extension (e.g. `rendering-guiding-contracts`) |
| `title` | string | No | Replacement H1 title |
| `content` | string | No | Replacement body |

## kb_delete

Deletes an existing KB note by note slug.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `note` | string | Yes | Note slug without path or extension (e.g. `rendering-guiding-contracts`) |

## kb_reindex

Rebuilds the derived KB text-search index from the markdown vault. The response `mode` uses `'text'` for the text snapshot and `'hybrid'` when vector sidecars are also available.

---

# Discuss Tools (`ax`)

Discuss tools remain MCP tools routed through `POST /tool`. There is no separate `dc` server: backend `GET /tools` advertises `discuss_seed`, `discuss_start`, `discuss_watch`, `discuss_participate`, and `discuss_abort`, and backend `routeToolCall()` dispatches them.

Sessions are stored under `~/.coral/projects/{source-slug}/discuss/`, with shared source discovery tracked in `~/.coral/discuss-sources.json`.

## discuss_seed

Generate seeded persona assignments from controversy axes.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `controversy_axes` | array | Yes | Array of `{ axis, positions[] }` pairs. |
| `n` | integer | Yes | Number of assignments to generate (`1-20`). |
| `seed` | integer | Yes | Deterministic RNG seed. |
| `demographics` | object | No | Optional `{ origin_weights, outlier_ratio? }` weighting metadata. |

Returns seeded assignments with tone metadata and optional demographics hints. Behavior notes:

- Cartesian-product pools larger than `256` are auto-subsampled before selection.
- Estimated pools larger than `100000` return `pool_too_large`.
- Degenerate single-position pools with `n > 1` return `pool_degenerate`.

## discuss_start

Start a backend-managed discussion session.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `topic` | string | Yes | Discussion topic. |
| `agents` | array | Yes | Array of `{ name, persona, participation?, provider?, model? }`. At least 2 agents required. |
| `config.min_bid_delay_ms` | integer | No | Optional minimum delay before bids are released. |

Returns `{ session }`. The backend assigns a UUID session ID, persists the initial state, opens the first bidding phase, and resumes the control loop.

## discuss_watch

Read the current watch projection for a session.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Discussion session ID. |
| `cursor` | integer | No | Resume from this event offset. Omit for full current history. |

Returns the `WatchState` projection:

```json
{
  "session": "session-uuid",
  "status": "bidding",
  "topic": "AI ethics in healthcare",
  "epoch": 1,
  "step": 3,
  "events": [],
  "cursor": 12
}
```

When `cursor` is provided, `events` only includes items newer than that offset.

## discuss_participate

Submit either a manual bid or a manual speech for an active participant.

Bid payload:

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Discussion session ID. |
| `agent_name` | string | Yes | Participant name. |
| `score` | integer | Yes | Bid score (`0-100`). |
| `thought` | string | Yes | Bid rationale. |

Speech payload:

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Discussion session ID. |
| `agent_name` | string | Yes | Participant name. |
| `content` | string | Yes | Speech text. |

Returns a bid/speech status object. Common responses are:

- `{ action: 'listen', speaker, content }`
- `{ action: 'speech_recorded' }`
- `{ action: 'not_your_turn', current_speaker }`
- `{ action: 'session_ended', reason?, content? }`

## discuss_abort

Force-end a live discussion session.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `session` | string | Yes | Discussion session ID. |

Returns `{ ok: true, session }` on success.

---

# Routing Contract

All tools still appear through the single `ax` MCP server, but the bridge is now endpoint-aware instead of sending every tool through `/tool`.

## Coupling Points

| Component | Role |
|-----------|------|
| `src/bridge/server.ts` + `src/bridge/backend-client.ts` | Fetch backend descriptors, append bridge-local `wait` and `backend`, and route provider/workflow/abort calls to dedicated endpoints |
| `src/execution/http-handler.ts` | Owns `/provider/:name`, `/workflow`, `/abort`, `/tool`, and `/wait/stream` |
| `src/execution/tool-router.ts` | Routes only `discuss_*` and `kb_*` calls from `/tool` |
| `src/execution/discuss/operations.ts` | Primary discuss runtime entry — uses `ExecutionService` to launch provider turns |
| `codex({ op: "coral:<agent>" })` / `claude({ op: "coral:<agent>" })` | Direct provider agent delegation path over `POST /provider/:name` |

The discuss system uses provider turns (codex/claude) through `ExecutionService`; it does not invoke provider tools through MCP.

## Session Naming Convention

- Discuss session IDs: backend-generated UUIDs
- Discuss data: `~/.coral/projects/{source-slug}/discuss/`
- Provider sessions: provider-specific session IDs tracked in the Coral session registry

These namespaces do not overlap.

## Contract

1. Backend `GET /tools` owns descriptors for providers, discuss, KB, `workflow`, and `abort`.
2. The bridge appends only `wait` and `backend`.
3. `/tool` only handles `discuss_*` and `kb_*`.
4. Provider tools, `workflow`, and `abort` use dedicated HTTP endpoints.
5. `wait` stays bridge-local and streams through `/wait/stream`.
