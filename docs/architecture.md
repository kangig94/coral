# Architecture

Coral is a coding-assistant plugin for Claude Code and Codex. Its purpose is to help LLM agents do software work better: plan/review workflows, side-effect and bug discovery, multi-perspective discussion, durable job observation, session continuity, and long-term project memory through KB.

Internally, Coral is a local coding-agent coordination layer. Claude Code reaches Coral through hooks, slash-command skills, and Bash calls to `coral-cli`. For local mutating and live-follow commands, `coral-cli` ensures the backend daemon is running and talks over the authenticated IPC socket. Read-only no-coordinator paths use the `read-model/CoralStore` facade directly. HTTP remains available as the remote gateway plus the operational carveouts (`/health`, `/admin/shutdown`, `/events/stream`). No bridge or stdio proxy remains in the runtime path.

Coral also has a build flavor axis. `prod` is the marketplace-installed runtime and `dev` is a local build meant to coexist with it on the same machine. `bridge/manifest.json` is the sole flavor carrier for the runtime identity fields (`bundleHash` plus `flavor`), while `CORAL_FLAVOR` is only a session-level hook selector that decides which hook set should execute.

## Design Frame

The product frame is coding assistance. The architecture frame is local coordination. "Control plane" in this document is internal vocabulary: the coordinator owns local decisions, live state, recovery sequencing, and capability activation so Claude/Codex do not have to manage those concerns inside prompts or shell glue.

| Product capability | Internal owner |
| --- | --- |
| Plan/review workflow | Workflow plan + jobs execution |
| Side-effect and bug discovery | Workflow slots, provider jobs, wait/follow |
| Idea digging and multi-agent review | Discuss domain and shell |
| Long-term coding memory | KB Corpus authority + retrieval projections |
| Provider continuity | Sessions authority |
| Long-running observable work | Jobs authority |
| Optional sharper retrieval | Coordinator-owned expansion lifecycle |

This frame constrains new code: first name the truth owner, then decide whether the work is direct, durable, or projection freshness, then compose cross-domain behavior only in the coordinator or CLI.

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
      ├── read-model/CoralStore library reads for no-coordinator `jobs` / `kb` paths
      └── HTTP gateway + carveouts (`127.0.0.1`, authenticated)
            `/health`, `/admin/shutdown`, `/events/stream`
      │
      ▼
bridge/coral-backend.cjs
  ├── Coordinator bootstrap + lifecycle
  ├── IPC + HTTP/SSE transport adapters
  ├── Jobs / sessions / workflow / discuss / KB owner modules and contracts
  ├── Live ConsumerDriver freshness + drain path
  ├── Corpus notify seam for KB publication
  ├── Journal substrate (`node:sqlite`)
  ├── KB runtime + curation scheduler
  └── Optional provider host management
      │
      ├── Codex CLI
      ├── Claude CLI
      └── Claude PTY broker helper (`bridge/coral-claude-appserver.cjs`, when needed)
```

The Claude helper keeps its historical bridge filename, but the runtime path is PTY-based: Coral launches interactive `claude` through `@lydell/node-pty`, writes turns to stdin after the terminal is ready (re-sending if the transcript shows the prompt was dropped, then failing fast rather than blocking until the turn timeout), and derives completion/progress from Claude's JSONL transcript. It does not use `claude -p` for provider turns.

## Backend HTTP Surface

Resource-oriented API. Sessions and jobs are first-class resources. Each endpoint has its own strict Zod schema. Request bodies are direct JSON — no `{ context, args }` envelope. `pluginRoot` is server-authoritative.

| Route | Status | Purpose |
| --- | --- | --- |
| `POST /sessions` | 201 | Create session (with optional `agent` for coral dispatch) |
| `POST /workflow` | 202 | Workflow launch (camelCase body mapped to snake_case internally) |
| `POST /coordinator/expansion` | 200 | Equip a named expansion via `ExpansionLifecycleService` (binds the expansion's runtime cells under a fresh scope) |
| `DELETE /coordinator/expansion/:name` | 200 | Unequip a named expansion (disposes its scope, releasing every binding it held) |
| `DELETE /coordinator/expansion/:name/catalog` | 200 | Remove a manifest entry from `expansion_manifest_catalog` (catalog-only purge; does not unequip live bindings) |
| `GET /coordinator/expansion` | 200 | List currently-equipped expansions via `expansion_state` |
| `GET /coordinator/bindings/:binding` | 200 | Read a single capability binding's current owner and metadata |
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
| `GET /kb/diagnose` | 200 | Report curate retry queue and KB subsystem diagnostics |
| `GET /kb/notes/:slug` | 200 | Read a note by slug |
| `GET /kb/memos/:slug` | 200 | Read a project-scoped memo by slug |
| `GET /kb/sources/:slug` | 200 | Read an imported source by slug |
| `GET /kb/communities/:slug` | 200 | Read a community by slug |
| `GET /kb/principles/:slug` | 200 | Read a principle by slug |
| `POST /kb/notes` | 201 | Promote content into a note |
| `PUT /kb/notes/:slug` | 200 | Update a note by slug |
| `DELETE /kb/notes/:slug` | 200 | Delete a note by slug |
| `GET /kb/sources` | 200 | List imported KB sources |
| `POST /kb/sources` | 201 / 202 | Start a job-backed KB source import; async requests return 202 |
| `DELETE /kb/sources/:slug` | 200 | Delete an imported KB source |
| `GET /kb/memos` | 200 | List project-scoped memos |
| `POST /kb/memos` | 201 | Create a project-scoped memo |
| `DELETE /kb/memos` | 200 | Delete selected memos or purge all project memos |
| `GET /kb/principles` | 200 | Search KB principles |
| `GET /kb/wikis` | 200 | List wiki entries |
| `GET /kb/wikis/:slug` | 200 | Read a wiki entry by slug |
| `POST /kb/wikis` | 201 | Create an empty wiki entry |
| `POST /kb/wikis/:slug/understanding` | 200 | Replace the Understanding section |
| `POST /kb/wikis/:slug/knowledge` | 200 | Append refs to the Knowledge section |
| `POST /kb/wikis/:slug/knowledge/unlink` | 200 | Remove refs from the Knowledge section |
| `POST /kb/wikis/:slug/knowledge/cite` | 200 | Append an evidence sub-bullet under a Knowledge link |
| `POST /kb/wikis/:slug/knowledge/adopt` | 201 | Promote a memo into a note and link it at the front of Knowledge atomically |
| `DELETE /kb/wikis/:slug` | 200 | Delete a wiki entry by slug |
| `GET /kb/wake-up` | 200 | Generate the SessionStart wake-up packet |
| `POST /kb/index` | 200 | Rebuild KB text artifacts through an internal job |
| `GET /health` | 200 | Backend health, namespace, bundle hash, kernel phase, and per-subsystem status (`subsystems[]`, `kernel`, `diagnostics`) |
| `POST /admin/shutdown` | 200 | Graceful backend drain and exit |
| `GET /events/stream` | 200 | Backend-local event stream for live observers |

`GET /jobs` accepts optional `projectRoot`, `phase`, `provider`, and `all=1` query filters. Without `all=1`, the list stays live-only (`queued`, `launching`, `running`) and remains sorted by `updatedAt` descending.

Error responses use real HTTP status codes: 400 (validation), 403 (scope mismatch), 404 (not found), 409 (conflict / non-resumable or provider-mismatched session), 503 (recovering / busy).

`POST /kb/sources` accepts `{ filePath, slug?, readiness?, async? }`. It does not accept pre-staged markdown paths from clients. Source conversion, staging, persistence, progress, terminal outcome, and failure causes are coordinator-owned as an internal `kb.source_import` job. `readiness` defaults to `base-search` and may be `commit`, `base-search`, `active-vector`, or `all-equipped`; `async: true` returns 202 with the job id immediately, while the default waits for the requested readiness and returns 201 after the completed import.

`POST /kb/index` rebuilds KB text artifacts through an internal coordinator-owned `kb.reindex` job and waits for base-search readiness before returning. The job is recorded for recovery and observability, but it is not a provider/session job.

## Work Classification

Not every command becomes a job. Jobs are for work that is long-running, observable, resumable, or recovery-relevant. Immediate reads and small mutations remain direct commands.

| Class | Examples | Surface | Rule |
| --- | --- | --- | --- |
| Direct read | `kb search`, `kb read`, `jobs`, `discuss watch` | Return result immediately | No job id; may use `read-model/CoralStore` or KB query helpers. KB list/read paths do not persist derived rebuild artifacts. |
| Direct mutation | KB note write/delete; memo write/delete | Return result after the small write | Corpus writes use the KB mutation lock. Memos are project-scoped scratch artifacts (under `runtime.paths.projectData(projectRoot)` — see design-rationale §5.3), not Corpus authority. |
| Provider/session job | `codex`, `claude`, workflow atoms | Return job id; `wait` observes terminal state | User-facing agent work is Journal-observable and recoverable. |
| Internal coordinator job | `kb source import`, `kb reindex` | Default may wait; `async` returns job id | Used when source conversion, indexing, or readiness can take time. |
| Projection freshness wait | Orama/Needle catch-up after Corpus commit | `ConsumerDriver.waitFreshUntil(...)` | Freshness wait is not itself truth; failure reports against the hosting command/job. |

`kb source import` is job-backed because even without Needle it can spend time reading and converting large documents before committing Corpus markdown. With retrieval readiness, it also waits for Orama or Needle consumers. By contrast, KB search/read, note write, memo operations, and principle reads are direct unless a future implementation gives them durable work to recover. Direct list/read commands may build transient in-memory views, but explicit `kb reindex` owns durable text-artifact repair.

Direct does not mean ambient. CLI/bootstrap adapters choose the active plugin root, build flavor, project root, Corpus markdown root, and KB runtime root before calling KB/read-model code. KB path helpers and `read-model/CoralStore` do not silently fall back to the current working directory or the user's home KB.

## Primary Execution Flows

### Session lifecycle

1. `coral-cli codex -i ...` or `coral-cli codex <agent> -i ...`
2. The CLI client calls `POST /sessions`
3. The transport layer validates the direct body, builds `CallerContext`, and forwards a domain-shaped request into the coordinator
4. The coordinator API resolves agent intent, persists session continuity, and launches or resumes work through jobs-owned launch/admission contracts plus sessions-owned continuity storage
5. Provider adapters spawn the real CLI/runtime and emit progress
6. Journal appends publish projection freshness through the live `ConsumerDriver`; session continuity remains authoritative in the sessions shell

### Wait / follow

1. Detached launches print `Job <job> <launchState> (session <session>)`
2. `coral-cli wait --jobs "<ids>" [--embed]` opens the `jobs.wait` IPC subscription
3. The local IPC stream and the remote `POST /jobs/wait` HTTP gateway both read the same coordinator-owned wait surface, which uses the same job truth as startup recovery and steady-state launch orchestration
4. Terminal text always includes `Result path: <path>`; `--embed` may add preview text, but the durable artifact is always at the printed path

### Job inspection and control

1. `coral-cli jobs [--phase <phase>] [--provider <name>] [--all]` reads `read-model/CoralStore` directly for local no-coordinator paths; the same shape remains available through `GET /jobs` on the HTTP gateway
2. `coral-cli abort --jobs "<ids>"` dispatches `jobs.abort` over IPC for local calls
3. `coral-cli abort --all` or `coral-cli abort --phase <phase> [--provider <name>]` first resolves matching live jobs through the same read surface, then aborts the resulting job IDs

### Workflow

1. `coral-cli workflow ...` posts to `POST /workflow`
2. The workflow domain compiles the DSL into a semantic plan (slot id, dependencies, provider, instruction, optional agent)
3. The executor launches provider or `coral:` atoms through the coordinator API; launch and retry stay intertwined per architecture §10.1a
4. Workflow state is persisted as Journal events with a projection row per workflow; child job identity is derived from `parentWorkflowJobId` + `workflowSlotId`, not stored in the plan; `coral-cli wait` reads the same job store

### Boot Eras

Backend boot is split into three sequential eras so the CLI gets a usable socket as quickly as possible and individual subsystem failures stay isolated.

| Era | Owner | What runs | Lifecycle phase on completion |
| --- | --- | --- | --- |
| I — Kernel | `coordinator/lifecycle.ts` | Bind IPC socket, open Journal, install transport listeners | `kernel-ready` |
| II — Recovery | jobs / discuss / workflow shells | One-shot startup reconciliation for in-flight work | `running` |
| III — Subsystems | `coordinator/subsystems/registry.ts` | Fire-and-forget `initAll()`; each `Subsystem<R>` retries independently and may degrade or self-heal without affecting peers | (per-subsystem `online | degraded | offline`) |

The CLI's fail-fast path watches Era I and II only: `KERNEL_BIND_DEADLINE_MS` (5s) for first health response after spawn, `KERNEL_READY_DEADLINE_MS` (15s) for the daemon to reach the `running` phase. Era III takes whatever time it needs without holding the CLI. `HANDOFF_DRAIN_TIMEOUT_MS` (30s) bounds the incumbent's drain on socket handoff. All three values are constants in `src/transport/ipc/ensure.ts` and `src/coordinator/shutdown.ts`.

KB is the only subsystem in 0.7.1; new long-init subsystems register through `subsystems.register(createXxxSubsystem(...))` in `coordinator/composition/index.ts` and inherit the same retry/error-envelope/`/health` surface.

### Discuss and KB

- `coral-cli discuss ...` maps to resource routes under `/discuss/*`; the discuss domain exposes explicit coordinator-facing owner modules for commands, reads, and recovery rather than a compatibility `api.ts` facade
- `coral-cli kb ...` maps to resource routes under `/kb/*`
- Discuss follows the functional-core / imperative-shell pattern: the core is pure event-sourced state transitions; the shell carries persistence, loop control, and subflows
- KB markdown is the Corpus authority for notes, sources, principles, communities, and wiki entries. Memos are project-scoped scratch artifacts that can be promoted into Corpus notes or wiki entries. Source import and explicit reindex are job-owned by the coordinator because they can be long-running; lightweight KB reads, note mutations, wiki mutations, and memo operations stay direct commands.
- Retrieval projections are CorpusConsumers. Orama is the always-present base retrieval consumer (constructor-time default of the `kb.vector` and `kb.fts` `RuntimeBinding<Backed<T>>` cells); Needle is an Expansion that binds `kb.vector` when equipped. Commands that need retrieval readiness wait through `ConsumerDriver.waitFreshUntil('corpus', snapshot, consumerId)` instead of polling expansion status.

## Module Map

| Area | Role |
| --- | --- |
| CLI | Command parsing, follow mode, text/JSON formatting. |
| Client | Backend startup, IPC requests/subscriptions, remote HTTP gateway/admin helpers, and direct `read-model/CoralStore` read helpers for no-coordinator CLI paths. |
| Coordinator | Process bootstrap, three-era lifecycle (Kernel → Recovery → Subsystems), `Subsystem<R>` registry (`coordinator/subsystems/`), ConsumerDriver freshness, corpus notify, expansion lifecycle (`ExpansionLifecycleService` + `expansion_state`), provider-host coordination, coordinator-owned KB jobs, and cross-domain assembly. `src/coordinator/composition/**` and `src/coordinator/services/**` are explicit coordinator glue and may assemble domain shells/contracts. |
| Transport | IPC + HTTP/SSE request parsing, validation, and wire formatting. Transport depends on domain and coordinator-facing contracts, not on domain shells. |
| Provider execution | Provider adapters, launch orchestration, durable transport, and host/runtime management. Queue and lease mechanics stay below the domain truth surfaces. |
| Jobs | Truth-owning owner for job lifecycle: launch, admission, wait, abort, terminal outcomes, and startup reconciliation. |
| Sessions | Session persistence and continuity, including resume identity and atomic storage. |
| Workflow | DSL compilation and pipeline execution, with launch and retry remaining part of the same ownership seam. |
| Discuss | Functional-core / imperative-shell discussion loop with persistence, bids, speeches, follow-ups, and synthesis. |
| Journal | Event-sourced substrate for append, rebuild, envelope decoding, and projection dispatch. |
| Causality | Cross-stream event-reference vocabulary (`CauseRef`) shared below jobs/sessions/discuss/workflow without store access. |
| Runtime | Single-world Runtime with six I/O subports shared by production and simulation. |
| Simulation | Deterministic doubles for tests. |
| Knowledge base | Corpus markdown authority, search, indexing, memo/source flows, and publication into coordinator-driven CorpusConsumers. |
| Infrastructure | Low-level helpers, settled path resolution, and adapters below domain ownership. Domain upcasters own event body evolution at Journal read boundaries. |

## Ownership Matrix

| Area | Owns truth | May write | May read/compose | Must not own |
| --- | --- | --- | --- | --- |
| `store/` | SQL schema, Journal append/reducer substrate | Store DB primitives and composed validator execution | Domain registries | Product read facade or domain policy |
| `read-model/` | No truth; composed product reads | Nothing authoritative | Domain read queries + KB reads with explicit roots | Writes, recovery, or ambient root selection |
| `jobs/` | Job lifecycle, terminal outcomes, wait/reconcile vocabulary | Job streams/projections through store substrate | Session/workflow refs by typed query/composition | Provider process mechanics or transport |
| `sessions/` | Provider continuity and session scope | Session streams/projections | Provider-owned opaque continuity | Job terminal policy |
| `workflow/` | Semantic plan, slots, dependency shape | Workflow streams/projections | Jobs via coordinator composition | Provider/session persistence |
| `discuss/` | Discuss events, state machine, shell loop | Discuss streams/projections | Provider execution through injected shell seams | Coordinator lifecycle |
| `kb/` | Corpus markdown and KB query semantics | Corpus files under mutation lock | Expansion-bound backends through `KbRuntime` `RuntimeBinding<Backed<T>>` cells | Expansion lifecycle, coordinator startup |
| `coordinator/` | Live state, startup order, expansion lifecycle, cross-domain assembly | Authority writes through domain shells/substrates | Broad domain owner modules/contracts | Domain vocabulary |
| `transport/` | Wire parsing, validation, response mapping | Nothing authoritative | Coordinator ports and domain contracts | Business behavior |
| `cli/` | User command parsing, local startup, activation glue | No domain truth directly | IPC/HTTP clients and read facade | Coordinator lifecycle truth |
| `infra/` / `runtime/` | Low-level path, flavor, I/O ports | Files/process/env through ports | No domain imports | Domain concepts |
| `causality/` | Cross-stream event-reference vocabulary | Nothing authoritative | Domain event/fault models | Store/database access |

## Dependency Sketch

```text
CLI layer
  -> Client layer
      -> Transport IPC/HTTP surface
  -> read-model/CoralStore library reads (read-only no-coordinator commands)

Transport IPC/HTTP surface
  -> Coordinator API + control ports
  -> Domain owner modules/contracts (workflow / discuss / KB / jobs / sessions)

Coordinator glue (`bootstrap.ts` + `composition/**` + `services/**`)
  -> Jobs launch/admission/wait/recovery contracts
  -> Sessions continuity storage and lookup contracts
  -> Workflow / discuss / KB owner modules
  -> Provider adapters + live host management

Coordinator startup
  Era I — Kernel (blocks until lifecycle = 'kernel-ready')
    -> Open Journal
    -> Register Journal projection consumers
    -> Drain freshness to the current Journal head
    -> Bind IPC socket + install transport listeners
  Era II — Recovery (blocks until lifecycle = 'running')
    -> jobs recovery coordinator startup
    -> discuss shell recovery startup
    -> workflowRecover.resumeAll
  Era III — Subsystems (fire-and-forget; CLI no longer blocked)
    -> subsystems.register(createKbSubsystem(...))
    -> subsystems.initAll()
        KB subsystem retry loop (3×1/4/16s):
          -> Absorb KB Corpus edits into text artifacts
          -> Register KB CorpusConsumers
          -> Replay Corpus snapshot, wait for Orama base freshness
          -> phase: online (or degraded/offline)

Discuss shell
  -> Pure discuss core (state machine + reducer)
  -> Journal append via the discuss store-registry

KB runtime
  -> Corpus authority + publication state
  -> Coordinator notify seam
  -> CorpusConsumer freshness / health bridge

Foundation layer
  -> Infra/runtime/causality primitives consumed by higher layers
  -> Domain upcasters own read-time body transforms
```

## Runtime State

| Path | Purpose |
| --- | --- |
| `~/.coral/run/coordinator.json` or `~/.coral/run-dev/coordinator.json` | Active coordinator discovery record |
| `~/.coral/run/coordinator.lock` or `~/.coral/run-dev/coordinator.lock` | Per-flavor singleton coordinator lock |
| `~/.coral/data/store/store.db` or `~/.coral/data-dev/store/store.db` | Journal authority and projection tables |
| `projection_sessions` in `store.db` | Projected provider sessions, continuation profiles, and project `scope_key` |
| `projection_discuss` in `store.db` | Projected discuss snapshots and source-scoped discovery/summary state |
| `~/.coral/exports/jobs/<jobId>/result.md` or `~/.coral/exports-dev/jobs/<jobId>/result.md` | Durable wait/follow result artifact |
| `<os-tmpdir>/coral-jobs/<jobId>/` | Live job scratch artifacts such as stdout/stderr/intermediates |
| `~/.coral/kb/` or `~/.coral/kb-dev/` | Corpus-authoritative markdown KB |
| `~/.coral/data/kb/` or `~/.coral/data-dev/kb/` | KB runtime artifacts: text index state, Orama snapshots, source-import staging, and optional Needle artifacts |

The core architectural boundary is simple: the CLI is the only local command surface, the backend is the only daemon surface, and all long-running or resumable work is tracked as backend jobs.

## Design Rationale

For the **why** behind these structures — the duality of authorities, causal-graph fault model, provider stream composition, the Zelda Expansion philosophy, naming/subdivision policy with rejected anti-patterns — see [`docs/design-rationale.md`](design-rationale.md).

## Rewrite Policy

The rewrite branch is clean-slate. Legacy module paths, compatibility shims, and fallback aliases are not kept for convenience. If an old path no longer represents the owner, it is deleted and guarded by invariants. When implementation reveals a better owner than the document predicted, update the document and code together rather than preserving a transitional layer.

## Terminal Outcome Model

Terminal results carry a typed outcome (`TerminalOutcome`) — a discriminated union owned by the jobs domain:

- `completed` — provider turn finished successfully.
- `aborted { reason }` — closed-token reason: `signal_abort` | `user_abort` | `queue_shutdown`.
- `provider_exit { code, note? }` — provider process terminated with a numeric exit code.
- `failed { causeRef }` — upstream cause resolvable via the Journal (`CauseRef = { stream, seq }`).
- `job_fault { fault }` — typed job-lifecycle fault (ghost launch, wrapper loss, wrapper crash).

Read-time body evolution lives in per-domain upcasters at the Journal boundary. Runtime job ingestion emits canonical domain events directly.
Domain registries own event schemas, append validators, and reducers. `store/` runs composed validators transactionally before insert, but does not hardcode domain vocabulary.
`job.terminal.recorded` stores `{ terminal, diagnostics?, continuity? }`: output and outcome stay under `terminal`, provider warnings/usage stay under `diagnostics`, and session continuity stays in the explicit continuity snapshot.
Raw `job.terminal.recorded` object construction is owned by `jobs/store.ts`; providers, workflows, KB internal jobs, and recovery code finalize through jobs-owned append/materialization APIs.

CLI wait output surfaces the outcome through five exhaustive headers:

```
Job <id> completed
Job <id> aborted: <reason>
Job <id> provider exited <N>[: <note>]
Job <id> failed: <cause description>
Job <id> errored: <sentence> [<kind>]
```

The trailing `[<kind>]` tag on `errored` lines is the machine-readable classifier (regex `/\[(\w+)\]$/`).
