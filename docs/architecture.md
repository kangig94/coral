# Architecture

Coral is a local CLI + HTTP system. Claude Code reaches Coral through hooks, slash-command instructions, and Bash calls to `coral-cli`. `coral-cli` ensures the backend daemon is running, sends JSON requests over localhost HTTP, and streams job updates over SSE. No bridge or stdio proxy remains in the runtime path.

## Runtime Layout

```text
Claude Code
├── Hooks (`hooks/*.mjs`)
├── Slash-command skills (`skills/*/SKILL.md`)
└── Bash calls to `coral-cli`
      │
      ▼
bridge/coral-cli.cjs
  ├── Provider commands (`codex`, `claude`)
  ├── Workflow commands (`workflow`, `wait`, `abort`)
  ├── Admin commands (`backend status|shutdown`)
  ├── Discuss commands (`discuss *`)
  └── KB commands (`kb *`)
      │
      ▼  HTTP + SSE (`127.0.0.1`, authenticated)
bridge/coral-backend.cjs
  ├── Request routing (`src/execution/http-handler.ts`)
  ├── Provider orchestration (`src/execution/service.ts`)
  ├── Workflow execution (`src/workflow/*`)
  ├── Discuss runtime (`src/execution/discuss/*`)
  ├── KB runtime (`src/kb/*`)
  ├── Session + job persistence
  └── Optional provider host management (`src/execution/host-manager.ts`)
      │
      ├── Codex CLI
      ├── Claude CLI
      └── Claude appserver helper (`bridge/coral-claude-appserver.cjs`, when needed)
```

## Backend HTTP Surface

| Route | Purpose |
| --- | --- |
| `GET /health` | Backend health, namespace, bundle hash, subsystem status |
| `POST /provider/:name` | Provider operations: `exec`, `resume`, `fork`, `list`, `coral:<agent>` |
| `POST /workflow` | Workflow launch |
| `POST /abort` | Abort one or more jobs |
| `POST /wait/stream` | SSE job monitoring used by `coral-cli wait` and follow mode |
| `POST /discuss/:action` | Discuss actions: `seed`, `start`, `watch`, `participate`, `abort` |
| `POST /kb/:action` | KB actions: search, read, mutate, memo, source, reindex, principles |
| `POST /admin/shutdown` | Graceful backend drain and exit |
| `GET /events/stream` | Backend-local event stream for live observers |
| `GET /api/jobs` / `GET /api/jobs/:jobId` | Job summaries and detailed progress history |
| `GET /api/sessions` | Persisted provider sessions for the current namespace |
| `GET /api/discuss` / `GET /api/discuss/detail` | Discuss summaries and detail views |

## Primary Execution Flows

### Provider execution

1. `coral-cli codex -i ...` or `coral-cli codex <agent> -i ...`
2. `src/client/http-client.ts` posts to `POST /provider/:name`
3. `src/execution/http-handler.ts` validates the payload and calls `ExecutionService`
4. `src/execution/service.ts` launches or resumes the provider through the registry
5. Provider adapters in `src/providers/*` spawn the real CLI/runtime and emit progress
6. `ProgressStore` and `SessionManager` persist job/session state

`coral:<agent>` dispatch is resolved by `src/execution/resolver.ts` and converted into a provider instruction by `src/execution/instruction.ts`.

### Wait / follow

1. Detached launches return `{ job, session, ... }`
2. `coral-cli wait --jobs "<ids>" --output-format json [--embed]` calls `streamWait()`
3. `POST /wait/stream` yields SSE events from `ExecutionService.waitStream()`
4. Terminal events always include `result.path`; `result.content` is optional inline enrichment

### Workflow

1. `coral-cli workflow ...` posts to `POST /workflow`
2. `src/workflow/handler.ts` parses the DSL and normalizes the AST
3. `src/workflow/pipe-executor.ts` launches provider or `coral:` atoms through `ExecutionService`
4. Workflow state is persisted in the normal job store, so `coral-cli wait` works unchanged

### Discuss and KB

- `coral-cli discuss ...` maps to `POST /discuss/:action` and uses `src/execution/discuss-tools.ts`
- `coral-cli kb ...` maps to `POST /kb/:action` and uses `src/execution/kb-tools.ts`
- Discuss runtime lives under `src/execution/discuss/` and the pure domain model lives under `src/discuss/`
- KB runtime lives under `src/kb/`

## Module Map

| Area | Key modules | Role |
| --- | --- | --- |
| CLI | `src/cli/main.ts`, `src/cli/follow.ts`, `src/cli/format.ts` | Command parsing, follow mode, human/JSON formatting |
| Client | `src/client/http-client.ts`, `src/client/backend-lifecycle.ts`, `src/client/backend-helpers.ts` | Backend startup, HTTP requests, wait/admin helpers |
| Backend HTTP | `src/execution/server.ts`, `src/execution/http-handler.ts` | Backend composition root and route registration |
| Provider execution | `src/execution/service.ts`, `src/execution/engine.ts`, `src/providers/*` | Launch orchestration, provider spawning, host/runtime management |
| Workflows | `src/workflow/handler.ts`, `src/workflow/pipe-executor.ts`, `src/workflow/pipe-parser.ts` | DSL parsing and pipeline execution |
| Discuss | `src/execution/discuss/*`, `src/discuss/*` | Imperative runtime shell plus pure event-sourced core |
| Knowledge base | `src/execution/kb-tools.ts`, `src/kb/*` | Dedicated KB endpoints, indexing, vector/text search, memo/source flows |
| Shared / infra | `src/shared/utils.ts`, `src/shared/types.ts`, `src/infra/*` | Shared helpers, shared contracts, backend info and path resolution |

## Dependency Sketch

```text
src/cli/*
  -> src/client/*
      -> src/execution/http-handler.ts routes

src/execution/http-handler.ts
  -> src/execution/service.ts
  -> src/workflow/handler.ts
  -> src/execution/discuss-tools.ts
  -> src/execution/kb-tools.ts

src/execution/service.ts
  -> src/providers/*
  -> src/execution/progress-store.ts
  -> src/execution/session-manager.ts
  -> src/execution/host-manager.ts

src/execution/discuss/*
  -> src/discuss/*

src/execution/kb-tools.ts
  -> src/kb/*

src/shared/utils.ts and src/shared/types.ts
  -> shared foundation used across CLI, client, execution, providers, and KB
```

## Runtime State

| Path | Purpose |
| --- | --- |
| `~/.claude/coral/backend.json` | Active backend connection info |
| `~/.claude/coral/backend.lock` | Singleton backend lock |
| `~/.claude/coral/sessions/<project-hash>/*.json` | Persisted provider sessions |
| `<os-tmpdir>/coral-jobs/<jobId>/` | Job status, progress log, result artifact |
| `~/.coral/projects/<source-slug>/discuss/` | Discuss event log, snapshots, indexes |
| `~/.coral/.env` | User-local embedding configuration |
| `~/.coral/data/kb/` | KB text/vector state and imported sources |

The core architectural boundary is simple: the CLI is the only local command surface, the backend is the only daemon surface, and all long-running or resumable work is tracked as backend jobs.
