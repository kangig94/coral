# Core Modules

Key modules and their architectural roles. For exhaustive details, read the source — each module has JSDoc on exported functions.

## Composition Roots

Three esbuild entry points produce the system's processes:

| Entry | Bundle | Role |
|-------|--------|------|
| `src/bridge/server.ts` | `coral-ax.cjs` | MCP stdio proxy. Receives tool calls from Claude Code, relays to backend via HTTP. Handles `wait` locally via SSE. |
| `src/execution/server.ts` | `coral-backend.cjs` | Persistent HTTP daemon. Singleton lock, HTTP routing, tool dispatch, session/discuss/KB subsystems. |
| `src/cli/bootstrap.ts` | `coral-cli.cjs` | Commander CLI client. Parallel Bash-tool client for all Coral MCP tools. |

## Backend Core (`src/execution/`)

| Module | Responsibility |
|--------|---------------|
| `lifecycle.ts` | Singleton startup/shutdown state machine (`starting` → `running` → `draining` → `stopped`). Coordinates lock acquisition, subsystem init, and graceful drain. |
| `server-types.ts` | Leaf type module: `LifecycleState`, `BackendServerInfo`. No back-edges to `server.ts`. |
| `tool-router.ts` | Top-level tool dispatch. Routes provider tools to ExecutionService, discuss tools to discuss-tools, KB tools to kb-tools, workflow to handler. Returns `ToolDomainResult`. |
| `tool-response.ts` | Unified domain result contract: `ToolDomainResult = { ok, data } | { ok, code, message }`. Conversion helpers for MCP and HTTP transports. |
| `http-handler.ts` | HTTP route registration and request handling. SSE streaming for `/wait/stream`. |
| `service.ts` | `ExecutionService` — provider-launch orchestration (start/resume/fork/coralDispatch), wait/abort coordination, workflow delegation. Receives coordinator/event-bus/registry via `ExecutionServiceDeps`. |
| `engine.ts` | `LaunchCoordinator` class — instance-scoped child tracking, job queue, provider-server generation. CLI spawn with idle timeout, bounded output buffering (10MB), graceful kill (SIGTERM → SIGKILL). No module-global launch state. |
| `event-bus.ts` | `TypedEventBus` class — typed EventEmitter for job/session/discuss lifecycle events. Backend-local (no singleton export). |
| `host-manager.ts` | `ProviderHostManager` — provider server lifecycle, spawn/attach/detach, JSON-RPC protocol, idle timeout. |
| `session-manager.ts` | Persisted session registry under `~/.claude/coral/sessions/`. Atomic writes, single-active-job invariant. Uses shared filesystem lock. |
| `progress-store.ts` | File-based event storage under `<os-tmpdir>/coral-jobs/`. Per-job `status.json` + `progress.jsonl` + `result.md`. |
| `resolver.ts` | Resolves `coral:<name>` content from `agents/` then `skills/` with path traversal rejection. |

## Discuss Runtime (`src/execution/discuss/`)

Imperative shell around the discuss domain core. See `docs/discuss.md` for full architecture.

| Module | Responsibility |
|--------|---------------|
| `operations.ts` | Primary entry point — start, watch, participate, abort, recovery |
| `loop.ts` | Live control-loop runner (bid rounds → speech → epoch → follow-up → synthesis) |
| `subflows.ts` | Concrete async workers: collectBids, collectSpeech, evaluateEpoch, runFollowUpTurns, handleSynthesis |
| `session-store.ts` | Event-sourced persistence — compare-and-append to `event-log.jsonl`, snapshot materialization, source-scoped indexes. Per-session filesystem lock (cross-process) composes with in-process promise-chain lock. |
| `context-registry.ts` | `DiscussContextRegistry` — per-backend discuss context map. Backend-local via DI. |
| `persistence.ts` | Commit helpers, live snapshot updates, persisted watch rebuilds |
| `registry.ts` | In-memory attached sessions, watch buffer management, subscriber cursors |

## Discuss Domain (`src/discuss/`)

Functional core — pure functions, zero I/O. See `docs/discuss.md` for event flow.

| Module | Responsibility |
|--------|---------------|
| `state-machine.ts` | Pure deciders: validate input → emit event batches. Never mutates state directly. |
| `reducer.ts` | Single replay path: committed events → state + runtime snapshots |
| `events.ts` | Domain event union type + persisted runtime type definitions |
| `view-types.ts` | Shared view DTO types — breaks views↔projections cycle |
| `projections.ts` | Control/audit/watch read models from committed events |
| `persona-seed.ts` | Persona sampling via k-DPP (deterministic diversity) |

## Provider Adapters (`src/providers/`)

| Module | Responsibility |
|--------|---------------|
| `types.ts` | `Provider` interface: `execute(request, runtime)` → CLI spawn |
| `registry.ts` | `ProviderRegistry` class — instance-scoped provider map + bootstrap flag. No module globals. |
| `bootstrap.ts` | `registerBuiltInProviders(registry)` — parameterized factory, or `createBuiltInProviderRegistry()` convenience. |
| `codex/adapter.ts` | Codex Provider — JSONL event stream, `--full-auto`, coral injection via prompt prepend |
| `claude/adapter.ts` | Claude Provider — JSON output, `--append-system-prompt`, resume via `--continue` |
| `claude-appserver/` | Claude provider server — machine-scoped broker with multiplexed session pool, JSON-RPC protocol |

Both CLI adapters share: `cli-detection.ts` (availability + auth probes), `result-mapping.ts` (result normalization).

## KB (`src/kb/`)

Text indexing and vector search now split cleanly: Orama remains the text index, while the native DuckDB addon owns per-spec chunk storage and vector search snapshots.

| Module | Responsibility |
|--------|---------------|
| `contracts.ts` | Leaf type module: `KbRuntime`, `KbIndexState`, `EntityGraph`, `EntityMeta`, `EntityRelationship`, `KbVectorSpecState`, `KbVectorLease`, etc. Breaks 4-node KB SCC. |
| `runtime.ts` | `KbRuntime` factory — cached text index, Orama snapshot, entity graph I/O, mutation lock, vector-store lifecycle, 2-lane freshness (`contentSeq`/`metadataSeq`). Implements `contracts.ts` interfaces. |
| `curate-state.ts` | `CurateState` with `pendingRepair` field, repair frontier normalizer, topology/summary fingerprints, lenient malformed-entry extractor. |
| `curate.ts` | Background curation scheduler — entity/relationship extraction, principle discovery, hierarchical community detection, git sync. Sequential validate-as-you-go batch loop with entity vocabulary carry-forward. |
| `entity-consolidation.ts` | Entity name normalization, plural/synonym merge, alias emission, relationship rewiring to canonical IDs. Replaces legacy `curate-tags.ts`. |
| `community-detection.ts` | Entity-relationship graph construction + `louvain.detailed()` hierarchical community detection with dendrogram interpretation and resolution sweep. |
| `text-artifacts.ts` | Text index rebuild with entity graph loading from `.entity-graph.json`, malformed entry collection, community staleness filtering. |
| `markdown-entries.ts` | Sorted markdown entry scanning (extracted to avoid kb/curate-state→text-artifacts cycle). |
| `source-store.ts` | KB source import, staging, and lifecycle. |
| `vector-store.ts` | Node wrapper for the native addon — compatibility handshake, active snapshot resolution, DuckDB store access. |
| `vector-sync.ts` | Immutable per-spec vector snapshot staging/publish, manifest diffing, lease-safe live store swaps. |
| `embedding.ts` | Embedding provider selection and embedding-spec metadata. |
| `chunking.ts` | Note/source chunk generation for vector indexing. |
| `search.ts` | Orama full-text search + entity graph ranking (third fusion channel) + hybrid vector fusion at the entry level. Graph-aware ranking resolves entities via exact/alias match, bounded 1-hop expansion, and capped contribution. |
| `mutation-helpers.ts` | Atomic writes (unique `.tmp` names), index mutation under lock. |

## Native Vector Runtime

Separate repo: [kangig94/coral-needle](https://github.com/kangig94/coral-needle) — C++ N-API addon with DuckDB storage + USearch HNSW + ExactScan engines. Installed by `/coral:equip kb`.

Operations: `memo.ts` (create), `promote.ts` (memo → note), `update.ts`, `delete.ts`, `read.ts`.

## Workflow (`src/workflow/`)

| Module | Responsibility |
|--------|---------------|
| `pipe-parser.ts` | DSL expression parser: `"(architect, critic) -> resolver"` → AST |
| `pipe-executor.ts` | Pipeline orchestration: parallel atom launch, stale detection/recovery (`waitForJobTerminal` + abort), XML output formatting |
| `handler.ts` | Backend router entry point — schema validation, AST normalization, delegation to ExecutionService |
| `types.ts` | `WorkflowExecutionPort` — standalone interface replacing `Pick<ExecutionService,...>`. No execution back-edges. |

## Infrastructure

| Module | Responsibility |
|--------|---------------|
| `src/infra/paths.ts` | Filesystem path resolution for all Coral data directories |
| `src/infra/backend-info.ts` | Backend connection info persistence (`~/.claude/coral/backend.json`) |
| `src/shared/types.ts` | Central type hub — JobId, SessionId, SessionEntry, ProviderRequest/Result, WaitStreamEvent |
| `src/shared/session-entry.ts` | `SessionEntry` contract, strict validator, lenient reader. Shared between client/ and execution/. |
| `src/shared/fs-lock.ts` | `acquireDirectoryLock()` — mkdir-based cross-process lock with stale detection (30s). Used by discuss and session-manager. |
| `src/shared/mcp-utils.ts` | MCP response helpers: `textResult()`, `mcpError()`, `jsonResult()` |
| `src/bridge/bridge-types.ts` | `ToolDescriptor` type — breaks bridge server↔backend-tool cycle |
| `src/client/index.ts` | Public barrel for external consumers (coral-reef) — re-exports readers, discuss DTOs, lifecycle |
