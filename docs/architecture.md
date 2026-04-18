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
  ├── Workflow commands (`workflow`, `jobs`, `wait`, `abort`)
  ├── Admin commands (`backend status|shutdown`)
  ├── Discuss commands (`discuss *`)
  └── KB commands (`kb *`)
      │
      ▼  HTTP + SSE (`127.0.0.1`, authenticated)
bridge/coral-backend.cjs
  ├── Request routing (HTTP + SSE)
  ├── Provider orchestration via the jobs domain facade
  ├── Workflow execution
  ├── Discuss runtime (pure core + imperative shell)
  ├── Jobs + sessions domains (Journal-backed)
  ├── Journal substrate (`better-sqlite3`)
  ├── KB runtime
  └── Optional provider host management
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
| `POST /workflow` | 202 | Workflow launch (camelCase body mapped to snake_case internally) |
| `GET /jobs` / `GET /jobs/:id` | 200 | Job summaries and detailed progress history |
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

`GET /jobs` accepts optional `projectRoot`, `phase`, `provider`, and `all=1` query filters. Without `all=1`, the list stays live-only (`queued`, `launching`, `running`) and remains sorted by `updatedAt` descending.

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

1. Detached launches print `Job <job> <launchState> (session <session>)`
2. `coral-cli wait --jobs "<ids>" [--embed]` calls `streamWait()`
3. `POST /jobs/wait` yields SSE events from `ExecutionService.waitStream()`
4. Terminal text always includes `Result path: <path>`; `--embed` may add preview text, but the durable artifact is always at the printed path

### Job inspection and control

1. `coral-cli jobs [--phase <phase>] [--provider <name>] [--all]` reads `GET /jobs` for the current project and projects job summaries into the CLI surface
2. `coral-cli abort --jobs "<ids>"` posts directly to `POST /jobs/abort`
3. `coral-cli abort --all` or `coral-cli abort --phase <phase> [--provider <name>]` first resolves matching live jobs through `GET /jobs`, then aborts the resulting job IDs

### Workflow

1. `coral-cli workflow ...` posts to `POST /workflow`
2. The workflow domain compiles the DSL into a plan (parse → normalize → AST)
3. The executor launches provider or `coral:` atoms through `ExecutionService`; launch and retry are intertwined per architecture §10.1a
4. Workflow state is persisted as Journal events with a projection row per workflow; `coral-cli wait` reads the same job store

### Discuss and KB

- `coral-cli discuss ...` maps to resource routes under `/discuss/*`; the discuss domain exposes a single api facade
- `coral-cli kb ...` maps to resource routes under `/kb/*`
- Discuss follows the functional-core / imperative-shell pattern: the core is pure event-sourced state transitions; the shell carries persistence, loop control, and subflows
- KB domain is self-contained under `src/kb/`

## Module Map

| Area | Role |
| --- | --- |
| CLI (`src/cli/`) | Command parsing, follow mode, text/JSON formatting |
| Client (`src/client/`) | Backend startup, HTTP requests, wait/admin helpers |
| Backend HTTP (`src/execution/`) | Backend composition root and route registration. Post-Phase-2 this layer holds composition/transport/simulation/KB residue pending handoff to `src/coordinator/**`, `src/transport/**`, and `src/simulation/**`. |
| Provider execution (`src/providers/`, `src/execution/service.ts`, `src/execution/engine.ts`) | Provider adapters, launch orchestration, host/runtime management. `engine.ts` exposes launch-pool mechanics only — domain events are owned by the jobs domain. |
| Jobs domain (`src/jobs/`) | Truth-owning facade for job lifecycle. Pure core: terminal-outcome and lifecycle-fault ADTs, job phase, cause references. Shell: launch, abort, wait, agent resolution, instruction assembly, legacy ingest. Reconcile: startup recovery and cross-namespace adoption. Facade exposes commands, queries, and reconcile surfaces. |
| Sessions domain (`src/sessions/`) | Session persistence + continuity. Pure contract types; shell handles atomic persistence and resolution. `sessionsCommands` / `sessionsQueries` facade. |
| Workflows (`src/workflow/`) | DSL parsing, plan building, decomposed pipeline execution. Launch and retry stay intertwined per architecture §10.1a. `workflowCompiler` / `workflowCommands` / `workflowRecover` facade. |
| Discuss (`src/discuss/`) | Functional-core / imperative-shell. Pure core: state machine, reducer, events. Shell: persistence, loop, subflows. `discussCommands` / `discussQueries` / `discussReconcile` facade. |
| Journal (`src/store/`) | `better-sqlite3` Journal substrate: WAL, append + rebuild, envelope + upcasters, domain-reducer dispatch. `CoralStore` is the read-only public surface. |
| Runtime (`src/runtime/`) | Single-world Runtime with six I/O subports (time / storage / paths / process / ids / env); shared exec builder used by both the real runtime and the simulation runtime. |
| Simulation (`src/simulation/`) | Deterministic doubles for testing (virtual time, sequential ids). |
| Coordinator (`src/coordinator/`) | Journal consumer driver; Phase-3 handoff target for the coordinator-facing composition. |
| Knowledge base (`src/execution/kb-tools.ts`, `src/kb/`) | KB endpoints, indexing, vector/text search, memo/source flows. |
| Shared / infra (`src/shared/`, `src/infra/`) | Shared helpers, renamed `Legacy*` compat bridges (retire in Phase 6), backend info and path resolution. |

## Dependency Sketch

```text
CLI layer (`src/cli/`)
  -> Client layer (`src/client/`)
      -> Backend HTTP routes

Backend HTTP routes
  -> Execution service (dispatcher)
  -> Workflow facade
  -> Discuss facade
  -> KB facade

Execution service
  -> Jobs domain facade (jobsCommands / jobsQueries / jobsReconcile)
  -> Sessions domain facade (sessionsCommands / sessionsQueries)
  -> Provider adapters
  -> Launch engine (pool mechanics only — emits no domain events)
  -> Provider host manager

Lifecycle startup
  -> Open Journal
  -> Rebuild projections (one-shot drain, Phase 2)
  -> jobsReconcile.runStartup
  -> discussReconcile.runStartup
  -> workflowRecover.resumeAll

Discuss shell
  -> Pure discuss core (state machine + reducer)
  -> Journal append via the discuss store-registry

KB bridge
  -> KB domain

Shared / compat layer
  -> Shared foundation consumed by all layers
  -> Legacy* compat bridges retire in Phase 6
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

## Migration Notes

### TerminalOutcome ADT (Phase 2)

Terminal results carry a typed outcome (`TerminalOutcome`) — a discriminated union owned by the jobs domain:

- `completed` — provider turn finished successfully.
- `aborted { reason }` — closed-token reason: `signal_abort` | `user_abort` | `queue_shutdown`.
- `provider_exit { code, note? }` — provider process terminated with a numeric exit code.
- `failed { causeRef }` — upstream cause resolvable via the Journal (`CauseRef = { stream, seq }`).
- `job_fault { fault }` — typed job-lifecycle fault (ghost launch, wrapper loss, wrapper crash).

The pre-rewrite `CoralFault` union has been retired; the renamed `Legacy*` compat bridges at the provider boundary retire in Phase 6.

CLI wait output surfaces the outcome through five exhaustive headers:

```
Job <id> completed
Job <id> aborted: <reason>
Job <id> provider exited <N>[: <note>]
Job <id> failed: <cause description>
Job <id> coral errored: <sentence> [<kind>]
```

The trailing `[<kind>]` tag on `coral errored` lines is the machine-readable classifier (regex `/\[(\w+)\]$/`).

**Upgrade impact**: pre-rewrite `status.json` / `progress.jsonl` records use the legacy shape. On first start after upgrade, the backend validates each record against the new schema and silently discards any record that fails — logging once per job. The job directory is not deleted, and any session claim it owned is released. To upgrade cleanly, drop `<os-tmpdir>/coral-jobs/` before the first restart, or accept that in-flight pre-upgrade jobs will not be recoverable after the version bump.
