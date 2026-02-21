# Core Modules

Detailed description of the TypeScript modules across both MCP servers.

## Codex Server Modules (`src/codex/`)

### src/types.ts — Shared Type Definitions

Defines `CodexExecResult` (execution result: response, thread ID, model, duration, exit code, errors, warnings), `SessionEntry` (per-session persistence: name, thread ID, model, timestamps, working directory), and `CodexThreadEvent` / `CodexThreadItemDetails` (union types for Codex CLI JSONL event stream, based on `codex-rs/exec/src/exec_events.rs`). Referenced by all codex modules. See `src/types.ts`.

---

### src/codex/schemas.ts — Zod Input Validation

Defines a discriminated-union Zod schema for the unified `codex` MCP tool. Runtime validation uses `.parse()` at every handler entry point. Duplicated patterns are extracted into reusable building blocks:

| Schema | Usage |
|---|---|
| `identPattern` | Regex for model/session names — prevents flag injection |
| `sessionNameSchema` | Session name validation |
| `promptSchema` | Non-empty prompt string |
| `sessionRefSchema` | Session name or thread ID reference |
| `cwdSchema` | Optional working directory |
| `reasoningEffortSchema` | Optional enum: `low`, `medium`, `high`, `xhigh` |
| `backgroundSchema` | Boolean, default `false` |

See `src/codex/schemas.ts`.

---

### src/codex/cli-detection.ts — Codex CLI Detection

Checks whether Codex CLI is installed. **Checks once per server lifetime** and caches the result — first call runs `codex --version`, subsequent calls return immediately. See `src/codex/cli-detection.ts`.

---

### src/codex/output-parser.ts — JSONL Output Parsing

Extracts text and thread ID from Codex CLI `--json` mode JSONL output. **Single-pass pure function** — no state, no side effects.

**Handled event types:**

1. **`thread.started`** — Extract `thread_id`
2. **`item.completed` + `agent_message`** — Extract `text` (multiple joined with `\n`) → `response`
3. **`item.completed` + `error`** — Collect `message` into `warnings`
4. **`error`** — Collect `message` into `errors` (deduplicated via Set)
5. **`turn.failed`** — Collect `error.message` into `errors` (skip if already collected via `error` event)

Lines that fail JSON parsing are silently skipped — Codex may intersperse debug output between JSONL lines. See `src/codex/output-parser.ts`.

---

### src/codex/codex-executor.ts — Codex CLI Execution

Core module that runs Codex CLI via `child_process.spawn` and collects results. Key behaviors:

- **Idle timeout**: 10 minutes — kills process if no stdout/stderr activity
- **Buffer limit**: 10MB — truncates with notice when exceeded
- **SIGTERM escalation**: 5-second grace period before SIGKILL
- **`activeChildren` set**: tracks all running child processes for graceful shutdown
- **`executeOneShot`**: new session (`codex exec -m MODEL --json --full-auto < prompt`)
- **`executeResume`**: continue session (`codex exec resume THREAD_ID ...`)
- **`executeFork`**: delegates to `executeResume` — `codex fork` is TUI-only and cannot run headlessly

**CLAUDE.md injection**: On new sessions, the plugin's CLAUDE.md is prepended to the prompt so Codex receives the same behavioral guidelines as Claude. Path resolved via `__PLUGIN_ROOT__` injected at build time. Content is cached after first read.

See `src/codex/codex-executor.ts`.

---

### src/codex/progress.ts — Progress File Utilities

Pure helper functions for Codex execution visibility. No server dependencies. Creates JSONL progress files in `$TMPDIR`, extracts human-readable messages from `CodexThreadEvent` objects (e.g., `Running: <command>`, `Editing: <path>`), and appends progress/result events. See `src/codex/progress.ts`.

---

### src/codex/session-manager.ts — Session Management

Per-session file persistence. Each session is stored as an individual JSON file under `~/.claude/coral/sessions/<project-hash>/`. Per-session files eliminate race conditions — concurrent sessions never touch the same file.

- **Atomic writes**: written to `.tmp` then `renameSync` — prevents corruption on crash
- **Project hash**: `sha256(resolve(workingDirectory)).slice(0, 12)` — isolates sessions per project
- **Lookup**: by name first, then by `codexThreadId` scan

See `src/codex/session-manager.ts`.

---

### src/codex/server-handlers.ts — Business Logic Handlers

All MCP tool business logic, extracted from `server.ts` to enable independent testing. `server.ts` is the composition root (wiring only); this module contains all handlers and the dispatch switch.

Key design: background vs foreground branching lives here. `handleToolCall` is the entry point — Zod validation at the top, then dispatch by `op`. Auto-generated session names (`session-{timestamp}`) are assigned here before calling handlers. See `src/codex/server-handlers.ts`.

---

## Discuss Server Modules (`src/discuss/`)

The discuss server follows a **Functional Core / Imperative Shell** architecture:
- **Pure functions** (`state-machine.ts`, `conditions.ts`, `transcript.ts`) — zero I/O imports, fully testable without filesystem
- **I/O shell** (`session-store.ts`, `wait.ts`) — filesystem operations
- **Wiring** (`server.ts`, `server-handlers.ts`) — connects tools to logic

---

### src/discuss/types.ts — Shared Type Definitions

Defines `DiscussState` (full session state: agents, bids, transcript, step, epoch, speaker), `TranscriptEntry` (discriminated union: `bids` / `speech` / `epoch_summary` / `session_event`), `Result<T>` (ok/error value type — all state-modifying functions return this, errors are values not throws), and `WaitCondition`. Zero imports from `node:` or project modules. See `src/discuss/types.ts`.

---

### src/discuss/state-machine.ts — Pure State Transitions

All state-modifying logic. Zero I/O imports — `node:fs` and `node:path` are banned in this file. Every function follows the signature pattern `(state, ...args, now: string) → Result<T>`.

Key functions: `initSession`, `applyBid`, `resolveWinner` (handles winner / fallback / cold_start / epoch_transition / max_epochs_reached / no_winner), `applySpeech` (sets monotonic `last_speech_step`), `applyEpochSummary`, `applyEnd`. See `src/discuss/state-machine.ts`.

---

### src/discuss/conditions.ts — Wait Condition Predicates

Pure boolean predicates used by `discuss({ op: "wait", ... })`:
- `allBidsIn(state)` — all bids submitted AND status is bidding
- `speechDelivered(state)` — `last_speech_step === step - 1` (monotonic marker)
- `actionNeeded(agent)(state)` — agent needs to bid, speak, or session ended

See `src/discuss/conditions.ts`.

---

### src/discuss/wait.ts — Async File Polling

Polls `state.json` at intervals until a predicate is true or timeout expires. Key design: immediate first check, `lastKnownGood` pattern (returns last valid state even on timeout so callers always get a valid state object), transient read failures silently retried. See `src/discuss/wait.ts`.

---

### src/discuss/session-store.ts — I/O Shell

Handles session directory management, atomic writes, cross-process locking, and legacy state migration.

- **Lock**: POSIX `mkdir`-based (atomic test-and-set). Stale lock detection via PID liveness check + 30s age threshold
- **Atomic writes**: `.tmp` + `renameSync`, same pattern as codex session-manager
- **`normalizeState`**: migrates legacy state.json schema to current — safe to call repeatedly

See `src/discuss/session-store.ts`.

---

### src/discuss/transcript.ts — Transcript Rendering

Pure functions on `TranscriptEntry[]`. Produces human-readable markdown with soft 80 / hard 100 word-wrap. Supports Korean/CJK sentence-ending patterns for grace-zone detection. Supports three modes: `recent` (last N entries), `full` (full transcript), `summary` (epoch-level overview). See `src/discuss/transcript.ts`.

---

### src/discuss/schemas.ts — Zod Input Validation

Zod schemas for the unified discuss API. `discussOpSchema` is a discriminated union on `op` covering all 8 operations. Cross-field constraints (e.g., `agent_name` required for `action_needed` wait) are enforced in `server-handlers.ts` after Zod validation. See `src/discuss/schemas.ts`.

---

### src/discuss/server-handlers.ts — Tool Dispatch

Routes MCP tool calls to state-machine functions via `SessionStore`. All `wait` calls use `waitForCondition` + auto-resolve inside lock.

Key pattern: `bid` → `applyBid` (pure) → if all bids in: `resolveWinner` (pure) → `store.save`. `wait/all_bids` auto-resolves the winner inside the lock to prevent races between the wait completing and a concurrent bid arriving. See `src/discuss/server-handlers.ts`.

---

### src/discuss/server.ts — MCP Server Entry Point

Composition root (~40 lines). SDK + stdio transport setup, `SessionStore` initialization, shutdown signal handling. No business logic — delegates entirely to `server-handlers.ts`. See `src/discuss/server.ts`.
