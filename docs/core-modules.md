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
| `tool-router.ts` | Top-level tool dispatch. Routes provider tools to ExecutionService, discuss tools to discuss-tools, KB tools to kb-tools, workflow to handler. |
| `http-handler.ts` | HTTP route registration and request handling. SSE streaming for `/wait/stream`. |
| `service.ts` | `ExecutionService` — provider-launch orchestration (start/resume/fork/coralDispatch), wait/abort coordination, workflow delegation. Owns SessionManager, AbortRegistry, ProgressStore. |
| `engine.ts` | CLI spawn with idle timeout, bounded output buffering (10MB), FIFO job queue (`MAX_ACTIVE_SESSIONS` default 10), graceful kill (SIGTERM → SIGKILL). |
| `session-manager.ts` | Persisted session registry under `~/.claude/coral/sessions/`. Atomic writes, single-active-job invariant. |
| `progress-store.ts` | File-based event storage under `<os-tmpdir>/coral-jobs/`. Per-job `status.json` + `progress.jsonl` + `result.md`. |
| `resolver.ts` | Resolves `coral:<name>` content from `agents/` then `skills/` with path traversal rejection. |

## Discuss Runtime (`src/execution/discuss/`)

Imperative shell around the discuss domain core. See `docs/discuss.md` for full architecture.

| Module | Responsibility |
|--------|---------------|
| `operations.ts` | Primary entry point — start, watch, participate, abort, recovery |
| `loop.ts` | Live control-loop runner (bid rounds → speech → epoch → follow-up → synthesis) |
| `subflows.ts` | Concrete async workers: collectBids, collectSpeech, evaluateEpoch, runFollowUpTurns, handleSynthesis |
| `session-store.ts` | Event-sourced persistence — compare-and-append to `event-log.jsonl`, snapshot materialization, source-scoped indexes |
| `persistence.ts` | Commit helpers, live snapshot updates, persisted watch rebuilds |
| `registry.ts` | In-memory attached sessions, watch buffer management, subscriber cursors |

## Discuss Domain (`src/discuss/`)

Functional core — pure functions, zero I/O. See `docs/discuss.md` for event flow.

| Module | Responsibility |
|--------|---------------|
| `state-machine.ts` | Pure deciders: validate input → emit event batches. Never mutates state directly. |
| `reducer.ts` | Single replay path: committed events → state + runtime snapshots |
| `events.ts` | Domain event union type + persisted runtime type definitions |
| `projections.ts` | Control/audit/watch read models from committed events |
| `persona-seed.ts` | Persona sampling via k-DPP (deterministic diversity) |

## Provider Adapters (`src/providers/`)

| Module | Responsibility |
|--------|---------------|
| `types.ts` | `Provider` interface: `execute(request, runtime)` → CLI spawn |
| `registry.ts` | Provider registration + lookup by tool name |
| `codex/adapter.ts` | Codex Provider — JSONL event stream, `--full-auto`, coral injection via prompt prepend |
| `claude/adapter.ts` | Claude Provider — JSON output, `--append-system-prompt`, resume via `--continue` |

Both adapters share: `cli-detection.ts` (availability + auth probes), `result-mapping.ts` (result normalization).

## KB (`src/kb/`)

| Module | Responsibility |
|--------|---------------|
| `runtime.ts` | `KbRuntime` factory — cached text index, Orama snapshot, mutation lock, optional LanceDB adapter |
| `search.ts` | Orama full-text search with BM25 ranking and field boosting |
| `curate.ts` | Background curation scheduler — tag/principle classification via `claude -p`, git sync cycle |
| `mutation-helpers.ts` | Atomic writes, index mutation under lock |

Operations: `memo.ts` (create), `promote.ts` (memo → note), `update.ts`, `delete.ts`, `read.ts`.

## Workflow (`src/workflow/`)

| Module | Responsibility |
|--------|---------------|
| `pipe-parser.ts` | DSL expression parser: `"(architect, critic) -> resolver"` → AST |
| `pipe-executor.ts` | Pipeline orchestration: parallel atom launch, stale detection/recovery, XML output formatting |
| `handler.ts` | Backend router entry point — schema validation, AST normalization, delegation to ExecutionService |

## Infrastructure

| Module | Responsibility |
|--------|---------------|
| `src/infra/paths.ts` | Filesystem path resolution for all Coral data directories |
| `src/infra/backend-info.ts` | Backend connection info persistence (`~/.claude/coral/backend.json`) |
| `src/shared/types.ts` | Central type hub — JobId, SessionId, ProviderRequest/Result, WaitStreamEvent |
| `src/shared/mcp-utils.ts` | MCP response helpers: `textResult()`, `mcpError()`, `jsonResult()` |
| `src/client/index.ts` | Public barrel for external consumers (coral-reef) — re-exports readers, discuss DTOs, lifecycle |
