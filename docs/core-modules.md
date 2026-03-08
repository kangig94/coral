# Core Modules

Detailed description of the TypeScript modules across both MCP servers.

## Bridge Modules (`src/bridge/`)

### src/bridge/server.ts - MCP Stdio Proxy

MCP stdio server (composition root). Receives MCP tool calls from the Claude Code host, proxies them to the backend daemon via HTTP. Handles `wait` locally via SSE streaming from `POST /wait/stream`, forwarding progress events as MCP progress notifications. Intercepts the bridge-local `backend` tool for daemon status and graceful shutdown without auto-starting the backend. `ListTools` still discovers remote tools from `GET /tools`, then appends the static `backend` descriptor so it remains visible even when remote discovery fails. See `src/bridge/server.ts`.

---

### src/bridge/backend-client.ts - Backend HTTP Client

HTTP client for the persistent backend daemon. Key exports:
- `ensureBackend()` — read `backend.json`, healthcheck, spawn if not running or version-mismatched, poll until ready. Handles replacement of outdated daemons (shutdown old, acquire replacement lock, spawn new, wait for ready).
- `getBackendStatus()` — read `backend.json`, confirm PID liveness, then query `GET /health` without auto-starting the backend. Returns full health payload or `shutting_down` during drain.
- `shutdownBackend()` — read `backend.json`, confirm PID liveness, then call `POST /admin/shutdown` without auto-starting the backend. Returns idempotent drain-aware status.
- `proxyToolCall(name, args, ctx)` — `POST /tool` with JSON body and auth token
- `streamWait(jobIds, timeoutSeconds, backendInfo, lastEventId?)` — async generator yielding `WaitStreamEvent` from SSE response. Includes SSE block parsing (`parseSseBlock`) and typed event validation (`parseWaitStreamEvent`).

Named constants: `STARTUP_POLL_MS`, `STARTUP_TIMEOUT_MS`, `HEALTH_TIMEOUT_MS`, `REPLACEMENT_TIMEOUT_MS`, `TOOL_TIMEOUT_MS`.

See `src/bridge/backend-client.ts`.

---

### src/bridge/backend-tool.ts - Bridge-Local Backend Tool

Static descriptor and handler for the `backend` MCP tool. Defines the `op` Zod schema, formats MCP responses with `textResult()`, delegates `status` to `getBackendStatus()`, delegates `shutdown` to `shutdownBackend()`, and appends the local descriptor to discovered remote tools via `buildToolList()`. See `src/bridge/backend-tool.ts`.

---

## Execution Modules (`src/execution/`)

### src/execution/server.ts - Backend HTTP Daemon

`createBackendServer(options)`: persistent HTTP daemon. Singleton lock via `backend-lock.ts`, idle timer via `idle-timer.ts`, HTTP routing (`GET /health`, `GET /tools`, `POST /tool`, `POST /wait/stream`, `POST /admin/shutdown`). Creates per-project `ExecutionService` instances and routes tool calls through `routeToolCall`. Manages lifecycle states (`starting` → `running` → `draining` → `stopped`). Recovers orphaned jobs on startup. Exports `BackendServerController` with `start()`, `shutdown(reason)`, `waitForShutdown()`, `getLifecycle()`. See `src/execution/server.ts`.

---

### src/execution/service.ts - Core Business Logic

`ExecutionService`: central orchestrator. Owns `SessionManager`, `JobManager`, and `ProgressStore` instances. Methods:
- `start(providerName, input, ctx)` — provider preflight, session allocation, job allocation, async CLI spawn
- `resume(providerName, input, ctx)` — session lookup, busy/non-resumable guards, async CLI spawn
- `fork(providerName, input, ctx)` — source session lookup, new session allocation, async CLI spawn
- `coralDispatch(providerName, coralName, input, ctx)` — resolve coral content, strip metadata, build instruction, delegate to `start`/`resume`
- `executeWorkflow(providerName, ast, input, ctx)` — allocate workflow job, delegate to `executePipeline`
- `list(providerName)` — provider-filtered session list
- `abort(jobIds)` — delegate to `JobManager.abort()`
- `awaitLaunch(jobId, timeoutMs)` — poll until launch state is non-pending
- `waitStream(req)` — async generator yielding progress/terminal/timeout events for monitored jobs

See `src/execution/service.ts`.

---

### src/execution/backend-lock.ts - Singleton Lock

Singleton lock using `~/.claude/coral/backend.lock`. Healthcheck-based stale detection: if the lock holder's PID is alive and responds to healthcheck, throws `BackendAlreadyRunningError`; if PID is dead or deadline expires, removes stale lock and retries. Key exports: `acquireLock(instanceId, version)`, `BackendAlreadyRunningError`, `removeLockIfOwner(instanceId)`. See `src/execution/backend-lock.ts`.

---

### src/execution/backend-info.ts - Connection Info

Connection info at `~/.claude/coral/backend.json`. Stores `{ pid, port, token, version, instanceId, startedAt }`. Key exports: `writeBackendInfo(info)` (atomic `.tmp` + rename), `readBackendInfo()` (returns null on missing/corrupt), `removeBackendInfoIfOwner(instanceId)`. See `src/execution/backend-info.ts`.

---

### src/execution/idle-timer.ts - Auto-Shutdown Timer

`IdleTimer`: auto-shutdown when no requests for `CORAL_BACKEND_IDLE_MS` (default 6 hours). Tracks inflight request count via `beginRequest()`/`endRequest()`. `startWatching(checkIdle, onIdle)` polls at 1-second intervals; fires `onIdle` callback when idle timeout expires and `checkIdle()` confirms no active children or live jobs. See `src/execution/idle-timer.ts`.

---

### src/execution/job-manager.ts - In-Memory Job Registry

`JobManager`: in-memory `Map<string, JobEntry>` of active jobs. Each `JobEntry` has `AbortController` for cancellation. Key methods: `allocate(sessionId, provider)` (returns new jobId), `setPhase(jobId, phase)`, `setLaunchState(jobId, state, message?)`, `getSignal(jobId)`, `get(jobId)`, `isActive(jobId)`, `abort(jobIds)` (returns `AbortResult { aborted, notFound }`), `remove(jobId)`. See `src/execution/job-manager.ts`.

---

### src/execution/progress-store.ts - File-Based Event Storage

`ProgressStore`: file-based event storage under `/tmp/coral-jobs/<jobId>/`. Per-job directory contains `status.json` (atomic writes) and `progress.jsonl` (append-only). Key methods: `initJob(jobId, sessionId, provider)`, `appendProgress(jobId, sessionId, message)`, `appendTerminal(jobId, sessionId, result, phase)`, `writeResultMd(jobId, text)`, `readStatus(jobId)`, `updateLaunchState(jobId, state, message?)`, `updatePhase(jobId, phase)`, `replayFrom(jobId, fromEventId, cursor)` with cursor-based incremental reads via low-level `readSync`. See `src/execution/progress-store.ts`.

---

### src/execution/session-manager.ts - Persisted Session Registry

`SessionManager`: persisted session registry under `~/.claude/coral/execution/sessions/<project-hash>/`. Provider-aware methods: `allocate(provider, name, model, cwd)`, `get(provider, sessionId)`, `list(provider)`, `setConversationRef(sessionId, ref)`, `setNonResumable(sessionId)`, `claimForJob(sessionId, jobId)` (single-active-job invariant), `releaseJob(sessionId, jobId)`. Atomic writes (`.tmp` + rename). Includes migration from old runner session format. See `src/execution/session-manager.ts`.

---

### src/execution/engine.ts - CLI Spawn Engine

Owns process lifecycle and backpressure:
- `spawnCli(options)` for Codex/Claude subprocesses with idle timeout, bounded output buffering (`MAX_BUFFER` 10MB), and line-based event callback
- graceful kill (`SIGTERM` then `SIGKILL` after 5s grace)
- launch cap: `MAX_ACTIVE_SESSIONS` (global, default 10 via `CORAL_MAX_SESSIONS`). Excess launches enter a FIFO job queue (`MAX_QUEUE_SIZE` 20) and auto-dispatch when capacity frees
- `killAllChildren()` for shutdown
- `activeChildren` set for tracking live child processes

See `src/execution/engine.ts`.

---

### src/execution/instruction.ts - Coral Instruction Builder

`buildCoralInstruction(strippedAgentContent)`: constructs a `ProviderInstruction` from stripped agent markdown content with `channel: 'system'`. See `src/execution/instruction.ts`.

---

### src/execution/request-context.ts - Request Type Definitions

Type definitions for backend request routing: `CallerContext { projectRoot, pluginRoot }` and `ToolRequest { name, args, context }`. See `src/execution/request-context.ts`.

---

## Coral Modules (`src/coral/`)

### src/coral/resolver.ts - Agent/Skill Resolver

Resolves `coral:<name>` content from plugin root with containment checks:
- first `agents/<name>.md`
- then `skills/<name>/SKILL.md`
- path traversal rejection
- `stripAgentMetadata(...)` helper used by `ExecutionService.coralDispatch()` before provider delegation

See `src/coral/resolver.ts`.

---

## Workflow Modules (`src/workflow/`)

Deterministic multi-agent pipeline executor. Dependency-injected: `src/workflow/` imports from `src/execution/` and `src/shared/` but never from `src/bridge/` (the `ExecutionService` is passed directly by the backend server).

### src/workflow/types.ts - Pipeline AST

Defines the pipeline data model:
- `PipeAtom` — discriminated union:
  - `AgentAtom` (`{ kind: 'agent', namespace?, agent, provider? }`)
  - `PromptAtom` (`{ kind: 'prompt', text, provider? }`)
- `PipeStep` — array of atoms (parallel when >1)
- `PipelineAST` — array of steps (sequential execution order)

See `src/workflow/types.ts`.

---

### src/workflow/pipe-parser.ts - DSL Parser

Parses expression strings into `PipelineAST`. Key functions: `parseExpression` (entry point), `splitSteps` (depth-aware and quote-aware `->` splitting), `parseAtom` (agent refs plus quoted prompt literals), `parseParallelStep` (quote-aware comma splitting for mixed agent/prompt parallel groups).

Validates: agent name format, provider identifier syntax, namespace syntax, balanced parentheses, no nested groups, prompt literal syntax, unclosed quotes, and empty literals. Parser no longer enforces parallel duplicate identity; that is handled post-normalization in `handler.ts`. See `src/workflow/pipe-parser.ts`.

---

### src/workflow/schemas.ts - Input Validation

Zod schema (`workflowInputSchema`) with strict top-level input and strict per-atom `atoms` config (`effort`, `instruction`). Unknown keys (including legacy `args` and atom-level `bypass`) are rejected at schema level. Defaults:
- `provider: "claude"`
- `stale_timeout_seconds: 900` (`0` disables stale recovery)

See `src/workflow/schemas.ts`.

---

### src/workflow/pipe-executor.ts - Pipeline Executor

Orchestrates the sequential step loop with concurrent parallel atom launches. Imports `ExecutionService` from `execution/service.ts` (via `WorkflowExecutionService` type pick). Key exports:
- `executePipeline(ast, init_prompt, provider, executionSvc, ctx, options)` — main loop
- `launchAtomWithRetry(context)` — busy retry with exponential backoff (3 attempts), uses `executionSvc.coralDispatch()` and `executionSvc.awaitLaunch()`
- `waitForAtoms(atoms, executionSvc, ctx, options)` — all-semantics wait with:
  - atom progress forwarding (`atom <agent>: <message>`) via `executionSvc.waitStream()`
  - optional stale recovery (`staleTimeoutMs`) with abort+resume per stale atom
  - sibling abort + drain timeout behavior on non-recovery failures
  - return value: `Map<string, string>` (agent name → result text)
- `formatStepOutput(results)` — single pass-through or XML wrapping

Named constants: `BUSY_PREFIX`, `MAX_LAUNCH_ATTEMPTS`, `BOOTSTRAP_POLL_INTERVAL_MS`, `BOOTSTRAP_TIMEOUT_MS`, `SIBLING_DRAIN_TIMEOUT_MS`.

See `src/workflow/pipe-executor.ts`.

---

### src/workflow/handler.ts - Workflow Handler

Entry point called by the backend server's tool router. Parses expression, normalizes atoms with resolved defaults (`namespace`/`provider`), validates atoms keys, namespaces, and parallel duplicate identity (`namespace:agent@provider`), then delegates to `ExecutionService.executeWorkflow()`. Receives `ExecutionService` and `CallerContext` from `execution/service.ts` via dependency injection.

See `src/workflow/handler.ts`.

---

## Provider Modules (`src/providers/`)

### src/providers/types.ts / registry.ts / bootstrap.ts

Provider contract and authority boundary:
- `Provider` interface (`name`, `capabilities`, `execute(request, runtime)`, optional `preflight()`)
- `ProviderRuntime` (signal + onEvent callback injected by `ExecutionService`)
- `ProviderCapabilities` (`resumable`, `forkable`)
- registry APIs (`registerNewProvider`, `getNewProvider`, `getAllNewProviders`)
- built-in bootstrap (`registerBuiltInProviders`) registers codex + claude adapters

---

## Codex Adapter Modules (`src/providers/codex/`)

The Codex adapter implements `Provider` interface. Shared launch/wait/session infrastructure lives in `src/execution/`.

### src/providers/codex/adapter.ts

Codex `Provider` implementation. `preflight()` probes CLI availability and auth via `cli-detection.ts`. `execute(request, runtime)` dispatches to `executeOneShot`, `executeResume`, or `executeFork` from `codex-executor.ts`, mapping `ProviderResult` fields. Builds prompt by prepending instruction/systemPrompt (both channels map to prompt prepend — Codex has no system prompt flag). See `src/providers/codex/adapter.ts`.

### src/providers/codex/codex-executor.ts

Codex-specific execution wrapper over `execution/engine.ts`:
- builds Codex CLI args (`exec`, `resume`, `fork`)
- parses JSONL events through `output-parser.ts`
- prepends plugin `CLAUDE.md` for one-shot sessions

### src/providers/codex/schemas.ts / cli-detection.ts / output-parser.ts / progress.ts / command-patterns.ts / types.ts

Input validation, CLI/auth probing, JSONL parsing, progress message extraction, CLI arg patterns, and Codex-specific types (`CodexExecResult`, `CodexThreadEvent`).

---

## Claude CLI Adapter Modules (`src/providers/claude/`)

### src/providers/claude/adapter.ts

Claude `Provider` implementation. `preflight()` probes CLI availability and auth via `cli-detection.ts`. `execute(request, runtime)` dispatches to `executeClaudeOneShot`, `executeClaudeResume`, or `executeClaudeFork` from `claude-executor.ts`. Instruction channel routing: `system` channel maps to `--append-system-prompt`, `prompt` channel prepends to prompt text. See `src/providers/claude/adapter.ts`.

### src/providers/claude/cli-detection.ts

Claude CLI availability/auth probe with cache + in-flight deduplication:
- binary detection via `claude --version`
- auth fast path via `ANTHROPIC_API_KEY`
- canonical auth probe via `claude auth status --json`

### src/providers/claude/claude-executor.ts

Claude execution wrapper over `execution/engine.ts`:
- prompt transport via stdin (`-p` mode)
- JSON output parsing (`--output-format json`)
- resume support via `--resume`
- structured parse-failure surface (`ClaudeExecParseError`)

### src/providers/claude/schemas.ts / output-parser.ts / progress.ts / types.ts

Input validation, JSON output parsing, progress message extraction, and Claude-specific types (`ClaudeExecResult`, `ClaudeJsonOutput`, `ClaudeStreamEvent`).

---

### src/types.ts - Shared Type Definitions

Central type hub for the execution service contract. Re-exports provider-specific types from `providers/codex/types.ts` and `providers/claude/types.ts`. Defines:
- Identity types: `JobId`, `SessionId`, `SessionState`, `JobPhase`, `LaunchState`
- Provider contract types: `ProviderProgressEvent`, `ProviderAction`, `ProviderInstruction`, `ProviderRequest`, `ProviderResult`
- Execution types: `LaunchDecision`, `TerminalResult`, `WaitCursor`, `WaitRequest`, `WaitStreamEvent`
- Persistence types: `PersistedStatusRecord`, `PersistedProgressRecord`

See `src/types.ts`.

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
