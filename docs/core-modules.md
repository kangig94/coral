# Core Modules

Detailed description of the TypeScript modules across both MCP servers.

## Unified AX Server Modules (`src/ax/`)

### src/ax/server.ts - AX Composition Root

Creates one MCP stdio server exposing two tools (`codex`, `claude`). Wires request handlers, shared `SessionManager`, shutdown behavior, and child-process cleanup through `runner/engine.ts`. See `src/ax/server.ts`.

---

### src/ax/server-handlers.ts - AX Tool Router

Routes by tool name:
- `codex` requests to the Codex adapter
- `claude` requests to the Claude adapter
- `coral:<name>` delegation rules:
  - Codex supports both agent and skill content (prompt prepend)
  - Claude supports agents only; skills return an explicit error

See `src/ax/server-handlers.ts`.

---

## Shared Runner Modules (`src/runner/`)

### src/runner/types.ts - Runner Contracts

Defines provider-aware shared types:
- `SessionProvider = 'codex' | 'claude'`
- `SessionEntry` (provider-scoped persisted session metadata)
- `CliExecResult` (generic CLI execution output)
- `CompletionMetadata` (terminal status payload contract)

These are consumed by both adapters and AX handlers.

---

### src/runner/engine.ts - Shared Spawn Engine

Owns process lifecycle and backpressure:
- `spawnCli(...)` for Codex/Claude subprocesses
- idle timeout + bounded output buffering
- graceful kill (`SIGTERM` then `SIGKILL`)
- launch caps: global and per-provider
- `killAllChildren()` for shutdown

See `src/runner/engine.ts`.

---

### src/runner/session-manager.ts - Persisted Session Registry

Project-scoped session files under `~/.claude/coral/sessions/<project-hash>/`. Provider-aware methods (`register/get/list/remove/updateSession`) enforce Codex/Claude isolation. Includes v1 + v2-no-provider migrations defaulting to `provider: 'codex'`.

See `src/runner/session-manager.ts`.

---

### src/runner/progress.ts - Session Run I/O

Creates and manages run directories under `$TMPDIR/coral-sessions/`:
- `createSessionDir`, `resolveSessionDir`
- `writeSessionResult`, `writeSessionError`, `readSessionStatus`
- append-only `progress.jsonl` writes

See `src/runner/progress.ts`.

---

### src/runner/job-manager.ts - Shared Job Lifecycle

Provides adapter-agnostic execution lifecycle:
- `launchJob(...)` with hook contract (`makeOnEvent`, `extractCompletion`)
- `activeSessions` (ephemeral provider-scoped running map)
- `tryClaimTerminalWrite(...)` CAS for terminal state writes
- `handleWait(provider, ...)` cursor-based progress polling
- `shutdownSignal` for cooperative shutdown

See `src/runner/job-manager.ts`.

---

### src/runner/coral-resolver.ts - Agent/Skill Resolver

Resolves `coral:<name>` content from plugin root with containment checks:
- first `agents/<name>.md`
- then `skills/<name>/SKILL.md`
- path traversal rejection
- `stripAgentMetadata(...)` helper for Claude `--system-prompt` injection

See `src/runner/coral-resolver.ts`.

---

## Codex Adapter Modules (`src/codex/`)

The Codex adapter is now thin and provider-specific. Shared launch/wait/session infrastructure lives in `src/runner/`.

### src/codex/codex-executor.ts

Codex-specific execution wrapper over `runner/engine.ts`:
- builds Codex CLI args (`exec`, `resume`, `fork`)
- parses JSONL events through `output-parser.ts`
- prepends plugin `CLAUDE.md` for one-shot sessions

### src/codex/server-handlers.ts

Codex MCP behavior (`exec/list/fork/wait/abort/coral:*`) using runner primitives for background job execution and waiting.

### src/codex/schemas.ts / cli-detection.ts / output-parser.ts / progress.ts / session-manager.ts

Input validation, CLI/auth probing, JSONL parsing, and small compatibility wrappers retained for Codex-specific behavior.

---

## Claude CLI Adapter Modules (`src/claude/`)

### src/claude/schemas.ts

Zod schemas for `claude` tool operations:
- `exec`, `list`, `wait`, `abort`
- `coral:<name>` routing input for AX handlers

### src/claude/cli-detection.ts

Claude CLI availability/auth probe with cache + in-flight deduplication:
- binary detection via `claude --version`
- auth fast path via `ANTHROPIC_API_KEY`
- canonical auth probe via `claude auth status --json`

### src/claude/claude-executor.ts

Claude execution wrapper over `runner/engine.ts`:
- prompt transport via stdin (`-p` mode)
- JSON output parsing (`--output-format json`)
- resume support via `--resume`
- structured parse-failure surface (`ClaudeExecParseError`)

### src/claude/types.ts

Defines `ClaudeExecResult`, `ClaudeJsonOutput`, and `ClaudeExecFailure`.

---

### src/types.ts - Shared Cross-Adapter Types

Defines `CodexExecResult` and Codex JSONL event types (`CodexThreadEvent`, `CodexThreadItemDetails`) and re-exports shared `SessionEntry` from `runner/types.ts`.

## Discuss Server Modules (`src/discuss/`)

The discuss server follows a **Functional Core / Imperative Shell** architecture with strict layered dependencies:
- **L0** (`types.ts`) — zero imports; type definitions only
- **L1** (`util/`) — pure primitives: string formatting, seeded RNG, k-DPP linear algebra
- **L2 Functional Core** (`state-machine.ts`, `conditions.ts`, `transcript.ts`, `persona-seed.ts`) — zero I/O, fully testable without filesystem
- **L3 Imperative Shell** (`lock.ts`, `session-store.ts`, `wait.ts`) — all filesystem operations
- **L4** (`handlers/utils.ts`) — shared cross-handler utilities
- **L5** (`handlers/bid.ts`, `handlers/step.ts`) — extracted flow handlers
- **L6 Dispatch** (`server-handlers.ts`) — thin tool router (Zod parsing + routing)
- **L7** (`server.ts`) — composition root (wiring only)

---

### src/discuss/types.ts - Shared Type Definitions

Defines `DiscussState` (full session state: agents, bids, transcript, step, epoch, speaker), `AgentState` (per-agent tracking: quota, fallback_used, total_speaks, etc.), `TranscriptEntry` (discriminated union: `bids` / `speech` / `epoch_summary` / `session_event`), `Result<T>` (ok/error value type - all state-modifying functions return this, errors are values not throws), `EndReason`, and `PersonaAssignment`. Zero imports from `node:` or project modules. See `src/discuss/types.ts`.

---

### src/discuss/util/string.ts - String/ID Formatting Utilities

Pure string utilities with zero project imports. Exports: `randomSuffix` (4-char hex suffix for session IDs), `formatDateId` (compact `YYMMDD-HHMM` date string), `topicSlug` (topic → max-40-char URL-safe slug), `parseDisplayName` (strips numeric suffix for display). Used by `state-machine.ts` and `session-store.ts`. See `src/discuss/util/string.ts`.

---

### src/discuss/util/rng.ts - Seeded RNG and Sampling Primitives

Pure RNG utilities with zero project imports. Exports: `UINT32_SIZE` (2³²), `drawUInt32` (single Mulberry32 step), `createSeededRng` (returns `() => number` in [0,1)), `shuffleInPlace` (Fisher-Yates in-place shuffle), `weightedSample` (weighted random index selection). Used by `persona-seed.ts` and `util/dpp.ts`. See `src/discuss/util/rng.ts`.

---

### src/discuss/util/dpp.ts - k-DPP Linear Algebra

Pure k-Determinantal Point Process implementation. Exports: `MAX_POOL_SIZE` (100), `cartesianProduct`, `hammingDistance`, `buildKernel` (similarity matrix from ControversyAxis positions), `eigendecompose` (power-iteration QR), `sampleKDpp` (elementary symmetric polynomial sampling). Private helpers: matrix ops (`identityMatrix`, `dot`, `normSquared`, `getColumn`), ESP computation, Gram-Schmidt orthonormalization. Imports `weightedSample` from `./rng.ts`. See `src/discuss/util/dpp.ts`.

---

### src/discuss/lock.ts - File Locking and Atomic Writes

I/O primitives extracted from `session-store.ts`. Exports: `writeStateAtomic` (write `DiscussState` via `.tmp` + `renameSync`), `SessionLock` (class wrapping `mkdir`-based cross-process lock with PID liveness check and 30s stale-lock threshold). Private helpers: `tryRemoveSync`, `sleep`, `parseLockOwner`, `isProcessAlive`, `isStaleOwner`. See `src/discuss/lock.ts`.

---

### src/discuss/state-machine.ts - Pure State Transitions

All state-modifying logic. Zero I/O imports — `node:fs` and `node:path` are banned in this file. Every state-modifying function follows the signature pattern `(state, ...args, now: string) → Result<T>`.

Key functions: `initSession`, `applyBid`, `resolveWinner` (handles winner / fallback / cold_start / epoch_transition / max_epochs_reached / no_winner), `applySpeech` (sets monotonic `last_speech_step`), `applyEpochSummary`, `applyEnd`, `resolveAgentName` (strips numeric suffix for agent alias resolution).

Imports `parseDisplayName` from `util/string.ts`. See `src/discuss/state-machine.ts`.

---

### src/discuss/conditions.ts - Wait Condition Predicates

Pure boolean predicates used by `wait.ts` when polling `state.json`:
- `allBidsIn(state)` - all agents have submitted bids AND status is bidding
- `speechDelivered(state)` - `last_speech_step === step - 1` (monotonic marker)
- `bidReleased(state)` - winner has been resolved (bid hold lifted)
- `isWinner(agentName)(state)` - this agent is the current winner
- `setupComplete(state)` - session has transitioned out of setup
- `noEligibleParticipants(state)` - no eligible required agents remain

These predicates are called by `waitForCondition` in `wait.ts` at polling intervals. `_3_step` in `server-handlers.ts` uses `waitForCondition` directly for moderator blocking. Discussant agents use `discuss({ op: "bid", ... })` and `discuss({ op: "speak", ... })` which also resolve via internal polling. See `src/discuss/conditions.ts`.

---

### src/discuss/wait.ts - Async File Polling

Polls `state.json` at intervals until a predicate is true or timeout expires. Key design: immediate first check, `lastKnownGood` pattern (returns last valid state even on timeout so callers always get a valid state object), transient read failures silently retried. Default poll interval: 500ms. `INFINITE_POLL=0` timeout means poll forever (used by agent-facing operations). See `src/discuss/wait.ts`.

---

### src/discuss/session-store.ts - I/O Shell

Handles session directory management, atomic writes, cross-process locking, and transcript rendering.

- **Lock**: `SessionLock` (from `lock.ts`) — `mkdir`-based atomic test-and-set. Stale lock detection via PID liveness check + 30s age threshold
- **Atomic writes**: `writeStateAtomic` (from `lock.ts`) — `.tmp` + `renameSync`, same pattern as codex session-manager
- **Directory naming**: `{session_id}-{topic_slug}` — imports `randomSuffix`, `formatDateId`, `topicSlug` from `util/string.ts`
- **`save()`**: serializes state under lock, then calls `transcript.ts` for incremental markdown append

See `src/discuss/session-store.ts`.

---

### src/discuss/transcript.ts - Transcript Rendering

Pure functions on `TranscriptEntry[]`. Produces human-readable markdown with soft 80 / hard 100 word-wrap. Supports Korean/CJK sentence-ending patterns for grace-zone detection. Supports three modes: `recent` (last N entries), `full` (full transcript, bids visible), `summary` (epoch-level overview). Bid scores are filtered from agent-facing views. See `src/discuss/transcript.ts`.

---

### src/discuss/schemas.ts - Zod Input Validation

Zod schemas for the two discuss MCP tools. `discussAgentOpSchema` is a discriminated union on `op` covering `bid` and `speak`. `discussLeadOpSchema` covers `_1_seed` through `_8_synthesize`. Cross-field constraints are enforced in `server-handlers.ts` after Zod validation. See `src/discuss/schemas.ts`.

---

### src/discuss/persona-seed.ts - k-DPP Persona Sampling

Pure implementation of k-Determinantal Point Process sampling for maximally diverse persona position assignment. Zero I/O. Key exports: `seedPersonas` (main entry point), `assignTones` (2×2×2 combinatorial assignment), `assignOrigins` (weighted demographics). RNG and DPP primitives are delegated to `util/rng.ts` and `util/dpp.ts`. See `src/discuss/persona-seed.ts`.

---

### src/discuss/handlers/utils.ts - Cross-Handler Utilities

Shared utilities used by both `handlers/bid.ts` and `handlers/step.ts` (and indirectly `server-handlers.ts`). Exports: `resolveSession` (session ID → directory path), `nowIsoString`, `resultToMcp` (converts `Result<T>` to `McpResult`), `loadState` (locked state read), `endContent` (human-readable end reason strings). See `src/discuss/handlers/utils.ts`.

---

### src/discuss/handlers/bid.ts - bid/speak Flow

Contains the full `handleBid` and `handleSpeak` implementations, exposed via `handleAgentOp`. `handleBid` is a polling loop: waits for session to reach `bidding` state → applies bid under lock → waits for winner resolution via `bidReleased` predicate. Returns `speak` action to the winner, `listen` action to everyone else. See `src/discuss/handlers/bid.ts`.

---

### src/discuss/handlers/step.ts - _3_step Flow

Implements the `handle3Step` moderator operation with phase decomposition (`bootstrapFromSetup`, `stepSpeaking`, `stepBidding`). Manages the full bidding→speaking cycle: starts bidding on first call, waits for all bids via `waitForCondition(allBidsIn)`, resolves winner under lock, then in the next call waits for speech delivery via `waitForCondition(speechDelivered)`. Handles expulsion of non-responsive agents after two hold cycles. See `src/discuss/handlers/step.ts`.

---

### src/discuss/server-handlers.ts - Tool Dispatch

Thin router: Zod parsing (`parseToolInput`), environment config (`envInt`), and routing to `handleAgentOp` / `handle3Step` / inline op handlers. Per-op handlers `handle2Create` through `handle8Synthesize` live here for ops that don't warrant their own file. See `src/discuss/server-handlers.ts`.

---

### src/discuss/server.ts - MCP Server Entry Point

Composition root (~40 lines). SDK + stdio transport setup, `SessionStore` initialization, shutdown signal handling. No business logic - delegates entirely to `server-handlers.ts`. See `src/discuss/server.ts`.
