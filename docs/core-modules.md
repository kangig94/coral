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
- `getBackendStatusFull()` — same as `getBackendStatus()` but returns a 4-state discriminated union: `ok` (with full health), `shutting_down`, `unauthorized`, or `not_running`. Used by the CLI `backend status` subcommand.
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

`createBackendServer(options)`: persistent HTTP daemon. Owns singleton locking, idle shutdown, HTTP routing (`GET /health`, `GET /tools`, `POST /tool`, `POST /wait/stream`, `POST /admin/shutdown`), cross-shard session discovery via `SessionIndex`, and per-project discuss contexts. `routeToolCall(...)` is the main backend dispatcher; discuss tool routes call into `discuss-operations.ts`, and KB routes call the `src/kb/` operations through the runtime subsystem. Manages lifecycle states (`starting` → `running` → `draining` → `stopped`) and recovers orphaned jobs on startup. See `src/execution/server.ts`.

---

### src/execution/service.ts - Core Business Logic

`ExecutionService`: provider-launch orchestration and wait/abort coordination. Owns `SessionManager`, `AbortRegistry`, and `ProgressStore`, and mediates launch admission with the engine queue. Methods:
- `start(providerName, input, ctx)` — provider preflight, session allocation, job allocation, async CLI spawn
- `resume(providerName, input, ctx)` — session lookup, busy/non-resumable guards, async CLI spawn
- `fork(providerName, input, ctx)` — source session lookup, new session allocation, async CLI spawn
- `coralDispatch(providerName, coralName, input, ctx)` — resolve coral content, strip metadata, build instruction, delegate to `start`/`resume`
- `executeWorkflow(providerName, ast, input, ctx)` — allocate workflow job, delegate to `executePipeline`
- `list(providerName)` — provider-filtered session list
- `abort(jobIds)` — delegate to `AbortRegistry.abort()`
- `awaitLaunch(jobId, timeoutMs)` — poll until launch state is non-pending
- `waitStream(req)` / `waitStreamOnce(jobId, timeoutMs?)` — replay progress and terminal events from `ProgressStore`

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

### src/execution/abort-registry.ts - In-Memory Abort Handles

`AbortRegistry`: job-id to `AbortController` map used by `ExecutionService` for cancellation. `register(jobId?)` allocates or reuses a job ID, `getSignal(jobId)` exposes the controller signal to providers, `abort(jobIds)` returns `{ aborted, notFound }`, and `remove(jobId)` drops completed jobs after terminal persistence. See `src/execution/abort-registry.ts`.

---

### src/execution/progress-store.ts - File-Based Event Storage

`ProgressStore`: file-based event storage under `/tmp/coral-jobs/<jobId>/`. Per-job directory contains `status.json` (atomic writes) and `progress.jsonl` (append-only). Key methods: `initJob(jobId, sessionId, provider)`, `appendProgress(jobId, sessionId, message)`, `appendTerminal(jobId, sessionId, result, phase)`, `writeResultMd(jobId, text)`, `readStatus(jobId)`, `updateLaunchState(jobId, state, message?)`, `updatePhase(jobId, phase)`, `replayFrom(jobId, fromEventId, cursor)` with cursor-based incremental reads via low-level `readSync`. See `src/execution/progress-store.ts`.

---

### src/execution/session-manager.ts - Persisted Session Registry

`SessionManager`: persisted session registry under `~/.claude/coral/sessions/<project-hash>/`. Provider-aware methods: `allocate(provider, name, model, cwd)`, `get(provider, sessionId)`, `list(provider)`, `setConversationRef(sessionId, ref)`, `setNonResumable(sessionId)`, `claimForJobSync(sessionId, jobId)` / `claimForJobAtomic(sessionId, jobId)` (single-active-job invariant), `releaseJob(sessionId, jobId)`. Atomic writes (`.tmp` + rename). Includes migration from old runner session format. See `src/execution/session-manager.ts`.

---

### src/execution/session-index.ts - Cross-Shard Session Discovery

`SessionIndex`: backend-owned read model for session discovery across all session shards. Hydrates lenient session JSON from `~/.claude/coral/sessions/*`, tracks known shard directories, marks session entries stale on `session:updated` events, and rereads only touched records. `listForNamespace(namespace, progressStore)` filters active jobs by backend namespace using `ProgressStore`; `listAll()` returns the full cached index. See `src/execution/session-index.ts`.

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

### src/execution/discuss-session-store.ts - Event-Sourced Discuss Persistence

Persistent store for discuss sessions. Owns compare-and-append writes to `event-log.jsonl`, snapshot materialization to `state.json`, source-scoped discovery and summary-index repair under `~/.coral/projects/{slug}/discuss/`, and shared source-registry updates at `~/.coral/discuss-sources.json`. Key methods: `load(sessionId)`, `append(sessionId, expectedSeq, events)`, `listSummaries()`, `listRecoveryCandidates()`, and `resolveSessionDir(sessionId)`. It is the write-order authority for discuss durability and persisted discovery surfaces. See `src/execution/discuss-session-store.ts`.

---

### src/execution/discuss-operations.ts - Discuss Runtime Entry Point

Primary execution-layer entry point for discuss runtime operations, imported by `server.ts`. Handles `startDiscussSession`, manual bid/speech submission, abort, `getWatchState`, and persisted-session recovery. Composes the sibling discuss modules rather than exposing a single manager class. See `src/execution/discuss-operations.ts`.

---

### src/execution/discuss-loop.ts - Control-Phase Loop

`resumeLoop(ctx, sessionId, callerCtx)` and `continueLoop(...)` drive live discuss sessions through control phases such as `observer_wait`, `collect_follow_up`, `evaluate_epoch`, and `synthesize`. The loop decides whether to collect bids, collect speech, run follow-up turns, evaluate epochs, or stop, and force-ends the session on uncaught runtime failures. See `src/execution/discuss-loop.ts`.

---

### src/execution/discuss-subflows.ts - Bid/Speech/Subflow Workers

The concrete async subflows used by the loop: `collectBids`, `collectSpeech`, `evaluateEpoch`, `handleEpochTransition`, `runFollowUpTurns`, and `handleSynthesis`. This file builds prompts, validates model output, applies retry rules, and commits follow-up runtime events back through the persistence helpers. See `src/execution/discuss-subflows.ts`.

---

### src/execution/discuss-persistence.ts - Commit And Watch Helpers

Compare-and-append helpers for the live runtime. `commitDecision(...)` applies state-machine decisions through `DiscussSessionStore.append()`, retries on stale writes, updates attached live snapshots, and fans derived watch events to subscribers. `appendRuntimeEvents(...)` appends bookkeeping events, and `buildPersistedWatchState(...)` reconstructs watch history from the persisted event log when a session is not attached live. See `src/execution/discuss-persistence.ts`.

---

### src/execution/discuss-registry.ts - Live Session Attachment Registry

In-memory registry of attached live discuss sessions. `attachSession(...)` and `detachSession(...)` manage the runtime session map, `subscribe(...)` manages live watch subscribers, and `getWatchState(...)` serves either the live watch buffer or a persisted rebuild fallback when the requested cursor predates the retained live buffer. See `src/execution/discuss-registry.ts`.

---

### src/execution/discuss-executor.ts - Provider Turn Execution

Execution helpers for individual discuss turns. Builds per-agent execution config, distinguishes manual observers from provider-backed agents, computes retryable attempt numbers, launches provider turns through `ExecutionService`, records `agent.job.*` runtime events, and exposes constants for bid/speech/follow-up/synthesis purposes and shared turn instructions. See `src/execution/discuss-executor.ts`.

---

### src/execution/discuss-context.ts - Runtime Types And Live Buffers

Defines the execution-layer discuss context: `AgentConfig`, `DiscussConfig`, `WatchEvent`, `WatchState`, `LiveDiscussSession`, and the `DiscussContext` container (`projectRoot`, `sessions`, `service`, `store`). Also owns live watch-buffer helpers such as `createWatchBuffer(...)`, cursor tracking, and buffer compaction. See `src/execution/discuss-context.ts`.

---

### src/execution/discuss-context-registry.ts - Per-Project Discuss Contexts

Registry for per-project `DiscussContext` instances. `createDiscussContextRegistry()` creates the global container, `getOrCreate(...)` binds a project root to its `ExecutionService` and `DiscussSessionStore`, and `listAttachedSessions(...)` / `hasRunningSessions(...)` let `server.ts` inspect global live-discuss state during shutdown and recovery. See `src/execution/discuss-context-registry.ts`.

---

### src/execution/discuss-prompts.ts - Discuss Prompt Builders

Prompt-construction helpers for the runtime. `buildBidPrompt(...)`, `buildSpeechPrompt(...)`, and `buildFirstTurnInstruction(...)` compose persona, participant summary, prior speech, and must-answer context into the strict response contracts expected by the discuss subflows. See `src/execution/discuss-prompts.ts`.

---

## CLI Modules (`src/cli/`)

### src/cli/main.ts - CLI Entry Point

Commander-based parallel client for all Coral MCP tools. Bundled as `bridge/coral-cli.cjs` (third esbuild entry point). Direct invocation: `node bridge/coral-cli.cjs ...`; bare `coral-cli ...` is resolved by the `hooks/cli-resolve.mjs` PreToolUse hook.

**Subcommands**: `codex exec|fork|list|coral:<agent>`, `claude exec|fork|list|coral:<agent>`, `wait`, `abort`, `workflow`, `backend status|shutdown`, `discuss seed|start|watch|participate|abort`.

**Response normalizer** — `normalizeResult(result)` handles three payload shapes from `/tool` responses: `McpResult` envelopes (unwraps `content[0].text`, parses JSON), `{ status: 'rejected' }` launches (stderr + exit 1), and plain JSON success (stdout + exit 0). `BackendToolHttpError` carries HTTP status code and parsed JSON body for structured error output.

**Wait output** — calls `streamWait()` from `src/bridge/backend-client.ts`, writes NDJSON records `{"cursor":"..."|null,"event":{...}}`. `shapeWaitOutputRecord()` applies the path-first terminal shape (`result.path` always present, `result.content` embedded only when the final NDJSON record fits the inline budget).

**Provider `coral:<agent>` normalization** — `normalizeProviderArgv()` rewrites `process.argv` before Commander parses it, converting `codex coral:architect` → `codex coral architect` for clean subcommand routing.

**Backend subcommands** — use `getBackendStatusFull()` and `shutdownBackend()` from `src/bridge/backend-client.ts`; never call `ensureBackend()`, so the daemon is not auto-started as a side effect. `backend status` always exits 0 for all four states (`ok`, `shutting_down`, `unauthorized`, `not_running`).

See `src/cli/main.ts`.

---

## KB Modules (`src/kb/`)

### src/kb/runtime.ts - KbRuntime Factory

`createKbRuntime({ markdownRoot, runtimeDir })` constructs the shared KB runtime. It owns the cached text index (`index.json`), freshness state (`index-state.json`), cached Orama snapshot (`orama-index.json`), the serialized mutation lock (`withMutationLock()`), and the rebuild/freshness pipeline behind `ensureIndex()` and `ensureOramaIndex()`. It also initializes the optional LanceDB adapter when available. See `src/kb/runtime.ts`.

---

### src/kb/paths.ts - KB Path Resolution

Path helpers and containment checks for KB files. `notesDir()`, `principlesDir()`, `kbRuntimeDir()`, `memoDir(projectRoot)`, `memoPathFromContext(projectRoot, memo)`, `notePathFromName(note)`, `notePathFromParts(domain, topic)`, and `principlePathFromName(principle)` all route through `assertWithin(...)` so note, principle, and memo paths stay under the configured KB roots. See `src/kb/paths.ts`.

---

### src/kb/validation.ts - Slug Patterns and Assertions

Canonical slug patterns: `LOWERCASE_SLUG_PATTERN` (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`) for domain and memo topics, `NOTE_SLUG_PATTERN` (`/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/`) for note names that embed code identifiers (e.g. `rendering-efficiency-CuMem`). Exports `assertSlug` (lowercase), `assertNoteSlug` (mixed-case), `assertNonEmptyText`, `compareLocale`. See `src/kb/validation.ts`.

---

### src/kb/mutation-helpers.ts - Shared Mutation Utilities

`buildNoteIndexEntry(meta)` — deep-copies a note index record from any source carrying frontmatter fields. `commitIndexUpdate(rt, updater, reason)` — clone index, apply mutable updater, write back, mark text stale (used by promote/update/delete; `@precondition` caller holds `withMutationLock`). `writeFileAtomic(path, payload)` — write to `.tmp` then rename, with `ensuredDirs` cache and ENOENT retry. `cloneKbIndex`, `markTextIndexStale`. See `src/kb/mutation-helpers.ts`.

---

### src/kb/read.ts - KB Note And Memo Reader

`loadKbNote(notePath)` reads a note and parses frontmatter, title, and body. `readEntry({ note }, projectRoot?)` serves both promoted notes and project-local memos: memo-like note names (`YYYYMMDD-HHMMSS-topic`) resolve to `projectDataDir(projectRoot)/memo/<name>.md` when present, otherwise the call reads the canonical note under `notes/`. See `src/kb/read.ts`.

---

### src/kb/search.ts - KB Search

`searchKb(rt, query, top_k)` — Orama full-text search with BM25 ranking, field boosting (`slug:3, title:2, tags:1.5, principles:1.5, body:1`). `toResult()` uses snippet-as-signal for body match detection: `extractSnippet` attempts anchor-based body search; if snippet found → content matched; if no snippet and no other surface matched → content (Orama fallback). `findTokenAnchor` uses the inverse of Orama's English SPLITTER regex to maintain tokenizer contract alignment. See `src/kb/search.ts`.

---

### src/kb/frontmatter.ts - Frontmatter Parsing

YAML frontmatter parse/serialize for KB notes. `parseFrontmatter(content)` → `KbNoteFrontmatter`, `serializeFrontmatter(meta)` → YAML block, `replaceFrontmatter(content, meta)` for in-place update. `deriveNoteIdentity(pathOrName)` splits `domain-topic` from a note slug. `extractBody`, `extractTitle`, `extractPrincipleStatement` for content extraction. See `src/kb/frontmatter.ts`.

---

### src/kb/promote.ts - Memo Promotion

`promote(rt, projectRoot, input, onSchedule?)` turns a project memo into a canonical note. It validates slugs, reads memo frontmatter for the source list, writes the new note atomically, records `mutationSeqAtPromote`, updates the in-memory index via `commitIndexUpdate(...)`, deletes the source memo, and optionally notifies the curate scheduler. See `src/kb/promote.ts`.

---

### src/kb/update.ts - Note Mutation

`update(rt, input)` rewrites a note's title and/or body in place while preserving existing frontmatter fields except `updatedAt`, which it refreshes. The operation runs under `withMutationLock()`, writes atomically, records a committed mutation, and updates the cached index entry. See `src/kb/update.ts`.

---

### src/kb/delete.ts - Note Deletion

`deleteFn(rt, input)` removes a canonical note, converts missing files into a `KB note not found` error, records a committed mutation, and removes the note from the cached index via `commitIndexUpdate(...)`. See `src/kb/delete.ts`.

---

### src/kb/text-artifacts.ts - Text Index Rebuild

Loads markdown notes and principles from disk, constructs `KbReindexNoteRecord[]`, rebuilds the canonical `KbIndex`, inserts note documents into Orama, persists the text artifacts to disk, and installs the rebuilt caches. `rebuildTextArtifacts(kb, startSeq)` is the authoritative text-mode reindex step, and `TextSnapshotRebuildError` carries partial counts when a rebuild loses freshness or snapshot persistence fails. See `src/kb/text-artifacts.ts`.

---

### src/kb/orama-factory.ts - Orama Schema And Tokenization

Defines the Orama document schema for KB text search and the normalization rules that keep query and field tokenization aligned. Exports `normalizeHyphens(...)`, `normalizeOramaTerm(...)`, `tokenizeQuery(...)`, `tokenizeField(...)`, `toOramaDocument(note)`, and `createOramaDb()`. See `src/kb/orama-factory.ts`.

---

### src/kb/reindex-enhanced.ts - LanceDB Table Rebuild

`rebuildEnhancedIndex(kb, notes)` refreshes the optional LanceDB tables used for enhanced KB search. It drops and recreates `notes`, `tags`, and `principles` tables from the already-loaded `KbReindexNoteRecord[]` and writes normalized lowercase columns alongside the original text for filtering and joins. See `src/kb/reindex-enhanced.ts`.

---

### src/kb/reindex.ts - Reindex Orchestrator

`reindex(kb)` runs the full KB rebuild under the mutation lock. It rebuilds the text artifacts first, then tries to rebuild the optional LanceDB tables. Text-mode rebuild failures surface as `TextSnapshotRebuildError` with counts; LanceDB failures degrade to a warning while text search remains available. See `src/kb/reindex.ts`.

---

### src/kb/curate.ts - Automated Curation Scheduler

Background scheduler that classifies KB notes with tags and principles via `claude -p --no-session-persistence`. `createCurateScheduler({ kb, spawnCli })` returns a `CurateHandle` with `start()`, `schedule()`, `isRunning()`. Claims up to 100 notes per run, classifies in one batch, then runs principle discovery once over the full eligible corpus. Manages git sync cycle: `gitSync()` at start (fetch + rebase, stash for new notes, `-X theirs` on conflict), `gitPush()` after completion. `.gitignore` auto-managed for `curate-state.json`, `data/`, `.obsidian/`. See `src/kb/curate.ts`.

---

### src/kb/curate-state.ts - Curate State Machine

Cursor-based tracking for curate progress: `CurateState` with `processedThrough`, `lastRunDay`, retry cooldown, pending discoveries, and migration version. Pure `apply*` functions for state transitions (failure recording, retry clearing, discovery tracking). `migrateCurateStateIfNeeded(kb)` assigns `mutationSeqAtPromote` to pre-existing notes. See `src/kb/curate-state.ts`.

---

### src/kb/curate-tags.ts - Tag Cleanup

`cleanupTags(index, cohortNotes)` — identifies singular/plural duplicates, low-support pattern-suffix tags, and over-specific multi-segment tags for removal. `countTagSupport(index)` counts per-tag note references. Used by the curate scheduler after classification. See `src/kb/curate-tags.ts`.

---

### src/kb/memo.ts - Project Memo Writer

`writeMemo(projectRoot, input)` creates a timestamped memo under the project's runtime data directory, writes memo frontmatter with the resolved project source, and uses the same atomic write helper as the canonical note mutations. See `src/kb/memo.ts`.

---

### src/kb/lancedb-runtime.ts - Optional LanceDB Loader

Dynamic runtime loader for `@lancedb/lancedb`. `loadKbLanceDb(specifier, runtimeDir?)` resolves the module's `connect` function, lazily opens `data/kb/kb.lance`, and returns the adapter shape consumed by `KbRuntime` (`getDb()`, `ensureTables()`). See `src/kb/lancedb-runtime.ts`.

---

### src/kb/types.ts - KB Type Definitions

Core types: `KbNoteFrontmatter` (tags, principles, source, dates, optional mutationSeqAtPromote), `KbNoteIndexRecord = KbNoteFrontmatter & { title }`, `KbIndex` (notes + principles), `KbReindexNoteRecord = KbNoteFrontmatter & { note, path, domain, title, body }`, `KbSearchResponse`, `KbResult`, `KbLanceDbAdapter`. See `src/kb/types.ts`.

---

## Client Modules (`src/client/`)

### src/client/discuss.ts - Discuss DTO Builders

Stable discuss read surface for backend APIs and external consumers such as coral-reef. Defines summary/detail DTOs, the `control` vs `audit` transcript types, and the builders `buildDiscussSummary(snapshot, authority)` and `buildDiscussDetail(snapshot, view, authority)`. Delegates redaction and transcript cloning to `discuss/projections.ts`. See `src/client/discuss.ts`.

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

### src/providers/cli-detection.ts - Shared CLI Detection

Shared CLI detection and auth probing for both built-in providers. `createCliDetector(...)` caches version probes, keeps confirmed authenticated results sticky, rechecks uncertain auth states, and exports `detectCodexCli()` / `detectClaudeCli()` plus cache-reset helpers. Codex probing uses `codex --version` and `codex whoami`; Claude probing uses `claude --version` and `claude auth status --json`, with env-var fast paths for `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. See `src/providers/cli-detection.ts`.

---

## Codex Adapter Modules (`src/providers/codex/`)

The Codex adapter implements `Provider` interface. Shared launch/wait/session infrastructure lives in `src/execution/`.

### src/providers/codex/adapter.ts

Codex `Provider` implementation. `preflight()` probes CLI availability and auth via shared `src/providers/cli-detection.ts`. `execute(request, runtime)` dispatches to `executeOneShot`, `executeResume`, or `executeFork` from `codex-executor.ts`, mapping `ProviderResult` fields. Builds prompt by prepending instruction/systemPrompt (both channels map to prompt prepend because Codex has no system-prompt flag). See `src/providers/codex/adapter.ts`.

### src/providers/codex/codex-executor.ts

Codex-specific execution wrapper over `execution/engine.ts`:
- builds Codex CLI args (`exec`, `resume`, `fork`)
- parses JSONL events through `output-parser.ts`
- prepends plugin `INJECT.md` for one-shot sessions

### src/providers/codex/schemas.ts / output-parser.ts / progress.ts / command-patterns.ts / types.ts

Input validation, JSONL parsing, progress message extraction, CLI arg patterns, and Codex-specific types (`CodexExecResult`, `CodexThreadEvent`).

---

## Claude CLI Adapter Modules (`src/providers/claude/`)

### src/providers/claude/adapter.ts

Claude `Provider` implementation. `preflight()` probes CLI availability and auth via shared `src/providers/cli-detection.ts`. `execute(request, runtime)` dispatches to `executeClaudeOneShot`, `executeClaudeResume`, or `executeClaudeFork` from `claude-executor.ts`. Instruction channel routing: `system` channel maps to `--append-system-prompt`, `prompt` channel prepends to prompt text. See `src/providers/claude/adapter.ts`.

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

## Discuss Modules (`src/discuss/`)

The current discuss implementation is split across pure domain modules in `src/discuss/`, persistence/orchestration in `src/execution/`, and read DTOs in `src/client/`. The `src/discuss/` layer contains the event model, deciders, reducer, transcript helpers, and projections.

---

### src/discuss/types.ts - Shared Discuss State Types

Defines `DiscussState`, `AgentState`, `TranscriptEntry`, `Result<T>`, `EndReason`, and the rest of the domain state vocabulary. This is the base shape for both deciders and reducer replay. See `src/discuss/types.ts`.

---

### src/discuss/events.ts - Domain Event And Runtime Snapshot Types

Defines the full discriminated union of persisted discuss events, the `DiscussEventEnvelope` shape, `PersistedDiscussRuntime`, `PersistedDiscussSnapshot`, and helper `makeEvent(...)`. This file is the contract between deciders, reducer, store, manager recovery, and API projections. See `src/discuss/events.ts`.

---

### src/discuss/state-machine.ts - Pure Deciders

Contains the rule engine for event emission. The `decide*` functions validate the current `DiscussState` and return one or more `DiscussDomainEvent`s without mutating state directly. Key exports: `decideSessionCreate`, `decideBid`, `decideBidRoundClose`, `decideSpeech`, `decideSpeechTimeout`, `decideEpochSummary`, `decideEnd`, `decideSynthesis`, plus helpers such as `computeEffectiveBids`, `findLastSpeaker`, `endContent`, and `resolveAgentName`. See `src/discuss/state-machine.ts`.

---

### src/discuss/reducer.ts - Event Replay

Single replay path from persisted events to `PersistedDiscussSnapshot`. Exports `makeEmptySnapshot`, `reduceDiscussEvent`, and `replayDiscussEvents`. Handles both user-visible state transitions and persisted runtime control projection (`observer_wait`, `evaluate_epoch`, `collect_follow_up`, `synthesize`). See `src/discuss/reducer.ts`.

---

### src/discuss/projections.ts - Control/Audit/Watch Read Models

Builds the redacted and full transcript projections that sit on top of the reducer output. `buildControlView()` strips live bid internals, `buildAuditView()` clones the full transcript, and `buildWatchEvents()` derives watch-log events from committed domain events. See `src/discuss/projections.ts`.

---

### src/discuss/transcript.ts - Transcript Rendering

Pure rendering helpers for `TranscriptEntry[]`. Produces human-readable transcript text for prompts and summaries without owning persistence. Supports recent/full rendering and word-wrap logic for mixed English/CJK content. See `src/discuss/transcript.ts`.

---

### src/discuss/persona-seed.ts - Persona Sampling

Pure k-DPP-based persona assignment for `discuss_seed`. Combines controversy axes, tone assignment, and optional origin weighting to produce diverse seeded personas before the live session starts. See `src/discuss/persona-seed.ts`.

---

### src/discuss/util/string.ts / util/time.ts / util/rng.ts / util/dpp.ts

Pure utility layer for the discuss subsystem:

- `util/string.ts` handles display-name parsing and string formatting helpers.
- `util/time.ts` provides timestamp helpers such as `nowIsoString()`.
- `util/rng.ts` provides seeded randomness and weighted sampling primitives.
- `util/dpp.ts` implements the linear-algebra machinery for k-DPP persona sampling.

These modules stay free of filesystem and backend concerns so both the deciders and persona seeding remain deterministic and easy to test.
