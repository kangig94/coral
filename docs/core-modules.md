# Core Modules

Key modules and their roles in the current Coral runtime.

## Composition Roots

| Entry | Bundle | Role |
| --- | --- | --- |
| `src/execution/server.ts` | `bridge/coral-backend.cjs` | Backend daemon composition root |
| `src/cli/bootstrap.ts` | `bridge/coral-cli.cjs` | CLI entrypoint |
| `src/providers/claude-appserver/server.ts` | `bridge/coral-claude-appserver.cjs` | Claude appserver helper runtime |

## CLI and Client

| Module | Responsibility |
| --- | --- |
| `src/cli/main.ts` | Commander command tree and request dispatch |
| `src/cli/follow.ts` | Detached launch follow mode built on `streamWait()` |
| `src/cli/format.ts` | Text formatting for CLI output |
| `src/client/backend-lifecycle.ts` | Backend startup, replacement, and health probing |
| `src/client/backend-helpers.ts` | Wait streaming, backend status, shutdown helpers |
| `src/client/http-client.ts` | Dedicated HTTP client for provider, workflow, discuss, KB, and abort routes |
| `src/client/index.ts` | Public client barrel for external consumers |

## Backend Core (`src/execution/`)

| Module | Responsibility |
| --- | --- |
| `runtime.ts` | `Runtime` interface (6 subports: `time`, `storage`, `paths`, `process`, `ids`, `env`) + `RealRuntime` production implementation. All execution I/O routes through this single world, swapped once at `createBackendServer()`. |
| `server.ts` | Backend daemon entry point. Wraps `createBackendCore` with the runtime observer. Composition lives in `src/execution/composition/`. |
| `backend-core.ts` | Public façade re-exporting `createBackendCore`, `listInstantiatedExecutionServices`, and public types from `composition/`. |
| `backend-core-types.ts` | Acyclic leaf for public surface types (`BackendBootSnapshot`, `BackendCoreOptions`, `BackendCoreResult`, `CreateServerFn`, `FetchFn`). |
| `http-handler.ts` | HTTP route parsing and request handling |
| `service.ts` | `ExecutionService`: session create (with optional agent), resume/fork, workflow delegation, wait handling. Receives root-resolved `backendNamespace` from deps (no ambient fallback). |
| `engine.ts` | `LaunchCoordinator({ runtime })`: child-process tracking, queues, timeouts. Worker limits (`MAX_WORKERS`, `DISCUSS_MAX_WORKERS`) are lazy getters via `RuntimeEnv`. `DurableExecutionTransport` seam for the durable wrapper protocol. |
| `lifecycle.ts` | Startup, recovery, shutdown, drain. `LifecycleDeps` includes `runtime` field + boot seams (`createServerFn`, `listenFn`, `recoverPersistedDiscussFn`, etc.). |
| `recovery-core.ts` | Pure `planRecovery()` → `RecoveryPlan { register: RegisterAction[], cleanup: CleanupAction[] }`. Type-safe action classification. |
| `idle-timer.ts` | `IdleTimer({ time: RuntimeTimePort, timeoutMs })`: time-injectable idle tracking. |
| `backend-lock.ts` | Backend singleton lock with `BackendLockRuntime` (storage + paths + time + ownership verifier). |
| `host-manager.ts` | Provider host runtime management (runtime-backed spawn) |
| `event-bus.ts` | Typed backend event bus |
| `progress-store.ts` | Namespace-bound job persistence. Constructor: `(namespace, runtime, eventBus?)`. Lazy hydration via `ensureHydrated()`. Instance-scoped `enqueueSequence`. |
| `session-manager.ts` | Persisted provider sessions. Constructor: `(workingDirectory, runtime, eventBus?)`. Runtime-injected, no static methods. |
| `session-index.ts` | Namespace-aware session indexing |
| `agent-resolution.ts` | Resolves `coral:<agent>` content from `agents/` and `skills/` |
| `instruction.ts` | Converts resolved content into provider instructions |
| `tool-response.ts` | Shared domain result contract used by HTTP routes |
| `discuss-tools.ts` | Dedicated discuss action handlers for `/discuss/:action` |
| `kb-tools.ts` | Dedicated KB action handlers for `/kb/:action` |

## Backend Composition (`src/execution/composition/`)

| Module | Responsibility |
| --- | --- |
| `create-backend-core.ts` | Orchestration root. `createBackendCore` sequences `resolveBackendDefaults` → `createBackendWorld` → `finalizeWithWorld(world)` → `createRuntimeState` → `createExecutionServices` → `createDiscussRuntime` → `createBackendControl`, assembles `HttpHandlerDeps` + `LifecycleDeps`, creates the server, and late-binds `lifecycleController`. Owns the single `streamResponses` set and the `scopeCheckJobs` 2-arity curry. |
| `backend-defaults.ts` | `resolveBackendDefaults(options, runtime)` returns a single-use `BackendDefaultsPlan`: eager defaults plus `finalizeWithWorld(bindings)` that binds `listenFn`, `cleanupStaleJobsFn`, `markJobsAsErrorFn`, and `terminateAllFn` against the world and throws on a second call. Owns `__PLUGIN_ROOT__`, ownership verifier, plugin-root resolution, and the default factory bag. |
| `backend-world.ts` | `createBackendWorld(options, runtime, defaultsPlan)` resolves identity metadata (version, bundleHash, flavor, instanceId, token, bindHost, advertiseHost, backendPid, coralEnvSnapshot, log, resolveProjectSource, namespace, pluginRoot), runs `setBuildFlavor`/`backendLog.init`, constructs primitive singletons (`IdleTimer`, `LaunchCoordinator`, `TypedEventBus`, `ProviderRegistry`, `PluginRegistry`, `DiscussContextRegistry`, `ProgressStore`, `ProviderHostManager`, `SessionIndex`), and returns the `BackendWorld` bag. Declares `__VERSION__`. |
| `runtime-state.ts` | `createRuntimeState(startedAt)` returns `MutableBackendRuntimeState` (lifecycle, startedAt, kbSubsystem, kbInitError, launchFenceActive). |
| `execution-services.ts` | `createExecutionServices` exposes per-`CallerContext` `getExecutionService`/`getRecoveryService`/`listExecutionServices` with a private `Map<string, ExecutionServiceLike>`. Also re-exports `listInstantiatedExecutionServices` for façade compatibility. |
| `discuss-runtime.ts` | `createDiscussRuntime` returns `getDiscussStoreForSource`, `getDiscussContext`, `readHelpersDeps`, `discussStores` (live Map for `LifecycleDeps`), and `hooks` (`onShutdown`, `onIdleCheck`, `onRecoveryComplete`). Hooks live here because every branch pivots on discuss state. |
| `backend-control.ts` | `createBackendControl` returns `abortJobs`, `scopeCheckJobs`, `isDrainRequested`, `requestDrain`. Uses a late-bound `getLifecycleController` getter (called at use time, not snapshotted). Bundles abort/scope job-control and the drain admission gate as one control-plane helper. |

## Discuss Runtime (`src/execution/discuss/`)

| Module | Responsibility |
| --- | --- |
| `operations.ts` | High-level discuss operations |
| `loop.ts` | Live control loop |
| `subflows.ts` | Bid, speech, follow-up, synthesis workers |
| `context.ts` / `context-registry.ts` | Backend-local discuss dependency registry |
| `session-store.ts` | Event log and snapshot persistence |
| `registry.ts` | Live attached-session registry and watch buffers |
| `persistence.ts` | Snapshot/index update helpers |
| `prompts.ts` / `executor.ts` | Provider-turn prompt construction and execution |

## Discuss Domain (`src/discuss/`)

| Module | Responsibility |
| --- | --- |
| `state-machine.ts` | Pure event deciders |
| `reducer.ts` | Replay path from events to state |
| `events.ts` | Event definitions |
| `projections.ts` / `views.ts` / `watch.ts` | Read models and watch projections |
| `persona-seed.ts` | Persona seeding |
| `schemas.ts` / `types.ts` / `view-types.ts` | Shared discuss contracts |

## Providers (`src/providers/`)

| Module | Responsibility |
| --- | --- |
| `registry.ts` | Provider registration and lookup |
| `bootstrap.ts` | Built-in provider bootstrap |
| `types.ts` | Provider interfaces and runtime contracts |
| `codex/adapter.ts` | Codex execution adapter |
| `claude/adapter.ts` | Claude execution adapter |
| `claude-appserver/*` | Claude provider-side server runtime |
| `inject.ts` | Resolves and renders `INJECT.md` for provider-launched sessions |
| `cli-detection.ts` / `result-mapping.ts` | Shared provider support code |

## Knowledge Base (`src/kb/`)

| Module | Responsibility |
| --- | --- |
| `runtime.ts` | KB runtime and index lifecycle |
| `search.ts` | Text plus vector plus graph search |
| `memo.ts`, `promote.ts`, `update.ts`, `delete.ts`, `read.ts` | KB mutation and read operations |
| `source-store.ts`, `source-import.ts` | Imported source lifecycle |
| `curate.ts`, `community-detection.ts`, `entity-consolidation.ts` | Background curation and graph analysis |
| `vector-store.ts`, `vector-sync.ts`, `embedding.ts`, `chunking.ts` | Vector runtime and embedding support |

## Workflow (`src/workflow/`)

| Module | Responsibility |
| --- | --- |
| `pipe-parser.ts` | Workflow DSL parser |
| `pipe-executor.ts` | Pipeline execution, retries, stale recovery |
| `handler.ts` | HTTP-facing workflow entry point |
| `schemas.ts` / `types.ts` | Workflow contracts |

## Shared and Infrastructure

| Module | Responsibility |
| --- | --- |
| `src/shared/utils.ts` | Shared utility helpers: `readBundleHash()`, `readBuildFlavor()`, `isRecord()`, `nowIsoString()` |
| `src/shared/env-sanitize.ts` | Pure env sanitization: ARG_MAX budget resolution, CORAL_* stripping, env shedding |
| `src/shared/types.ts` | Shared runtime contracts: jobs, sessions, wait events, workflow metadata |
| `src/shared/session-entry.ts` | Session contract validation and lenient reading |
| `src/shared/fs-lock.ts` | Cross-process directory locking (runtime-aware async path + legacy sync path) |
| `src/shared/file-tail.ts` | Incremental file tailing for progress streams (runtime-backed storage) |
| `src/shared/child-env.ts` | `buildChildEnv()` for appserver provider (delegates to env-sanitize.ts) |
| `src/shared/node-process.ts` | Client-side PID liveness check (EPERM-aware) |
| `src/shared/test-deferred.ts` | Shared test utility: `createDeferred<T>()` |
| `src/shared/sse-parser.ts` | SSE and HTTP parsing helpers for wait/follow flows |
| `src/infra/paths.ts` | Canonical path resolution + `setBuildFlavor()`/`currentBuildFlavor()` for KB isolation |
| `src/infra/backend-info.ts` | Backend connection info persistence (`BackendInfo` includes `flavor` field) |

## Dependency Outline

```text
CLI
  -> client helpers
     -> backend HTTP routes

backend HTTP routes
  -> execution service
  -> workflow handler
  -> discuss tools
  -> KB tools

execution service
  -> providers
  -> progress/session/host management

discuss runtime
  -> discuss domain

KB tools
  -> KB runtime

shared/utils.ts + shared/types.ts
  -> lowest common layer reused everywhere
```

The bridge layer is gone. The stable architectural split is now CLI/client, backend execution, provider adapters, discuss runtime, KB runtime, workflow engine, and shared infrastructure.
