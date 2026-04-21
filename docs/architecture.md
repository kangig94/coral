# Architecture

Coral is a local CLI + coordinator system. Claude Code reaches Coral through hooks, slash-command instructions, and Bash calls to `coral-cli`. For local mutating and live-follow commands, `coral-cli` ensures the backend daemon is running and talks over the authenticated IPC socket. Read-only no-coordinator paths use `CoralStore` directly. HTTP remains available as the remote gateway plus the operational carveouts (`/health`, `/admin/shutdown`, `/events/stream`). No bridge or stdio proxy remains in the runtime path.

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
      ├── IPC (`coordinator.sock`, authenticated) for mutating/live commands
      ├── CoralStore library reads for no-coordinator `jobs` / `kb` paths
      └── HTTP gateway + carveouts (`127.0.0.1`, authenticated)
            `/health`, `/admin/shutdown`, `/events/stream`
      │
      ▼
bridge/coral-backend.cjs
  ├── Coordinator bootstrap + lifecycle
  ├── IPC + HTTP/SSE transport adapters
  ├── Jobs / sessions / workflow / discuss / KB facades
  ├── Live ConsumerDriver freshness + drain path
  ├── Corpus notify seam for KB publication
  ├── Journal substrate (`better-sqlite3`)
  ├── KB runtime + curation scheduler
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
| `POST /coordinator/equipment` | 200 | Register named equipment into its coordinator-owned slot |
| `DELETE /coordinator/equipment/:name` | 200 | Unregister named equipment and release its slot |
| `GET /coordinator/equipment` | 200 | List equipment status by slot from the coordinator-owned lifecycle seam |
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
2. The CLI client calls `POST /sessions`
3. The transport layer validates the direct body, builds `CallerContext`, and forwards a domain-shaped request into the coordinator
4. The coordinator API resolves agent intent, persists session continuity, and launches or resumes work through the jobs and sessions shells
5. Provider adapters spawn the real CLI/runtime and emit progress
6. Journal appends publish projection freshness through the live `ConsumerDriver`; session continuity remains authoritative in the sessions shell

Continuations use `POST /sessions/:id/messages`, which resolves provider from stored continuity, merges omitted fields from the session profile, and validates namespace/project scope. Forks use `POST /sessions/:id/forks` and persist the merged profile onto the child session.

### Wait / follow

1. Detached launches print `Job <job> <launchState> (session <session>)`
2. `coral-cli wait --jobs "<ids>" [--embed]` opens the `jobs.wait` IPC subscription
3. The local IPC stream and the remote `POST /jobs/wait` HTTP gateway both read the same coordinator-owned wait surface, which uses the same job truth as startup recovery and steady-state launch orchestration
4. Terminal text always includes `Result path: <path>`; `--embed` may add preview text, but the durable artifact is always at the printed path

### Job inspection and control

1. `coral-cli jobs [--phase <phase>] [--provider <name>] [--all]` reads `CoralStore` directly for local no-coordinator paths; the same shape remains available through `GET /jobs` on the HTTP gateway
2. `coral-cli abort --jobs "<ids>"` dispatches `jobs.abort` over IPC for local calls
3. `coral-cli abort --all` or `coral-cli abort --phase <phase> [--provider <name>]` first resolves matching live jobs through the same read surface, then aborts the resulting job IDs

### Workflow

1. `coral-cli workflow ...` posts to `POST /workflow`
2. The workflow domain compiles the DSL into a plan (parse → normalize → AST)
3. The executor launches provider or `coral:` atoms through the coordinator API; launch and retry stay intertwined per architecture §10.1a
4. Workflow state is persisted as Journal events with a projection row per workflow; `coral-cli wait` reads the same job store

### Discuss and KB

- `coral-cli discuss ...` maps to resource routes under `/discuss/*`; the discuss domain exposes a single api facade
- `coral-cli kb ...` maps to resource routes under `/kb/*`
- Discuss follows the functional-core / imperative-shell pattern: the core is pure event-sourced state transitions; the shell carries persistence, loop control, and subflows
- KB is self-contained and publishes corpus changes through the coordinator notify seam

## Module Map

| Area | Role |
| --- | --- |
| CLI | Command parsing, follow mode, text/JSON formatting. |
| Client | Backend startup, IPC requests/subscriptions, remote HTTP gateway/admin helpers, and direct `CoralStore` read helpers for no-coordinator CLI paths. |
| Coordinator | Process bootstrap, lifecycle, startup recovery, ConsumerDriver freshness, corpus notify, equipment slot ownership, provider-host coordination, and cross-domain assembly. `src/coordinator/api.ts` plus `src/coordinator/composition/**` are explicit coordinator glue and may assemble domain shells/contracts. |
| Transport | IPC + HTTP/SSE request parsing, validation, and wire formatting. Transport depends on domain and coordinator-facing contracts, not on domain shells. |
| Provider execution | Provider adapters, launch orchestration, durable transport, and host/runtime management. Queue and lease mechanics stay below the domain truth surfaces. |
| Jobs | Truth-owning facade for job lifecycle: launch, wait, abort, terminal outcomes, and startup reconciliation. |
| Sessions | Session persistence and continuity, including resume/fork identity and atomic storage. |
| Workflow | DSL compilation and pipeline execution, with launch and retry remaining part of the same ownership seam. |
| Discuss | Functional-core / imperative-shell discussion loop with persistence, bids, speeches, follow-ups, and synthesis. |
| Journal | Event-sourced substrate for append, rebuild, envelope decoding, and projection dispatch. |
| Runtime | Single-world Runtime with six I/O subports shared by production and simulation. |
| Simulation | Deterministic doubles for tests. |
| Knowledge base | Search, indexing, memo/source flows, and publication into the corpus authority. |
| Shared / infra | Low-level helpers, settled path resolution, and the remaining legacy-vocabulary boundary: domain upcasters on read, `legacy-ingest` where runtime canonicalization still needs legacy input. |

## Dependency Sketch

```text
CLI layer
  -> Client layer
      -> Transport IPC/HTTP surface
  -> CoralStore library reads (read-only no-coordinator commands)

Transport IPC/HTTP surface
  -> Coordinator API + control ports
  -> Domain facades/contracts (workflow / discuss / KB / jobs / sessions)

Coordinator glue (`api.ts` + `bootstrap.ts` + `composition/**`)
  -> Jobs shells / queries / recovery
  -> Sessions shell / continuity lookup
  -> Workflow / discuss / KB facades
  -> Provider adapters + live host management

Coordinator startup
  -> Open Journal
  -> Register projection consumers
  -> Drain freshness to the current Journal head
  -> jobsReconcile.runStartup
  -> discussReconcile.runStartup
  -> workflowRecover.resumeAll
  -> expose steady-state transport

Discuss shell
  -> Pure discuss core (state machine + reducer)
  -> Journal append via the discuss store-registry

KB runtime
  -> Corpus publication + notify seam
  -> Coordinator freshness / health bridge

Shared / compat layer
  -> Shared foundation consumed by all layers
  -> Domain upcasters own read-time body transforms
  -> `legacy-ingest` is the only production module that still speaks legacy vocabularies
```

## Runtime State

| Path | Purpose |
| --- | --- |
| `~/.coral/run/coordinator.json` or `~/.coral/run-dev/coordinator.json` | Active coordinator discovery record |
| `~/.coral/run/coordinator.lock` or `~/.coral/run-dev/coordinator.lock` | Per-flavor singleton coordinator lock |
| `~/.coral/data/store/store.db` or `~/.coral/data-dev/store/store.db` | Journal authority and projection tables |
| `~/.claude/coral/execution/sessions/<working-dir-hash>/*.json` | Persisted provider sessions / continuation profiles |
| `<os-tmpdir>/coral-jobs/<jobId>/` | Job runtime scratch dir; `result.md` remains the durable wait/follow artifact |
| `~/.coral/projects/<source-slug>/discuss/` | Discuss event log, snapshots, indexes |
| `~/.coral/kb/` or `~/.coral/kb-dev/` | Corpus-authoritative markdown KB |
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

The pre-rewrite `CoralFault` union is retired. Read-time body transforms now live in per-domain upcasters, and `src/jobs/shell/legacy-ingest.ts` is the only production module that still speaks legacy vocabularies.

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
