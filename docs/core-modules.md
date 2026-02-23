# Core Modules

Detailed description of the TypeScript modules across both MCP servers.

## Codex Server Modules (`src/codex/`)

### src/types.ts - Shared Type Definitions

Defines `CodexExecResult` (execution result: response, session ID, model, duration, exit code, errors, warnings), `SessionEntry` (per-session persistence: name, session ID, model, timestamps, working directory), and `CodexThreadEvent` / `CodexThreadItemDetails` (union types for Codex CLI JSONL event stream, based on `codex-rs/exec/src/exec_events.rs`). Referenced by all codex modules. See `src/types.ts`.

---

### src/codex/schemas.ts - Zod Input Validation

Defines a discriminated-union Zod schema for the unified `codex` MCP tool. Runtime validation uses `.parse()` at every handler entry point. Duplicated patterns are extracted into reusable building blocks:

| Schema | Usage |
|---|---|
| `identPattern` | Regex for model/session names - prevents flag injection |
| `sessionNameSchema` | Session name validation |
| `promptSchema` | Non-empty prompt string |
| `sessionRefSchema` | Session name or session ID reference |
| `cwdSchema` | Optional working directory |
| `reasoningEffortSchema` | Optional enum: `low`, `medium`, `high`, `xhigh` |
| `backgroundSchema` | Boolean, default `false` |

See `src/codex/schemas.ts`.

---

### src/codex/cli-detection.ts - Codex CLI Detection

Checks whether Codex CLI is installed. **Checks once per server lifetime** and caches the result - first call runs `codex --version`, subsequent calls return immediately. See `src/codex/cli-detection.ts`.

---

### src/codex/output-parser.ts - JSONL Output Parsing

Extracts text and session ID from Codex CLI `--json` mode JSONL output. **Single-pass pure function** - no state, no side effects.

**Handled event types:**

1. **`thread.started`** - Extract session ID (mapped from CLI's `thread_id`)
2. **`item.completed` + `agent_message`** - Extract `text` (multiple joined with `\n`) → `response`
3. **`item.completed` + `error`** - Collect `message` into `warnings`
4. **`error`** - Collect `message` into `errors` (deduplicated via Set)
5. **`turn.failed`** - Collect `error.message` into `errors` (skip if already collected via `error` event)

Lines that fail JSON parsing are silently skipped - Codex may intersperse debug output between JSONL lines. See `src/codex/output-parser.ts`.

---

### src/codex/codex-executor.ts - Codex CLI Execution

Core module that runs Codex CLI via `child_process.spawn` and collects results. Key behaviors:

- **Idle timeout**: 10 minutes - kills process if no stdout/stderr activity
- **Buffer limit**: 10MB - truncates with notice when exceeded
- **SIGTERM escalation**: 5-second grace period before SIGKILL
- **`activeChildren` set**: tracks all running child processes for graceful shutdown
- **`executeOneShot`**: new session (`codex exec -m MODEL --json --full-auto < prompt`)
- **`executeResume`**: continue session (`codex exec resume THREAD_ID ...`)
- **`executeFork`**: delegates to `executeResume` - `codex fork` is TUI-only and cannot run headlessly

**CLAUDE.md injection**: On new sessions, the plugin's CLAUDE.md is prepended to the prompt so Codex receives the same behavioral guidelines as Claude. Path resolved via `__PLUGIN_ROOT__` injected at build time. Content is cached after first read.

See `src/codex/codex-executor.ts`.

---

### src/codex/progress.ts - Progress File Utilities

Pure helper functions for Codex execution visibility. No server dependencies. Creates JSONL progress files in `$TMPDIR`, extracts human-readable messages from `CodexThreadEvent` objects (e.g., `Running: <command>`, `Editing: <path>`), and appends progress/result events. See `src/codex/progress.ts`.

---

### src/codex/session-manager.ts - Session Management

Per-session file persistence. Each session is stored as an individual JSON file under `~/.claude/coral/sessions/<project-hash>/`. Per-session files eliminate race conditions - concurrent sessions never touch the same file.

- **Atomic writes**: written to `.tmp` then `renameSync` - prevents corruption on crash
- **Project hash**: `sha256(resolve(workingDirectory)).slice(0, 12)` - isolates sessions per project
- **Lookup**: by name first, then by `codexThreadId` scan

See `src/codex/session-manager.ts`.

---

### src/codex/server-handlers.ts - Business Logic Handlers

All MCP tool business logic, extracted from `server.ts` to enable independent testing. `server.ts` is the composition root (wiring only); this module contains all handlers and the dispatch switch.

Key design: background vs foreground branching lives here. `handleToolCall` is the entry point - Zod validation at the top, then dispatch by `op`. Auto-generated session names (`session-{timestamp}`) are assigned here before calling handlers. See `src/codex/server-handlers.ts`.

---

## Discuss Server Modules (`src/discuss/`)

The discuss server follows a **Functional Core / Imperative Shell** architecture:
- **Pure functions** (`state-machine.ts`, `conditions.ts`, `transcript.ts`) - zero I/O imports, fully testable without filesystem
- **I/O shell** (`session-store.ts`, `wait.ts`) - filesystem operations
- **Wiring** (`server.ts`, `server-handlers.ts`) - connects tools to logic

---

### src/discuss/types.ts - Shared Type Definitions

Defines `DiscussState` (full session state: agents, bids, transcript, step, epoch, speaker), `AgentState` (per-agent tracking: quota, fallback_used, total_speaks, etc.), `TranscriptEntry` (discriminated union: `bids` / `speech` / `epoch_summary` / `session_event`), `Result<T>` (ok/error value type - all state-modifying functions return this, errors are values not throws), `EndReason`, and `PersonaAssignment`. Zero imports from `node:` or project modules. See `src/discuss/types.ts`.

---

### src/discuss/state-machine.ts - Pure State Transitions

All state-modifying logic. Zero I/O imports - `node:fs` and `node:path` are banned in this file. Every state-modifying function follows the signature pattern `(state, ...args, now: string) → Result<T>`.

Key functions: `initSession`, `applyBid`, `resolveWinner` (handles winner / fallback / cold_start / epoch_transition / max_epochs_reached / no_winner), `applySpeech` (sets monotonic `last_speech_step`), `applyEpochSummary`, `applyEnd`.

Also exports pure string utilities used by `session-store.ts` for directory naming: `randomSuffix`, `formatDateId`, `topicSlug`. This co-location is deliberate - these are pure utilities with no state machine semantics.

See `src/discuss/state-machine.ts`.

---

### src/discuss/conditions.ts - Wait Condition Predicates

Pure boolean predicates used by `wait.ts` when polling `state.json`:
- `allBidsIn(state)` - all agents have submitted bids AND status is bidding
- `speechDelivered(state)` - `last_speech_step === step - 1` (monotonic marker)
- `bidReleased(state)` - winner has been resolved (bid hold lifted)
- `isWinner(agentName)(state)` - this agent is the current winner
- `setupComplete(state)` - session has transitioned out of setup
- `noParticipants(state)` - no agents registered

These predicates are called by `waitForCondition` in `wait.ts` at polling intervals. `_3_step` in `server-handlers.ts` uses `waitForCondition` directly for moderator blocking. Discussant agents use `discuss({ op: "bid", ... })` and `discuss({ op: "speak", ... })` which also resolve via internal polling. See `src/discuss/conditions.ts`.

---

### src/discuss/wait.ts - Async File Polling

Polls `state.json` at intervals until a predicate is true or timeout expires. Key design: immediate first check, `lastKnownGood` pattern (returns last valid state even on timeout so callers always get a valid state object), transient read failures silently retried. Default poll interval: 500ms. `INFINITE_POLL=0` timeout means poll forever (used by agent-facing operations). See `src/discuss/wait.ts`.

---

### src/discuss/session-store.ts - I/O Shell

Handles session directory management, atomic writes, cross-process locking, and transcript rendering.

- **Lock**: `mkdir`-based (atomic test-and-set). Stale lock detection via PID liveness check + 30s age threshold
- **Atomic writes**: `.tmp` + `renameSync`, same pattern as codex session-manager
- **Directory naming**: `{session_id}-{topic_slug}` - imports `randomSuffix`, `formatDateId`, `topicSlug` from `state-machine.ts` (pure utilities, no circular dependency)
- **`save()`**: serializes state under lock, then calls `transcript.ts` for incremental markdown append

See `src/discuss/session-store.ts`.

---

### src/discuss/transcript.ts - Transcript Rendering

Pure functions on `TranscriptEntry[]`. Produces human-readable markdown with soft 80 / hard 100 word-wrap. Supports Korean/CJK sentence-ending patterns for grace-zone detection. Supports three modes: `recent` (last N entries), `full` (full transcript, bids visible), `summary` (epoch-level overview). Bid scores are filtered from agent-facing views. See `src/discuss/transcript.ts`.

---

### src/discuss/schemas.ts - Zod Input Validation

Zod schemas for the two discuss MCP tools. `discussAgentOpSchema` is a discriminated union on `op` covering `bid` and `speak`. `discussLeadOpSchema` covers `_1_seed` through `_7_end`. Cross-field constraints are enforced in `server-handlers.ts` after Zod validation. See `src/discuss/schemas.ts`.

---

### src/discuss/persona-seed.ts - k-DPP Persona Sampling

Pure implementation of k-Determinantal Point Process sampling for maximally diverse persona position assignment. Zero I/O. Key exports: `samplePersonaAssignments` (main entry point), `assignTones` (2×2×2 combinatorial assignment), `assignOrigins` (weighted demographics), `createSeededRng` (mulberry32 PRNG). See `src/discuss/persona-seed.ts`.

---

### src/discuss/server-handlers.ts - Tool Dispatch

Routes MCP tool calls to state-machine functions via `SessionStore`. All blocking operations use `waitForCondition` from `wait.ts`.

`_3_step` is the core moderator blocking operation: in bidding status it calls `waitForCondition(allBidsIn)`, then resolves the winner under lock. In speaking status it calls `waitForCondition(speechDelivered)`. All resolution runs inside `withLock` to prevent races between concurrent bid arrivals and wait completions.

`bid` handler: `applyBid` (pure) → if `allBidsIn`: `resolveWinner` (pure) → `store.save`. Winner resolution inside the lock ensures bid count and winner selection are atomic. See `src/discuss/server-handlers.ts`.

---

### src/discuss/server.ts - MCP Server Entry Point

Composition root (~40 lines). SDK + stdio transport setup, `SessionStore` initialization, shutdown signal handling. No business logic - delegates entirely to `server-handlers.ts`. See `src/discuss/server.ts`.
