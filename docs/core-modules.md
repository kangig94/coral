# Core Modules

Detailed description of the TypeScript modules across both MCP servers.

## Codex Server Modules (`src/codex/`)

## src/types.ts — Shared Type Definitions

Defines interfaces and types referenced by all modules.

### CodexExecResult

Interface for Codex CLI execution results.

```typescript
interface CodexExecResult {
  response: string;        // Parsed text response
  threadId: string | null; // Codex thread UUID (extracted from thread.started)
  model: string;           // Model used
  durationMs: number;      // Execution duration (ms)
  exitCode: number | null; // Process exit code
  errors: string[];        // Fatal error messages (deduplicated)
  warnings: string[];      // Warning messages
}
```

### SessionEntry

Individual session entry stored in the session registry.

```typescript
interface SessionEntry {
  name: string;             // User-assigned session name
  codexThreadId: string;    // Thread UUID returned by Codex CLI
  model: string;            // Model used when session was created
  createdAt: string;        // ISO 8601 creation time
  lastUsedAt: string;       // ISO 8601 last used time
  workingDirectory: string; // Session working directory
}
```

### CodexThreadEvent

Union type for events output by Codex CLI in JSONL `--json` mode. Based on `codex-rs/exec/src/exec_events.rs`.

```typescript
type CodexThreadEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number } }
  | { type: 'turn.failed'; error: { message: string } }
  | { type: 'item.started'; item: CodexThreadItem }
  | { type: 'item.updated'; item: CodexThreadItem }
  | { type: 'item.completed'; item: CodexThreadItem }
  | { type: 'error'; message: string };
```

### CodexThreadItem / CodexThreadItemDetails

Thread item is composed of `{ id: string } & CodexThreadItemDetails`. 9 known variants + catch-all:

```typescript
type CodexThreadItemDetails =
  | { type: 'agent_message'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'command_execution'; command: string; aggregated_output: string; exit_code: number | null; status: string }
  | { type: 'file_change'; changes: Array<{ path: string; kind: string }>; status: string }
  | { type: 'mcp_tool_call'; server: string; tool: string; arguments: unknown; result: unknown; error: unknown; status: string }
  | { type: 'collab_tool_call'; tool: string; sender_thread_id: string; receiver_thread_ids: string[]; prompt: string | null; status: string }
  | { type: 'web_search'; query: string; action: unknown }
  | { type: 'todo_list'; items: Array<{ text: string; completed: boolean }> }
  | { type: 'error'; message: string }
  | { type: string; [key: string]: unknown };  // catch-all for future types
```

---

## src/codex/schemas.ts — Zod Input Validation

Defines a discriminated-union Zod schema for the unified `codex` MCP tool. Runtime validation uses `.parse()` at every handler entry point.

### Shared Building Blocks

Duplicated patterns are extracted into reusable schemas:

| Schema | Usage |
|---|---|
| `identPattern` | Regex for model names and session names: `/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/` (prevents flag injection) |
| `sessionNameSchema` | Session name validation with `identPattern` |
| `promptSchema` | Non-empty prompt string (min 1 char) |
| `sessionRefSchema` | Session name or thread ID reference |
| `cwdSchema` | Optional working directory |
| `reasoningEffortSchema` | Optional enum: `low`, `medium`, `high`, `xhigh` |
| `backgroundSchema` | Boolean, default `false` — run in background |

### Schema List

| Schema | Tool | Required Fields | Optional Fields |
|---|---|---|---|
| `codexOpSchema` | `codex` | `op` (`exec`, `list`, `fork`, `abort`) | Discriminator-specific fields per op |

Types are extracted from the discriminated schema with `z.infer<>` for use in handlers.

---

## src/codex/cli-detection.ts — Codex CLI Detection

Checks whether Codex CLI is installed and its version. **Checks once per server lifetime** and caches the result.

### Functions

#### `detectCodexCli(): Promise<CliInfo>`

Runs `codex --version` to verify CLI existence.

- **Caching**: First call result is stored in `cached` variable. Subsequent calls return immediately.
- **Timeout**: 10-second timeout on `execFile`.
- **Return values**:
  - Success: `{ available: true, version: "codex 1.2.3" }`
  - Failure: `{ available: false, error: "Codex CLI not found. Install it with: npm install -g @openai/codex" }`

#### `resetCliCache(): void`

Resets the cache. Used in tests.

---

## src/codex/output-parser.ts — JSONL Output Parsing

Extracts text and thread ID from Codex CLI `--json` mode JSONL output. **Single-pass pure function**.

### Functions

#### `parseCodexJsonl(output: string): ParsedCodexOutput`

Parses JSONL stdout in one pass, structurally separating response, errors, and warnings.

```typescript
interface ParsedCodexOutput {
  response: string;        // agent_message text only
  threadId: string | null;
  errors: string[];        // Fatal error messages (deduplicated)
  warnings: string[];      // Warning messages
}
```

**Handled event types:**

1. **`thread.started`** — Extract `thread_id`
2. **`item.completed` + `agent_message`** — Extract `text` (multiple joined with `\n`) -> `response`
3. **`item.completed` + `error`** — Collect `message` into `warnings` array
4. **`error`** — Collect `message` into `errors` array (dedup via Set)
5. **`turn.failed`** — Collect `error.message` into `errors` array (skip if already collected via `error` event)

**Return value**: `response` (agent_message only), `errors: string[]`, `warnings: string[]`, `threadId` (null if absent).

### Error Handling

Lines that fail JSON parsing are silently skipped (`continue`). Codex may intersperse debug output between JSONL lines.

---

## src/codex/codex-executor.ts — Codex CLI Execution

Core module that runs Codex CLI via `child_process.spawn` and collects results.

### Environment Settings

| Variable | Default | Description |
|---|---|---|
| `CORAL_CODEX_MODEL` | `gpt-5.3-codex` | Default model |

### Constants

| Constant | Value | Description |
|---|---|---|
| `IDLE_TIMEOUT` | 10 min | Inactivity timeout — kills process if no stdout/stderr activity |
| `MAX_BUFFER` | 10MB | stdout/stderr buffer limit |
| `SIGTERM_GRACE_MS` | 5 sec | Grace period before escalating SIGTERM to SIGKILL |

### Process Management

- **`activeChildren`**: `Set<ChildProcess>` tracking running child processes
- **`appendBuffer()`**: Appends data to buffer, truncates with `[output truncated at 10MB]` message when limit is exceeded
- **Idle timeout**: Process is killed if no output activity for 10 minutes (resets on every stdout/stderr data event)
- **Escalation**: SIGTERM -> 5-second wait -> SIGKILL
- **`killAllChildren()`**: Sends SIGTERM -> SIGKILL escalation to all tracked child processes. Used during graceful shutdown.

### Public Functions

#### `executeOneShot(prompt, model?, cwd?, reasoningEffort?, onEvent?): Promise<CodexExecResult>`

One-shot execution.

```bash
codex exec -m MODEL --json --full-auto [--reasoning-effort LEVEL] < prompt
```

- Prepends CLAUDE.md content to the prompt (`prependClaudeMd`) — Codex receives project guidelines
- Parses stdout with `parseCodexJsonl()`
- `onEvent` callback receives each JSONL line as it arrives (used for progress reporting)
- `reasoningEffort` maps to `--reasoning-effort` CLI flag

#### `executeResume(threadId, prompt, model?, cwd?, reasoningEffort?, onEvent?): Promise<CodexExecResult>`

Resume an existing session.

```bash
codex exec resume THREAD_ID -m MODEL --json --full-auto [--reasoning-effort LEVEL] < prompt
```

- Passes `resume` subcommand and thread ID as arguments
- If no new thread ID is returned, retains the original
- Does NOT prepend CLAUDE.md (already injected in the first turn)

#### `executeFork(threadId, prompt?, model?, cwd?, reasoningEffort?, onEvent?): Promise<CodexExecResult>`

Fork a session. Internally delegates to `executeResume()`.

> `codex fork` is a TUI-only command (`run_interactive_tui()`) and cannot run headlessly.
> Implemented via resume-based conversation continuation.

#### `killAllChildren(): void`

Terminates all tracked child processes. Sends SIGTERM, then escalates to SIGKILL after `SIGTERM_GRACE_MS` (5 seconds). Called from `server.ts`'s graceful shutdown handler.

### CLAUDE.md Injection

On new sessions (`executeOneShot`), the plugin's CLAUDE.md is prepended to the prompt so Codex receives the same behavioral guidelines as Claude.

- **Path resolution**: `__PLUGIN_ROOT__` is injected at build time via esbuild banner (`require("path").resolve(__dirname, "..")`)
- **Caching**: CLAUDE.md content is read once and cached (`claudeMdCache`)
- **Graceful fallback**: If CLAUDE.md cannot be read, prompt is sent unchanged

### console.log Prohibition

This module runs inside a stdio MCP server. `console.log` writes to stdout, which would break the MCP protocol. All debug output must use `process.stderr.write()`.

---

## src/codex/progress.ts — Progress File Utilities

Pure helper functions for Codex execution visibility. No server dependencies.

### Functions

#### `createProgressFile(session, tool): string`

Creates a JSONL progress file in `$TMPDIR` with a metadata header. Returns the file path (`/tmp/coral-progress-<uuid>.jsonl`).

#### `removeProgressFile(filePath): void`

Deletes a progress file. Swallows errors (file may not exist). Called after foreground execution completes.

#### `extractProgressMessage(event): string | null`

Extracts a human-readable message from a `CodexThreadEvent`. Used for both `notifications/progress` display and progress file entries.

| Event Type | Message |
|---|---|
| `turn.started` | `Processing...` |
| `item.completed` + `reasoning` | First 120 chars of reasoning text |
| `item.completed` + `web_search` | `Searching: <query>` |
| `item.completed` + `agent_message` | `Generating response...` |
| `item.completed` + `command_execution` | `Running: <command>` |
| `item.completed` + `file_change` | `Editing: <path>` |
| `item.completed` + `mcp_tool_call` | `Calling: <tool>` |

#### `extractProgressId(filePath): string | null`

Extracts the UUID from a progress file path.

#### `appendProgressEvent(filePath, eventType, message): void`

Appends a progress event line to the JSONL file. Non-fatal on write errors.

#### `appendFinalResult(filePath, event, data): void`

Appends a terminal `completed` or `error` event to the progress file.

---

## src/codex/session-manager.ts — Session Management

Per-session file persistence. Each session is stored as an individual JSON file.

### Storage Layout

```
~/.claude/coral/sessions/
└── <project-hash>/          # sha256(resolve(workingDirectory)).slice(0, 12)
    ├── review.json
    ├── auth-audit.json
    └── perf-pass.json
```

Per-session files eliminate race conditions — concurrent sessions never touch the same file.

### Atomic Writes

On save, data is first written to a temporary file (`.tmp`), then atomically swapped via `renameSync`. Prevents data loss from crashes during writes.

### SessionManager Class

#### `constructor(workingDirectory: string)`

Computes project hash from working directory and creates the session directory if needed.

#### `register(name, codexThreadId, model, workingDirectory): SessionEntry`

Creates a new session file. `createdAt` and `lastUsedAt` are set to current time.

#### `get(nameOrId): SessionEntry | null`

Looks up a session. Searches by filename first, then scans all files for matching `codexThreadId`.

#### `list(): SessionEntry[]`

Reads all session files in the project directory. Corrupt files are skipped with a warning.

#### `updateSession(name, fields?: { model?: string }): void`

Updates `lastUsedAt` and optionally `model`. Saved to disk.

#### `remove(name): boolean`

Deletes the session file. Returns `true` on success, `false` if not found.

### Session File Example

```json
{
  "name": "my-review",
  "codexThreadId": "abc-123-def",
  "model": "gpt-5.3-codex",
  "createdAt": "2026-02-18T08:30:00.000Z",
  "lastUsedAt": "2026-02-18T09:15:00.000Z",
  "workingDirectory": "/home/user/project"
}
```

---

## src/codex/server-handlers.ts — Business Logic Handlers

All MCP tool business logic, extracted from `server.ts` to enable independent testing. `server.ts` is the composition root (wiring only); this module contains all handlers and the dispatch switch.

### MCP Response Helpers

#### `textResult(text, isError?): McpResult`

Wraps a string in the MCP `{ content: [{ type: "text", text }], isError }` format.

#### `jsonResult(data): McpResult`

Stringifies an object with 2-space indent and wraps via `textResult`.

#### `resultExtras(result): Record<string, unknown>`

Extracts conditional fields (`exit_code`, `errors`, `warnings`) from a Codex result. Returns an empty object when all are nominal.

#### `sessionNotFoundError(ref): McpResult`

Returns an `isError: true` response with recovery hint (use `codex({ op: "exec" })` or `codex({ op: "list" })`).

### Progress & Background Execution

#### `makeEventCallback(opts): OnEventCallback`

Builds a callback that processes Codex JSONL events. Writes to the progress file via `appendProgressEvent` and optionally sends `notifications/progress` with `[Codex]` prefix and incrementing counter.

#### `launchBackground(sessionLabel, toolName, handler): McpResult`

Launches a handler asynchronously with a progress file. Returns immediately with `{ progress_id, progress_file, session_name, status: "launched" }`. The `.then()` chain writes a `completed` event; `.catch()` writes an `error` event; `.finally()` removes the file from `activeBackgroundFiles`.

#### `runForeground(sessionLabel, toolName, progressToken, notify, handler): Promise<McpResult>`

Runs a handler synchronously. Creates a progress file only when `progressToken` is present (for MCP notification support). Cleans up the progress file in `finally`.

### Tool Handlers

#### `handleSessionCreate(input, mgr, onEvent?): Promise<McpResult>`

Executes `executeOneShot`, registers the session if a thread ID is returned, returns the response. The `name` field is always pre-set by the dispatcher (defensive fallback for direct invocation).

#### `handleSessionSend(input, mgr, onEvent?): Promise<McpResult>`

Looks up the session, executes `executeResume` with the stored thread ID, updates `lastUsedAt`. Internal session guard for safe direct invocation (defense in depth — dispatcher also checks).

#### `handleSessionList(mgr): Promise<McpResult>`

Maps all registered sessions to the output format with `sessions` array and `total` count.

#### `handleSessionFork(input, mgr, onEvent?): Promise<McpResult>`

Executes `executeFork` with the source session's thread ID. Registers a new session only if both `name` and `threadId` are present. Internal session guard (defense in depth).

### Dispatcher

#### `handleToolCall(name, rawArgs, sessionManager, progressToken?, notify?): Promise<McpResult>`

Routes MCP tool calls to handlers. Parses input with Zod schemas, applies background/foreground branching, and catches validation errors as `isError` responses. Owns session name generation for `codex`.

### Exports

- `tools` — MCP tool definitions array (used by `ListToolsRequestSchema` handler)
- `activeBackgroundFiles` — `Set<string>` for shutdown cleanup
- `OnEventCallback` type

---

## Discuss Server Modules (`src/discuss/`)

The discuss server follows a **Functional Core / Imperative Shell** architecture:
- **Pure functions** (`state-machine.ts`, `conditions.ts`, `transcript.ts`) have zero I/O imports
- **I/O shell** (`session-store.ts`, `wait.ts`) handles filesystem operations
- **Wiring** (`server.ts`, `server-handlers.ts`) connects tools to logic

---

### src/discuss/types.ts — Shared Type Definitions

Defines all discuss types. Zero imports from `node:` or project modules.

#### DiscussState

```typescript
interface DiscussState {
  session_id: string;
  session_dir: string;
  topic: string;
  status: 'setup' | 'bidding' | 'speaking' | 'ended';
  step: number;
  epoch: number;
  quota_per_epoch: number;
  agents: Record<string, AgentState>;
  current_bids: Record<string, number | null>;
  pending_bidders: string[];
  current_speaker: string | null;
  speaker_type: 'normal' | 'fallback' | 'cold_start' | null;
  last_speech_step: number;        // monotonic marker for speech detection
  transcript: TranscriptEntry[];   // structured transcript in state
  transcript_rendered: number;     // tracks .md append position
}
```

#### TranscriptEntry (Discriminated Union)

4 entry types: `bids`, `speech`, `epoch_summary`, `session_event`.

#### Result\<T\>

```typescript
type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; detail?: Record<string, unknown> };
```

Every state-modifying function returns `Result<T>` — errors are values, never thrown.

#### WaitCondition

```typescript
type WaitCondition = 'all_bids' | 'speech_delivered' | 'action_needed';
```

---

### src/discuss/state-machine.ts — Pure State Transitions

All state-modifying logic. Zero I/O imports (`node:fs`, `node:path` are banned in this file).

**Signature pattern**: `(state: DiscussState, ...args, now: string) → Result<T>`

#### Key Functions

| Function | Description |
|---|---|
| `initSession(input, sessionId, sessionDir, now)` | Create initial DiscussState from `discuss({ "op": "create", ... })` input |
| `applyBid(state, agent, score, now)` | Record a bid, remove from pending_bidders |
| `resolveWinner(state, now)` | Resolve bidding round: winner, fallback, cold_start, epoch_transition, max_epochs_reached, no_winner |
| `applySpeech(state, agent, content, now)` | Record speech, set monotonic `last_speech_step`, advance step |
| `applyEpochSummary(state, epoch, summary, now)` | Record epoch summary, validate epoch number |
| `applyEnd(state, opts, now)` | Transition to ended status, record synthesis or force-end |

#### Helpers

| Function | Description |
|---|---|
| `parseDisplayName(persona, agentName)` | Extract `Name` from `# Name — Role` first line |
| `randomSuffix()` | 4-char random alphanumeric suffix |
| `formatDateId(date)` | Format as `yymmdd-HHmm` (compact timestamp for session IDs) |
| `topicSlug(topic)` | URL-safe slug preserving CJK characters |

---

### src/discuss/conditions.ts — Wait Condition Predicates

Pure boolean predicates used by `discuss({ op: "wait", ... })` to detect when to unblock.

| Predicate | Condition |
|---|---|
| `allBidsIn(state)` | All bids submitted AND status is bidding |
| `speechDelivered(state)` | `last_speech_step === step - 1` AND status is bidding (monotonic marker) |
| `actionNeeded(agent)(state)` | Agent needs to bid, speak, or vote right now |

---

### src/discuss/wait.ts — Async File Polling

Polls `state.json` at intervals until a predicate is true or timeout expires.

#### `waitForCondition(statePath, predicate, timeoutMs, intervalMs?): Promise<WaitResult>`

- Immediate first check before entering poll loop
- `lastKnownGood` pattern: tracks last successful read so timeout always returns a valid state
- Cancellation safety: stores `setTimeout` handle and clears on resolution
- Transient read failures (mid-rename, corrupt JSON) are silently retried

---

### src/discuss/session-store.ts — I/O Shell

Handles session directory management, atomic writes, cross-process locking, and legacy state migration.

#### SessionLock

Cross-process `mkdir`-based lock (POSIX atomic test-and-set). Stale lock detection via PID liveness check + 30s age threshold.

#### normalizeState(raw)

Migrates legacy state.json to current schema. Safe to call on already-normalized state. Works on raw `Record<string, unknown>` before casting to avoid TypeScript `in` narrowing issues on required fields.

#### SessionStore Class

| Method | Description |
|---|---|
| `createSessionDir(topic)` | Create session directory with collision detection (3 retries) |
| `resolveDir(sessionId)` | Resolve directory from session_id prefix |
| `load(fullSessionPath)` | Load and normalize state |
| `save(fullSessionPath, state)` | Atomic write + incremental transcript.md append |
| `initTranscript(fullSessionPath, topic)` | Write transcript.md header |
| `withLock(fullSessionPath, fn)` | Acquire cross-process lock and run fn |

---

### src/discuss/transcript.ts — Transcript Rendering

Pure functions operating on structured `TranscriptEntry[]`. Human-readable format with timestamps and soft 80 / hard 100 word-wrap. Supports Korean/CJK sentence-ending patterns for grace-zone detection.

| Function | Description |
|---|---|
| `renderHeader(topic)` | Render transcript.md header |
| `renderEntries(entries, agents)` | Render entries to markdown (speech, bids, vote, epoch_summary, session_event) |
| `formatRecent(state, lastN?)` | Format recent transcript: summary of old entries + full recent entries |
| `formatFull(state)` | Format all entries (restricted access — current speaker or ended session) |
| `formatSummary(state)` | Format epoch-level summary overview |

---

### src/discuss/schemas.ts — Zod Input Validation

Zod schemas for the unified discuss API.

| Schema | Tool | Required Fields |
|---|---|---|
| `discussOpSchema` | `discuss` (`op` discriminated union) | `op` + op-specific fields (`create`, `bid`, `wait`, `speak`, `transcript`, `state`, `end`, `epoch_summary`) |
| `discussPersonaSeedSchema` | `discuss_persona_seed` | `controversy_axes`, `n` |

Notable validation: `discussOpSchema` handles structural validation for all ops; cross-field wait/end constraints are enforced in `server-handlers.ts`.

---

### src/discuss/server-handlers.ts — Tool Dispatch

Routes MCP tool calls to state-machine functions via `SessionStore`. All `discuss({ op: "wait", ... })` calls use `waitForCondition` + auto-resolve inside lock.

#### `handleToolCall(name, rawArgs, store): Promise<McpResult>`

Dispatches to per-tool handlers. Zod validation at entry. Unknown tools return `isError` response.

#### Key handler patterns

- **`discuss({ "op": "create", ... })`**: `initSession` (pure) → `store.save` (I/O)
- **`discuss({ op: "bid", ... })`**: `store.withLock` → `applyBid` (pure) → if all bids in: `resolveWinner` (pure) → `store.save`
- **`discuss({ op: "wait", ... })`**: `waitForCondition` (polling) → if `all_bids`: auto-resolve inside lock → return result
- **`discuss({ op: "speak", ... })`**: `store.withLock` → `applySpeech` (pure) → `store.save`

---

### src/discuss/server.ts — MCP Server Entry Point

Composition root (~40 lines). SDK + stdio transport setup, SessionStore initialization, shutdown signal handling. No business logic — delegates entirely to `server-handlers.ts`.
