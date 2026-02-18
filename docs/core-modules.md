# Core Modules

Detailed description of the 6 core TypeScript modules.

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

### SessionRegistry

Full session registry structure persisted to disk.

```typescript
interface SessionRegistry {
  version: 1;                              // Schema version
  sessions: Record<string, SessionEntry>;  // name -> entry mapping
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

## src/mcp/schemas.ts — Zod Input Validation

Defines zod schemas for each of the 5 MCP tools. Runtime validation via `.parse()` at every handler entry point.

### Model Validation

```typescript
const modelPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
```

- First character must be alphanumeric (prevents leading dash -> flag injection)
- Rest allows alphanumeric, `.`, `_`, `-`
- Blocks shell metacharacters (`$`, `;`, `|`, etc.)

### Schema List

| Schema | Tool | Required Fields |
|---|---|---|
| `codexExecuteSchema` | `codex_execute` | `prompt` |
| `codexSessionCreateSchema` | `codex_session_create` | `name`, `prompt` |
| `codexSessionSendSchema` | `codex_session_send` | `session`, `prompt` (optional: `working_directory`) |
| `codexSessionListSchema` | `codex_session_list` | (none) |
| `codexSessionForkSchema` | `codex_session_fork` | `session` (optional: `working_directory`) |

Types are extracted from each schema using `z.infer<>` for use in handlers.

---

## src/mcp/cli-detection.ts — Codex CLI Detection

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

## src/mcp/output-parser.ts — JSONL Output Parsing

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

## src/mcp/codex-executor.ts — Codex CLI Execution

Core module that runs Codex CLI via `child_process.spawn` and collects results.

### Environment Settings

| Variable | Default | Description |
|---|---|---|
| `CORAL_CODEX_TIMEOUT_MS` | `900000` (15 min) | Codex execution timeout |
| `CORAL_CODEX_MODEL` | `gpt-5.3-codex` | Default model |
| `CORAL_MAX_CONCURRENT` | `5` | Max concurrent Codex processes |
| `CORAL_STAGGER_MS` | `3000` | Minimum interval between process starts (ms) |

### Constants

| Constant | Value | Description |
|---|---|---|
| `MAX_BUFFER` | 10MB | stdout/stderr buffer limit |
| `SIGKILL_DELAY` | 5 sec | Wait time between SIGTERM and SIGKILL |

### Process Management

- **`activeChildren`**: `Set<ChildProcess>` tracking running child processes
- **`appendBuffer()`**: Appends data to buffer, truncates with `[output truncated at 10MB]` message when limit is exceeded
- **Timeout**: SIGTERM -> 5-second wait -> SIGKILL escalation
- **`killAllChildren()`**: Sends SIGTERM -> SIGKILL escalation to all tracked child processes. Used during graceful shutdown. Sets `shuttingDown` flag to immediately reject queued requests.

### Concurrency Control

Semaphore-based concurrency limiting is applied at the `runCodex()` level.

- **Semaphore**: Max `CORAL_MAX_CONCURRENT` concurrent processes
- **Stagger**: Minimum `CORAL_STAGGER_MS` interval between process starts (burst prevention). Serialized via stagger mutex to prevent race conditions between concurrent coroutines.
- **FIFO queue**: Excess requests wait in order
- **Shutdown guard**: After `killAllChildren()`, new requests are immediately rejected (double-check after semaphore acquire + after stagger)

Automatically applied to all execution paths (executeOneShot, executeResume, executeFork).

### Public Functions

#### `executeOneShot(prompt, model?, cwd?): Promise<CodexExecResult>`

One-shot execution.

```bash
codex exec -m MODEL --json --full-auto < prompt
```

- Passes prompt via stdin
- Parses stdout with `parseCodexJsonl()`

#### `executeResume(threadId, prompt, model?, cwd?): Promise<CodexExecResult>`

Resume an existing session.

```bash
codex exec resume THREAD_ID -m MODEL --json --full-auto < prompt
```

- Passes `resume` subcommand and thread ID as arguments
- If no new thread ID is returned, retains the original

#### `executeFork(threadId, prompt?, model?, cwd?): Promise<CodexExecResult>`

Fork a session. Internally delegates to `executeResume()`.

> `codex fork` is a TUI-only command (`run_interactive_tui()`) and cannot run headlessly.
> Implemented via resume-based conversation continuation.

#### `killAllChildren(): void`

Terminates all tracked child processes. Sends SIGTERM, then escalates to SIGKILL if not terminated within 3 seconds. Called from `server.ts`'s graceful shutdown handler.

### console.log Prohibition

This module runs inside a stdio MCP server. `console.log` writes to stdout, which would break the MCP protocol. All debug output must use `process.stderr.write()`.

---

## src/mcp/session-manager.ts — Session Management

Class that persists a name-based session registry to `.claude/coral/sessions.json`.

### Storage Path

```
{workingDirectory}/.claude/coral/sessions.json
```

If `workingDirectory` is not specified, `process.cwd()` is used. Directory is auto-created with `mkdirSync` if it doesn't exist.

### Atomic Writes

On save, data is first written to a temporary file (`.tmp`), then atomically swapped via `renameSync`. Prevents data loss from crashes during writes.

### Error Classification

On file load:
- `ENOENT` -> Initialize with empty registry (normal)
- `SyntaxError` -> Log warning to stderr, use empty registry (corrupted file)
- Other -> Re-throw (unexpected error)

### SessionManager Class

#### `constructor(workingDirectory?: string)`

Loads the registry file. Recovers or throws based on error classification.

#### `register(name, codexThreadId, model, workingDirectory): SessionEntry`

Registers a new session. `createdAt` and `lastUsedAt` are set to current time. Written to disk immediately.

#### `get(nameOrId): SessionEntry | null`

Looks up a session.

**Search priority:**
1. `sessions[nameOrId]` — direct match by name
2. Iterate `Object.values(sessions)` checking `codexThreadId === nameOrId` — search by thread ID

#### `list(): SessionEntry[]`

Returns all registered sessions as an array.

#### `updateSession(name, fields?: { model?: string }): void`

Updates the specified session's `lastUsedAt` to current time. Also updates `model` if provided. Saved to disk.

#### `remove(name): boolean`

Deletes a session. Returns `true` on success, `false` if session doesn't exist.

### sessions.json Example

```json
{
  "version": 1,
  "sessions": {
    "my-review": {
      "name": "my-review",
      "codexThreadId": "abc-123-def",
      "model": "gpt-5.3-codex",
      "createdAt": "2026-02-18T08:30:00.000Z",
      "lastUsedAt": "2026-02-18T09:15:00.000Z",
      "workingDirectory": "/home/user/project"
    }
  }
}
```
