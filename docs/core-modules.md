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
| `server.ts` | Backend server composition, subsystem wiring, lifecycle ownership |
| `http-handler.ts` | HTTP route parsing and request handling |
| `service.ts` | `ExecutionService`: provider launch/resume/fork, `coralDispatch`, workflow delegation, wait handling |
| `engine.ts` | `LaunchCoordinator`: child-process tracking, queues, timeouts, process cleanup |
| `lifecycle.ts` | Startup, recovery, shutdown, drain handling |
| `host-manager.ts` | Provider host runtime management |
| `event-bus.ts` | Typed backend event bus |
| `progress-store.ts` | Job status/progress/result persistence |
| `session-manager.ts` | Persisted provider sessions |
| `session-index.ts` | Namespace-aware session indexing |
| `resolver.ts` | Resolves `coral:<agent>` content from `agents/` and `skills/` |
| `instruction.ts` | Converts resolved content into provider instructions |
| `tool-response.ts` | Shared domain result contract used by HTTP routes |
| `discuss-tools.ts` | Dedicated discuss action handlers for `/discuss/:action` |
| `kb-tools.ts` | Dedicated KB action handlers for `/kb/:action` |

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
| `src/shared/utils.ts` | Shared utility helpers such as `assertOwnerId()`, `collectCoralEnv()`, `readBundleHash()`, `isRecord()`, `tryExclusiveWrite()` |
| `src/shared/types.ts` | Shared runtime contracts: jobs, sessions, wait events, workflow metadata |
| `src/shared/session-entry.ts` | Session contract validation and lenient reading |
| `src/shared/fs-lock.ts` | Cross-process directory locking |
| `src/shared/sse-parser.ts` | SSE and HTTP parsing helpers for wait/follow flows |
| `src/infra/paths.ts` | Canonical path resolution for runtime data |
| `src/infra/backend-info.ts` | Backend connection info persistence |

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
