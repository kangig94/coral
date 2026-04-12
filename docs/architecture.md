# Architecture

Coral is a local CLI + HTTP system. Claude Code reaches Coral through hooks, slash-command instructions, and Bash calls to `coral-cli`. `coral-cli` ensures the backend daemon is running, sends JSON requests over localhost HTTP, and streams job updates over SSE. No bridge or stdio proxy remains in the runtime path.

Coral also has a build flavor axis. `prod` is the marketplace-installed runtime and `dev` is a local build meant to coexist with it on the same machine. `bridge/manifest.json` is the sole flavor carrier for the runtime identity fields (`bundleHash` plus `flavor`), while `CORAL_FLAVOR` is only a session-level hook selector that decides which hook set should execute.

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

Resource-oriented API. Sessions and jobs are first-class resources. Each endpoint has its own strict Zod schema. Request bodies are direct JSON — no `{ context, args }` envelope. `pluginRoot` is server-authoritative.

| Route | Status | Purpose |
| --- | --- | --- |
| `POST /sessions` | 201 | Create session (with optional `agent` for coral dispatch) |
| `POST /sessions/:id/messages` | 202 | Send message to existing session (resume, never re-dispatches agent) |
| `POST /sessions/:id/forks` | 201 | Fork session (child stores its own continuation profile) |
| `GET /sessions` | 200 | List sessions (flat, namespace-scoped by stored `backendNamespace`) |
| `POST /workflow` | 202 | Workflow launch (camelCase body mapped to snake_case internally) |
| `POST /jobs/abort` | 200 | Abort one or more jobs |
| `POST /jobs/wait` | 200 | SSE job monitoring used by `coral-cli wait` and follow mode |
| `POST /discuss/persona-sets` | 200 | Compute discuss persona sets from seed input |
| `GET /discuss/sessions` | 200 | List discuss sessions |
| `POST /discuss/sessions` | 201 | Create discuss session and start the control loop |
| `GET /discuss/sessions/:id` | 200 | Read discuss session control or audit detail |
| `GET /discuss/sessions/:id/events` | 200 | Read projected watch events for a discuss session |
| `POST /discuss/sessions/:id/bids` | 200 | Submit a manual bid for a discuss session |
| `POST /discuss/sessions/:id/speeches` | 200 | Submit a manual speech for a discuss session |
| `DELETE /discuss/sessions/:id` | 200 | End a discuss session and detach it from the live registry |
| `GET /kb/entries` | 200 | Search KB entries |
| `GET /kb/notes/:slug` | 200 | Read a note by slug |
| `GET /kb/memos/:slug` | 200 | Read a project-scoped memo by slug |
| `GET /kb/sources/:slug` | 200 | Read an imported source by slug |
| `GET /kb/communities/:slug` | 200 | Read a community by slug |
| `GET /kb/principles/:slug` | 200 | Read a principle by slug |
| `POST /kb/notes` | 201 | Promote content into a note |
| `PUT /kb/notes/:slug` | 200 | Update a note by slug |
| `DELETE /kb/notes/:slug` | 200 | Delete a note by slug |
| `GET /kb/sources` | 200 | List imported KB sources |
| `POST /kb/sources` | 201 | Import a KB source |
| `DELETE /kb/sources/:slug` | 200 | Delete an imported KB source |
| `GET /kb/memos` | 200 | List project-scoped memos |
| `POST /kb/memos` | 201 | Create a project-scoped memo |
| `DELETE /kb/memos` | 200 | Delete selected memos or purge all project memos |
| `GET /kb/principles` | 200 | Search KB principles |
| `POST /kb/index` | 200 | Rebuild the KB index |
| `GET /health` | 200 | Backend health, namespace, bundle hash, subsystem status |
| `POST /admin/shutdown` | 200 | Graceful backend drain and exit |
| `GET /events/stream` | 200 | Backend-local event stream for live observers |
| `GET /api/jobs` / `GET /api/jobs/:id` | 200 | Job summaries and detailed progress history |

Error responses use real HTTP status codes: 400 (validation), 403 (scope mismatch), 404 (not found), 409 (conflict / legacy session), 503 (recovering / busy).

## Primary Execution Flows

### Session lifecycle

1. `coral-cli codex -i ...` or `coral-cli codex <agent> -i ...`
2. `src/client/http-client.ts` calls `createSession()` → `POST /sessions`
3. `src/execution/http-handler.ts` parses the direct body, builds `CallerContext` server-side
4. `src/execution/service.ts` resolves agent (if specified), persists session profile, launches provider
5. Provider adapters in `src/providers/*` spawn the real CLI/runtime and emit progress
6. `ProgressStore` and `SessionManager` persist job/session state with authoritative provenance

Continuations use `POST /sessions/:id/messages` → `service.resumeBySessionId()` which resolves provider from the stored session, merges omitted fields from the stored profile, and validates namespace/project scope. Forks use `POST /sessions/:id/forks` and persist the merged profile onto the child session.

### Wait / follow

1. Detached launches return `{ session, job, launchState }` (201 or 202)
2. `coral-cli wait --jobs "<ids>" --output-format json [--embed]` calls `streamWait()`
3. `POST /jobs/wait` yields SSE events from `ExecutionService.waitStream()`
4. Terminal events always include `result.path`; `result.content` is optional inline enrichment

### Workflow

1. `coral-cli workflow ...` posts to `POST /workflow`
2. `src/workflow/handler.ts` parses the DSL and normalizes the AST
3. `src/workflow/pipe-executor.ts` launches provider or `coral:` atoms through `ExecutionService`
4. Workflow state is persisted in the normal job store, so `coral-cli wait` works unchanged

### Discuss and KB

- `coral-cli discuss ...` maps to resource routes under `/discuss/*` and uses `src/execution/discuss-tools.ts`
- `coral-cli kb ...` maps to resource routes under `/kb/*` and uses `src/execution/kb-tools.ts`
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
| `~/.coral/data/kb/` or `~/.coral/data/kb-dev/` | KB text/vector state and imported sources |

The core architectural boundary is simple: the CLI is the only local command surface, the backend is the only daemon surface, and all long-running or resumable work is tracked as backend jobs.
