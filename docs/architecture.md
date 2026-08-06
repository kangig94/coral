# Architecture

Coral is a coding-assistant plugin for Claude Code and Codex. Its purpose is to help LLM agents do software work better: plan/review workflows, side-effect and bug discovery, multi-perspective discussion, durable job observation, session continuity, and long-term project memory through KB.

Internally, Coral is a local coding-agent coordination layer. Claude Code reaches Coral through hooks, slash-command skills, and Bash calls to `coral-cli`. For local mutating and live-follow commands, `coral-cli` ensures the backend daemon is running and talks over the authenticated IPC socket. Read-only no-coordinator paths use the `read-model/CoralStore` facade directly. HTTP remains available as the remote gateway plus the operational carveouts (`/health`, `/admin/shutdown`, `/events/stream`). No bridge or stdio proxy remains in the runtime path.

Coral also has a build flavor axis. `prod` is the marketplace-installed runtime and `dev` is a local build meant to coexist with it on the same machine. Each bundle embeds `version`, `buildSetId`, `flavor`, and `storeFormatFingerprint`; the adjacent manifest in the active artifact directory repeats those fields and binds the backend, CLI, and Claude helper by content hash. Ordinary and dev builds use `clients/build/manifest.json`; published release bundles use `clients/bridge/manifest.json`. The embedded identity and adjacent manifest form one matched attestation set. `CORAL_FLAVOR` is only a session-level hook selector that decides which hook set should execute.

## Design Frame

The product frame is coding assistance. The architecture frame is local coordination. "Control plane" in this document is internal vocabulary: the coordinator owns local decisions, live state, recovery sequencing, and capability activation so Claude/Codex do not have to manage those concerns inside prompts or shell glue.

| Product capability                  | Internal owner                              |
| ----------------------------------- | ------------------------------------------- |
| Plan/review workflow                | Workflow plan + jobs execution              |
| Side-effect and bug discovery       | Workflow slots, provider jobs, wait/follow  |
| Idea digging and multi-agent review | Discuss domain and shell                    |
| Long-term coding memory             | KB Corpus authority + retrieval projections |
| Provider conversation continuity    | `ProviderSession` aggregate                 |
| Executable work ownership           | `ExecutionOwner` on every job               |
| Long-running observable work        | Jobs authority                              |
| Optional sharper retrieval          | KB daemon expansion lifecycle               |

This frame constrains new code: first name the truth owner, then decide whether the work is direct, durable, or projection freshness, then compose cross-domain behavior only in the coordinator or CLI.

## Runtime Layout

```text
Claude Code
├── Hooks (`clients/hooks/*.mjs`)
├── Slash-command skills (`clients/skills/*/SKILL.md`)
└── Bash calls to `coral-cli`
      │
      ▼
clients/bridge/coral-cli.cjs
  ├── Provider commands (`codex`, `claude`)
  ├── Workflow commands (`workflow`, `jobs`, `wait`, `abort`)
  ├── Admin commands (`backend status|shutdown`, `backend store-reset list|report|discard`, `backend recovery-quarantine list|clear`, `backend kb-commit quarantine`)
  ├── Discuss commands (`discuss *`)
  └── KB commands (`kb *`)
      │
      ├── IPC (`coordinator.sock`, authenticated) for mutating/live commands
      ├── read-model/CoralStore library reads for no-coordinator `jobs` / `kb` paths
      └── HTTP gateway + carveouts (`127.0.0.1`, authenticated)
            `/health`, `/admin/shutdown`, `/events/stream`
      │
      ▼
clients/bridge/coral-backend.cjs
  ├── Coordinator bootstrap + lifecycle
  ├── IPC + HTTP/SSE transport adapters
  ├── Jobs / sessions / workflow / discuss / KB owner modules and contracts
  ├── Projection-consumer freshness + drain path
  ├── Corpus notify seam for KB publication
  ├── Journal substrate (`node:sqlite`)
  ├── KB runtime + curation scheduler
  └── Optional provider host management
      │
      ├── Codex CLI
      ├── Claude CLI
      └── Claude broker helper (`clients/bridge/coral-claude-appserver.cjs`, when needed)
```

The Claude helper keeps its historical bridge filename. By default it launches `claude -p --input-format stream-json --output-format stream-json` and drives turns over JSONL. Operators can set `CORAL_CLAUDE_TRANSPORT=tui` to use the PTY transport instead; that path launches interactive `claude` through `@lydell/node-pty`, writes turns after terminal readiness, and derives completion/progress from Claude's JSONL transcript.

## Provider Usage Reporting

Usage is captured at each provider boundary before provider-specific stream shapes enter the jobs domain. Providers normalize their raw counters to the canonical additive `UsageSummary`: `{ inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, costUsd }`. Token totals are derived by renderers from the four token buckets and are never stored as `totalTokens`.

The canonical storage home is the job terminal record's `diagnostics.usage` field. In the read model, that lives in `projection_jobs.diagnostics`; live wait, replay wait, SSE reconnect, and job detail all read usage from the same terminal diagnostics instead of recomputing it from provider artifacts.

Provider transports are intentionally asymmetric because Coral records only what the provider reports:

- Claude print (`claude -p` stream-json) reports token usage and `total_cost_usd`, so Coral can render both tokens and `costUsd`.
- Claude TUI reports token usage from the transcript but no cost, so Coral renders tokens only.
- Codex reports tokens only, captured from the native `thread/tokenUsage/updated` notification (`tokenUsage.total`, a cumulative `TokenUsageBreakdown`). Its `cachedInputTokens` are a subset of `inputTokens`, so Coral subtracts cached input before storing fresh `inputTokens` and records cached input as `cacheReadTokens`; Codex has no `costUsd`.

Workflow usage is not written onto `workflow.completed`. It is aggregated at read time by summing child job `diagnostics.usage` rows where `projection_jobs.parent_workflow_job_id` is the workflow job id. Token fields are summed across children, including children that failed after spending tokens. Cost is summed only where present; mixed-provider workflows render partial cost as `$X+` with `(+N jobs without cost data)`.

User-facing usage surfaces are deliberately narrow. `coral-cli wait` appends usage only to terminal completion lines, with `--verbose` expanding the four token buckets. `coral-cli jobs detail <jobId>` renders the terminal diagnostics usage, and workflow detail uses the same read-time aggregate as wait. When cache-read tokens dominate the total, renderers add the honesty annotation `(NN% cached)`; detail uses the fuller cache-read annotation with `billed ~0.1×`.

## Backend HTTP Surface

Resource-oriented API. Sessions and jobs are first-class resources. Each endpoint has its own strict Zod schema. Request bodies are direct JSON — no `{ context, args }` envelope. `pluginRoot` is server-authoritative.

| Route                                         | Status    | Purpose                                                                                                                  |
| --------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `POST /sessions`                              | 201       | Create session (with optional `agent` for coral dispatch)                                                                |
| `POST /workflow`                              | 202       | Workflow launch (camelCase body mapped to snake_case internally)                                                         |
| `POST /coordinator/expansion`                 | 200       | Forward equip to the KB daemon expansion lifecycle                                                                       |
| `DELETE /coordinator/expansion/:name`         | 200       | Forward unequip to the KB daemon expansion lifecycle                                                                     |
| `DELETE /coordinator/expansion/:name/catalog` | 200       | Ask the KB daemon to remove a manifest catalog entry                                                                     |
| `GET /coordinator/expansion`                  | 200       | List expansions from the KB daemon expansion state                                                                       |
| `GET /coordinator/bindings/:binding`          | 200       | Read a single capability binding's current owner and metadata                                                            |
| `POST /coordinator/recovery-quarantine/clear` | 403       | Catalog-projected clear route; HTTP backend-token capabilities exclude its required `system:debug`, so CLI clear uses IPC |
| `GET /jobs` / `GET /jobs/:id`                 | 200       | Job summaries and detailed progress history                                                                              |
| `POST /jobs/abort`                            | 200       | Abort one or more jobs                                                                                                   |
| `POST /jobs/wait`                             | 200       | SSE job monitoring used by `coral-cli wait` and follow mode                                                              |
| `POST /discuss/persona-sets`                  | 200       | Compute discuss persona sets from seed input                                                                             |
| `GET /discuss/sessions`                       | 200       | List discuss sessions                                                                                                    |
| `POST /discuss/sessions`                      | 201       | Create discuss session and start the control loop                                                                        |
| `GET /discuss/sessions/:id`                   | 200       | Read discuss session control or audit detail                                                                             |
| `GET /discuss/sessions/:id/events`            | 200       | Read projected watch events for a discuss session                                                                        |
| `POST /discuss/sessions/:id/bids`             | 200       | Submit a manual bid for a discuss session                                                                                |
| `POST /discuss/sessions/:id/speeches`         | 200       | Submit a manual speech for a discuss session                                                                             |
| `DELETE /discuss/sessions/:id`                | 200       | End a discuss session and detach it from the live registry                                                               |
| `GET /kb/entries`                             | 200       | Search KB entries                                                                                                        |
| `GET /kb/diagnose`                            | 200       | Report curate retry queue and KB daemon runtime diagnostics                                                              |
| `GET /kb/notes/:slug`                         | 200       | Read a note by slug                                                                                                      |
| `GET /kb/memos/:slug`                         | 200       | Read a project-scoped memo by slug                                                                                       |
| `GET /kb/sources/:slug`                       | 200       | Read an imported source by slug                                                                                          |
| `GET /kb/communities/:slug`                   | 200       | Read a community by slug                                                                                                 |
| `GET /kb/principles/:slug`                    | 200       | Read a principle by slug                                                                                                 |
| `POST /kb/notes`                              | 201       | Promote content into a note                                                                                              |
| `PUT /kb/notes/:slug`                         | 200       | Update a note by slug                                                                                                    |
| `DELETE /kb/notes/:slug`                      | 200       | Delete a note by slug                                                                                                    |
| `GET /kb/sources`                             | 200       | List imported KB sources                                                                                                 |
| `POST /kb/sources`                            | 201 / 202 | Start a job-backed KB source import; async requests return 202                                                           |
| `DELETE /kb/sources/:slug`                    | 200       | Delete an imported KB source                                                                                             |
| `GET /kb/memos`                               | 200       | List project-scoped memos                                                                                                |
| `POST /kb/memos`                              | 201       | Create a project-scoped memo                                                                                             |
| `DELETE /kb/memos`                            | 200       | Delete selected memos or purge all project memos                                                                         |
| `GET /kb/principles`                          | 200       | Search KB principles                                                                                                     |
| `GET /kb/wikis`                               | 200       | List wiki entries                                                                                                        |
| `GET /kb/wikis/:slug`                         | 200       | Read a wiki entry by slug                                                                                                |
| `POST /kb/wikis`                              | 201       | Create an empty wiki entry                                                                                               |
| `POST /kb/wikis/:slug/understanding`          | 200       | Replace the Understanding section                                                                                        |
| `POST /kb/wikis/:slug/knowledge`              | 200       | Append refs to the Knowledge section                                                                                     |
| `POST /kb/wikis/:slug/knowledge/unlink`       | 200       | Remove refs from the Knowledge section                                                                                   |
| `POST /kb/wikis/:slug/knowledge/cite`         | 200       | Append an evidence sub-bullet under a Knowledge link                                                                     |
| `POST /kb/wikis/:slug/knowledge/adopt`        | 201       | Promote a memo into a note and link it at the front of Knowledge atomically                                              |
| `DELETE /kb/wikis/:slug`                      | 200       | Delete a wiki entry by slug                                                                                              |
| `GET /kb/wake-up`                             | 200       | Generate the SessionStart wake-up packet                                                                                 |
| `POST /kb/index`                              | 200       | Rebuild KB text artifacts through an internal job                                                                        |
| `GET /health`                                 | 200       | Backend health, namespace, bundle hash, kernel phase, and per-component status (`components[]`, `kernel`, `diagnostics`) |
| `POST /admin/shutdown`                        | 200       | Graceful backend drain and exit                                                                                          |
| `GET /events/stream`                          | 200       | Backend-local event stream for live observers                                                                            |

`GET /jobs` accepts optional `projectRoot`, `phase`, `provider`, and `all=1` query filters. Without `all=1`, the list stays live-only (`queued`, `launching`, `running`) and remains sorted by `updatedAt` descending.

Error responses use real HTTP status codes: 400 (validation), 403 (scope mismatch), 404 (not found), 409 (conflict / non-resumable or provider-mismatched session), 503 (recovering / busy).

Accepted launches use explicit, discriminated identifiers. Provider launches return `{ kind: 'provider-session', jobId, sessionId, launchState }`; workflow launches return `{ kind: 'workflow', jobId, workflowId, launchState }`. Owner, binding, and workflow-lifecycle conflicts are typed 409 responses rather than opaque internal errors.

`POST /kb/sources` accepts `{ filePath, slug?, readiness?, async? }`. It does not accept pre-staged markdown paths from clients. Source conversion, staging, persistence, progress, terminal outcome, and failure causes are coordinator-owned as an internal `kb.source_import` job. `readiness` defaults to `base-search` and may be `commit`, `base-search`, `active-vector`, or `all-equipped`; `async: true` returns 202 with the job id immediately, while the default waits for the requested readiness and returns 201 after the completed import.

`POST /kb/index` rebuilds KB text artifacts through an internal coordinator-owned `kb.reindex` job and waits for base-search readiness before returning. The job is recorded for recovery and observability, but it is not a provider/session job.

## Work Classification

Not every command becomes a job. Jobs are for work that is long-running, observable, resumable, or recovery-relevant. Immediate reads and small mutations remain direct commands.

| Class                     | Examples                                                               | Surface                                                             | Rule                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct read               | `kb read`, `kb principles`, KB metadata lists, `jobs`, `discuss watch` | Return result immediately                                           | No job id; uses `read-model/CoralStore` direct library reads. KB list/read paths do not persist derived rebuild artifacts.                                                             |
| Served read               | `kb search`                                                            | Return result immediately                                           | No job id; routes through IPC to the KB daemon's hot search runtime and never builds a library-direct lexical index.                                                                   |
| Direct mutation           | KB note write/delete; memo write/delete                                | Return result after the small write                                 | Corpus writes use the KB mutation lock. Memos are project-scoped scratch artifacts (under `runtime.paths.projectData(projectRoot)` — see design-rationale §5.3), not Corpus authority. |
| Provider job              | `codex`, `claude`, workflow/discussion children                        | Return job and provider-session ids; `wait` observes terminal state | User-facing provider work is Journal-observable and recoverable.                                                                                                                       |
| Internal coordinator job  | `kb source import`, `kb reindex`                                       | Default may wait; `async` returns job id                            | Used when source conversion, indexing, or readiness can take time.                                                                                                                     |
| Projection freshness wait | Active retrieval-consumer catch-up after Corpus commit                 | `ConsumerDriver.waitFreshUntil(...)`                                | Freshness wait is not itself truth; failure reports against the hosting command/job.                                                                                                   |

Every job has an `ExecutionOwner` independent of provider continuity. A direct provider job is owned by its `ProviderSession`; a workflow root owns itself; workflow children are owned by the workflow; discussion children are owned by the discussion; KB work is owned by a system task. Only provider jobs have a non-null provider-session id. Workflow queued wait events carry `workflowId`, and KB queued events carry `systemTaskId`, instead of fabricating `sessionId: ''`.

`kb source import` is job-backed because it can spend time reading and converting large documents before committing Corpus markdown. With retrieval readiness, it also waits for the applicable active retrieval consumers. By contrast, KB read/list commands, note write, memo operations, and principle reads are direct unless a future implementation gives them durable work to recover. `kb search` is a served read owned by the KB daemon, but it is still not a job. Direct list/read commands may build transient in-memory views, but explicit `kb reindex` owns durable text-artifact repair.

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

1. Detached provider launches print `Provider job <jobId> <launchState> (provider session <sessionId>)`; detached workflows print their `workflowId` and `jobId`
2. `coral-cli wait jobs <id...> [--embed]` opens the `jobs.wait` IPC subscription
3. The local IPC stream and the remote `POST /jobs/wait` HTTP gateway both read the same coordinator-owned wait surface, which uses the same job truth as startup recovery and steady-state launch orchestration
4. Terminal text always includes `Result path: <path>`; `--embed` may add preview text, but the durable artifact is always at the printed path
5. Terminal completion lines append usage when available, for example `Job <id> completed · $4.18 · 18.6M tokens (90% cached)`; `--verbose` expands the input/cache-read/cache-write/output breakdown

### Job inspection and control

1. `coral-cli jobs [--phase <phase>] [--provider <name>] [--all]` reads `read-model/CoralStore` directly for local no-coordinator paths; the same shape remains available through `GET /jobs` on the HTTP gateway
2. `coral-cli jobs detail <jobId>` reads the detailed job projection and renders terminal diagnostics, including usage when present
3. `coral-cli abort jobs <id...>` dispatches `jobs.abort` over IPC for local calls
4. `coral-cli abort --all` or `coral-cli abort --phase <phase> [--provider <name>]` first resolves matching live jobs through the same read surface, then aborts the resulting job IDs

### Generation boundary and operator recovery

1. Pre-boundary state remains under `data[-dev]` and `run[-dev]`; generated state lives under `gen2/data[-dev]` and `gen2/run[-dev]`. Current code never mutates or binds the legacy generation during ordinary startup.
2. Before generated initialization, readiness is one of three states: `generated-ready` proceeds; `no-legacy` initializes; `legacy-ignored` leaves legacy bytes untouched, reports the stored version or `unknown`, and initializes this generation's own state. A previous generation is never a precondition for startup and is never imported: the boundary exists to end that coupling, so whether this build could read the legacy store makes no difference to whether it boots.
3. Before classifying a generated store's bytes by fingerprint plus SemVer, cold start consults the active-store selection record (`active-store-selection.v1.json`). Compatible state opens in place. A selection naming a valid newer local build hands off to that build. Over a `newer-incompatible` store, an absent, malformed, or invalidated selection automatically publishes a V3 incident with `resetPolicyCause: newer-incompatible-invalid-target` and initializes fresh state. Neither selection outcome requires operator action. Ordinary boot likewise automatically publishes a V3 incident and initializes fresh state for `older-incompatible` and `corrupt-or-unsupported` inside the `store.db.reset.lock` critical section. A restart resumes a transition written for the same build. A transition from another build, or one this build cannot read, is preserved as evidence and superseded before selection continues; it is never obeyed as current authority. If startup cannot resolve its running bundle directory, it refuses with `startup_bundle_unresolvable` before entering the selection protocol.
4. `backend store-reset discard --target <current|gen2> --flavor <prod|dev>` remains the explicit offline path for a newer store, but it applies the same selection decision: when a selection names a valid newer local target, the handoff runner replays the operator's invocation against that build so the selected owner performs the discard and the current build does not reset the store. Otherwise the command publishes the same V3 `newer-incompatible-invalid-target` incident as automatic startup and resets. The mutating branch holds the coordinator socket, adoption lock, exclusive maintenance lease after writer leases drain, and reset lock; the active-store coordinator durably publishes its transition record after acquiring the adoption lock and before acquiring the reset lock. Under the reset lock it creates and verifies a private `.staging/<uuid>/` transaction, publishes the exact-build manifest, removes only matching active evidence, publishes `<uuid>/`, and initializes an empty current store. Automatic-reset manifests use schema V3 with a required closed `resetPolicyCause` (`older-incompatible | corrupt-or-unsupported | newer-incompatible-invalid-target`); startup authors all three values, with the third produced by the active-store selection protocol's invalid-target classification. An interrupted automatic reset resumes only for a self-authored V3 manifest from the same validated authority, canonical store, and flavor with a resettable cause. V2 remains readable for diagnostics but never auto-resumes. Startup reports ambiguous staging as `store_reset_interrupted_ambiguous`, foreign entries as `store_reset_interrupted_foreign`, manifest/publication identity disagreement as `store_reset_interrupted_mismatched`, a different build/store/flavor authority as `store_reset_interrupted_authority_mismatch`, malformed evidence as `store_reset_interrupted_malformed`, and V2 or otherwise non-resettable evidence as `store_reset_interrupted_non_resettable`. Unexpected quarantine I/O and missing classified evidence retain the catch-all `store_reset_quarantine_failed`. Every refusal leaves the evidence operator-visible. `--target legacy` always refuses before path resolution or socket binding.
5. `backend store-reset list --target <legacy|current>` performs a bounded local directory read. `backend store-reset report --target <legacy|current> <incident-id>` validates containment and descriptor identity, recomputes bounded hashes, optionally diagnoses a private SQLite copy, and renders deterministic public-safe Markdown. Retained evidence is diagnostic-only and cannot restore active state.
6. `backend kb-commit quarantine --flavor <prod|dev> --commit <id>` is the explicit recovery for a `kb_commit_corrupt_or_unsupported` refusal. After `backend shutdown`, it holds the same socket → adoption → maintenance boundary, validates the single-segment commit ID before acquisition, and durably moves only that commit and matching index evidence to retained quarantine.

### Workflow

1. `coral-cli workflow ...` posts to `POST /workflow`
2. The workflow domain compiles the DSL into a semantic plan (slot id, dependencies, provider, instruction, optional agent)
3. The executor launches provider or `coral:` atoms through the coordinator API; launch and retry stay intertwined per architecture §10.1a
4. Workflow state is persisted as Journal events with a projection row per workflow; child job identity is derived from `parentWorkflowJobId` + `workflowSlotId`, not stored in the plan; `coral-cli wait` reads the same job store
5. Workflow usage is resolved from child job terminal diagnostics at read time, not stored on the workflow terminal event

### Boot Eras

Backend boot is split into three sequential eras so the CLI gets a usable socket as quickly as possible and individual component failures stay isolated.

| Era                             | Owner                                        | What runs                                                                                                            | Lifecycle phase on completion |
| ------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------- | --------- |
| I — Kernel                      | `coordinator/lifecycle.ts`                   | Bind IPC socket, open Journal, install transport listeners                                                           | `kernel-ready`                |
| II — Recovery                   | jobs / discuss / workflow shells             | One-shot startup reconciliation for in-flight work                                                                   | `running`                     |
| III — Runtime Health Components | `coordinator/runtime-components/registry.ts` | Fire-and-forget `initAll()`; each `RuntimeComponent` projects daemon-visible health without blocking the kernel path | (per-component `online        | degraded | offline`) |

The CLI's fail-fast path watches Era I and II only: `KERNEL_BIND_DEADLINE_MS` (5s) for first health response after spawn, `KERNEL_READY_DEADLINE_MS` (15s) for the daemon to reach the `running` phase. Era III takes whatever time it needs without holding the CLI. `HANDOFF_DRAIN_TIMEOUT_MS` (30s) bounds the incumbent's drain on socket handoff. All three values are constants in `src/transport/ipc/ensure.ts` and `src/coordinator/shutdown.ts`.

#### Child Lifecycle Confinement

Coordinator lifecycle authority belongs to top-level invocations only. `ensure()` probes the socket, then routes any child-shaped invocation — `CORAL_CHILD=1`, or any non-empty `CORAL_CHILD_PRINCIPAL_HANDLE` / `CORAL_JOB_ID` / `CORAL_SESSION_ID`, so partial bindings fail closed — into an existing-only branch before it computes desired bundle identity. That branch may read discovery and poll health, and it may never request shutdown, wait for socket release, spawn `coral-backend`, clear a startup sentinel, or rotate coordinator logs. `shutdownBackend()` and `shutdownAndAwaitRelease()` (the lazy KB re-enable restart) carry the same guard independently, so explicit and implicit restarts are both refused.

A child reuses only the exact incumbent it first observed. Bundle compatibility is deliberately ignored, because the child's credential lives solely in that parent's in-memory registry, so a bundle mismatch must reconnect rather than hand off. The read-only readiness loop pins socket path, instance ID, version, bundle hash, flavor, namespace, and — when both observations report them — PID and process start time. A draining or unreachable parent, an identity replacement, discovery that does not match the observed parent, or a timeout fails closed with top-level recovery guidance; the child never follows a replacement. The reused client carries no boot credential, so the nested command is still authorized by normal child-principal capability rules (see [CLI Errors](./cli-errors.md#nested-coral-commands)).

KB is not hosted as a coordinator component. The parent daemon registers only `createKbDaemonHealthComponent(kbDaemonSupervisor)`, which mirrors KB daemon health into `/health.components[]`; the KB daemon process owns KB runtime boot, Corpus replay, CorpusConsumer registration, Orama freshness, curate work, and expansion lifecycle. With `CORAL_KB_ENABLE=0`, the parent wires a disabled KB daemon supervisor so the health component reports terminal `offline` without spawning the KB daemon.

#### KB Daemon Protocol

Parent and child speak a newline-framed JSON protocol over the child's stdio (vocabulary owned by `kb-daemon/protocol.ts`; non-control stdout lines are ignored, stderr is buffered for diagnostics):

- **Child → parent**: `coral.kb_daemon.ready` (one-time readiness with pid/readyAt), `coral.kb_daemon.response` (correlated reply to a parent request), and `coral.kb_daemon.event` (journal/corpus events the parent ingests into the ConsumerDriver and lifecycle reactor).
- **Parent → child**: `coral.kb_daemon.request` carries KB reads, mutations, expansion RPC, job abort/list, and `shutdown`. Request ids are generation-scoped (`${generation}:${seq}`) so a reply from a previous daemon generation can never settle a current request.
- **Reverse channel (child → parent → child)**: `coral.kb_daemon.parent_request` / `coral.kb_daemon.parent_response` let the daemon call back into the parent for `curate.assistant.complete` and `curate.assistant.cancel`, since the provider host that runs the curate assistant lives in the parent.
- **Liveness**: the child runs a parent-PID watchdog (`DEFAULT_PARENT_WATCHDOG_INTERVAL_MS`, 1s) and self-terminates if the parent exits; the parent escalates a stuck child SIGTERM→SIGKILL via `gracefulKill` on start-timeout and stop.

### Discuss and KB

- `coral-cli discuss ...` maps to resource routes under `/discuss/*`; the discuss domain exposes explicit coordinator-facing owner modules for commands, reads, and recovery rather than a compatibility `api.ts` facade
- `coral-cli kb ...` maps to resource routes under `/kb/*`
- Discuss follows the functional-core / imperative-shell pattern: the core is pure event-sourced state transitions; the shell carries persistence, loop control, and subflows
- KB markdown is the Corpus authority for notes, sources, principles, communities, and wiki entries. Memos are project-scoped scratch artifacts that can be promoted into Corpus notes or wiki entries. Source import and explicit reindex are job-owned by the coordinator because they can be long-running; lightweight KB reads, note mutations, wiki mutations, and memo operations stay direct commands.
- KB markdown syncs across machines through git. Custom merge drivers make derivative files converge where possible (`.entity-graph.json`, note/source/community frontmatter), while tracked provenance (`inputFingerprint` and `summaryInputFingerprint`) lets a peer skip LLM work already computed for the current content.
- Retrieval projections are CorpusConsumers. The `kb.fts`, `kb.vector`, and `kb.embedding` `RuntimeBinding<Backed<T>>` cells are constructed empty; bundled Orama binds `kb.fts` during expansion lifecycle startup, while installed Gemini and ONNX engines can bind `kb.embedding`. No current first-party package fills `kb.vector`; external engines may do so through the same capability contract. Commands that need retrieval readiness wait through `ConsumerDriver.waitFreshUntil('corpus', snapshot, consumerId)` instead of polling expansion status.

## Module Map

| Area                 | Role                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI                  | Command parsing, follow mode, text/JSON formatting.                                                                                                                                                                                                                                                                                                                                                                              |
| Client               | Backend startup, IPC requests/subscriptions, remote HTTP gateway/admin helpers, and direct `read-model/CoralStore` read helpers for no-coordinator CLI paths.                                                                                                                                                                                                                                                                    |
| Projection consumers | ConsumerDriver cursor persistence, apply scheduling, freshness waits, and drain/shutdown semantics shared by coordinator and KB daemon.                                                                                                                                                                                                                                                                                          |
| Coordinator          | Process bootstrap, three-era lifecycle (Kernel → Recovery → Runtime Health Components), `RuntimeComponent` registry (`coordinator/runtime-components/`), projection-consumer wiring, corpus notify, provider-host coordination, coordinator-owned KB jobs, and cross-domain assembly. `src/coordinator/composition/**` and `src/coordinator/services/**` are explicit coordinator glue and may assemble domain shells/contracts. |
| Provider proxy       | Control protocol vocabulary, per-role bootstrap capsule, control endpoint and client, shared control-lease round-trip evidence, the armed enforcement loop, the argv dispatch and process entry point shared by all three roles, and the three role processes — guardian, reaper, and the proxy that owns the operation ledger and its protocol surface — plus the handoff-grant registry, for provider processes that must outlive a coordinator handoff. The domain spawns its own peer roles: `role-spawn.ts`'s `spawnRoleProcess` launches one role from the existing backend artifact, and the guardian's own entry point calls it twice, first for the reaper and then for the proxy. It does not spawn the guardian itself — that stays with the coordinator (`src/coordinator/live/provider-proxy-acquisition-steps.ts`), because the guardian is the only party that watches the proxy's process group come into being and can observe the identity of what it spawned, which is the same reason it is the only party allowed to name that containment to the reaper. Owns no coordinator wiring and no provider-adapter dispatch; opens no store and binds no coordinator socket. No coordinator or provider path constructs a set yet. |
| Transport            | IPC + HTTP/SSE request parsing, validation, and wire formatting. Transport depends on domain and coordinator-facing contracts, not on domain shells.                                                                                                                                                                                                                                                                             |
| Provider execution   | Provider adapters, launch orchestration, durable transport, and host/runtime management. Queue and lease mechanics stay below the domain truth surfaces.                                                                                                                                                                                                                                                                         |
| Jobs                 | Truth-owning owner for job lifecycle: launch, admission, wait, abort, terminal outcomes, and startup reconciliation, plus the durable `provider_operation.v1:<jobId>:<operationId>` runtime-meta locator codec and the single transactional seam that turns a proxy-reported provider event into durable job/session effects.                                                                                                 |
| Sessions             | Session persistence and continuity, including resume identity and atomic storage.                                                                                                                                                                                                                                                                                                                                                |
| Workflow             | DSL compilation and pipeline execution, with launch and retry remaining part of the same ownership seam.                                                                                                                                                                                                                                                                                                                         |
| Discuss              | Functional-core / imperative-shell discussion loop with persistence, bids, speeches, follow-ups, and synthesis.                                                                                                                                                                                                                                                                                                                  |
| Journal              | Event-sourced substrate for append, rebuild, envelope decoding, and projection dispatch.                                                                                                                                                                                                                                                                                                                                         |
| Causality            | Cross-stream event-reference vocabulary (`CauseRef`) shared below jobs/sessions/discuss/workflow without store access.                                                                                                                                                                                                                                                                                                           |
| Recovery             | Single recovery-enumeration boundary, opaque source handles, source registry, and quarantine persistence. Raw sources and settlement policy remain domain-owned.                                                                                                                                                                                                                                                                 |
| Runtime              | Single-world Runtime with six I/O subports shared by production and simulation.                                                                                                                                                                                                                                                                                                                                                  |
| Simulation           | Deterministic doubles for tests.                                                                                                                                                                                                                                                                                                                                                                                                 |
| Knowledge base       | Corpus markdown authority, search, indexing, memo/source flows, and publication into coordinator-driven CorpusConsumers.                                                                                                                                                                                                                                                                                                         |
| Infrastructure       | Low-level helpers, settled path resolution, and adapters below domain ownership. Domain registries own strict current event codecs; no upcaster or legacy reader exists.                                                                                                                                                                                                                                                         |

## Ownership Matrix

| Area                                                    | Owns truth                                                              | May write                                            | May read/compose                                            | Must not own                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| `store/`                                                | SQL schema, Journal append/reducer substrate                            | Store DB primitives and composed validator execution | Domain registries                                           | Product read facade or domain policy           |
| `read-model/`                                           | No truth; composed product reads                                        | Nothing authoritative                                | Domain read queries + KB reads with explicit roots          | Writes, recovery, or ambient root selection    |
| `jobs/`                                                 | Job lifecycle, terminal outcomes, wait/reconcile vocabulary, and the provider-event application seam | Job streams/projections through store substrate      | Session/workflow refs by typed query/composition            | Provider process mechanics or transport        |
| `sessions/`                                             | Provider conversation continuity and strict binding                     | `ProviderSession` streams/projections                | Provider-owned opaque continuity                            | Workflow/discussion lifecycle or job ownership |
| `workflow/`                                             | Semantic plan, slots, dependency shape                                  | Workflow streams/projections                         | Jobs via coordinator composition                            | Provider/session persistence                   |
| `discuss/`                                              | Discuss events, state machine, shell loop                               | Discuss streams/projections                          | Provider execution through injected shell seams             | Coordinator lifecycle                          |
| `kb/`                                                   | Corpus markdown and KB query semantics                                  | Corpus files under mutation lock                     | `KbRuntime` contracts and `RuntimeBinding<Backed<T>>` cells | Expansion lifecycle or process supervision     |
| `provider-proxy/`                                       | Control protocol vocabulary, per-role bootstrap capsules, and each role's own argv dispatch/entry point | Its own bootstrap capsules, control endpoints, and — from the guardian only — its spawned reaper and proxy peers | The existing backend artifact, re-invoked to spawn a peer role | Coordinator wiring, provider-adapter dispatch, the store, or the coordinator socket |
| `projection-consumers/`                                 | Consumer cursor/freshness coordination                                  | Consumer cursor rows                                 | Store consumer contracts and KB Corpus snapshots            | Process lifecycle or domain truth              |
| `coordinator/live/kb-daemon-supervisor.ts`              | KB daemon process supervision and control-protocol proxy                | KB daemon process lifecycle                          | KB daemon protocol                                          | KB runtime ownership                           |
| `coordinator/live/provider-proxy-authority.ts`          | The release contract shutdown holds over live guardian/reaper/proxy sets | Nothing authoritative                                | Set handles produced by acquisition                         | Set acquisition or spawning                    |
| `coordinator/live/provider-proxy-acquisition.ts`        | One set acquisition attempt and the unwind of exactly what it created   | Nothing authoritative                                | Injected create/spawn/establish steps                       | The concrete steps themselves                  |
| `coordinator/live/provider-proxy-acquisition-steps.ts`  | The concrete create/spawn/establish steps for one set: capsule minting, guardian spawn, and control handshake | Nothing authoritative | Provider-proxy role-spawn, bootstrap-capsule, and control-protocol primitives | Set-level unwind ordering or the release contract |
| `coordinator/runtime-components/kb-health-component.ts` | Parent-side health mirror for KB daemon                                 | Nothing authoritative                                | KB daemon supervisor health                                 | KB runtime ownership                           |
| `coordinator/`                                          | Live state, startup order, KB daemon supervision, cross-domain assembly | Authority writes through domain shells/substrates    | Broad domain owner modules/contracts                        | Domain vocabulary or KB runtime ownership      |
| `transport/`                                            | Wire parsing, validation, response mapping                              | Nothing authoritative                                | Coordinator ports and domain contracts                      | Business behavior                              |
| `cli/`                                                  | User command parsing, local startup, activation glue                    | No domain truth directly                             | IPC/HTTP clients and read facade                            | Coordinator lifecycle truth                    |
| `infra/` / `runtime/`                                   | Low-level path, flavor, I/O ports                                       | Files/process/env through ports                      | No domain imports                                           | Domain concepts                                |
| `causality/`                                            | Cross-stream event-reference vocabulary                                 | Nothing authoritative                                | Domain event/fault models                                   | Store/database access                          |
| `recovery/`                                             | Single recovery-enumeration boundary, opaque source handles, quarantine persistence | `recovery_quarantine` through its store port          | Domain-owned source factories and policies                  | Domain settlement or registry/pool knowledge   |

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

Domain-owned recovery sources and settlement policies
  -> recovery/ RecoveryContainment.each(source, policy)
      -> scan -> hydrate -> settle
      -> recovery_quarantine convergence

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
  Era III — Runtime Components (fire-and-forget; CLI no longer blocked)
    -> createKbDaemonHealthComponent(kbDaemonSupervisor)
       (CORAL_KB_ENABLE=0 uses a disabled supervisor: terminal offline, no KB daemon spawn)
       -> components.initAll()
        KB health component mirrors daemon health; enabled KB daemon boot owns:
          -> Corpus replay and pending publication retry
          -> CorpusConsumer registration and Orama base freshness
          -> Curate scheduler, source import/reindex services
          -> Expansion lifecycle recovery

Discuss shell
  -> Pure discuss core (state machine + reducer)
  -> Journal append via the discuss store-registry

KB runtime
  -> Corpus authority + publication state
  -> Coordinator notify seam
  -> CorpusConsumer freshness / health bridge

Foundation layer
  -> Infra/runtime/causality primitives consumed by higher layers
  -> Store-format split: older/corrupt state resets automatically under the reset lock; newer state keeps the typed operator-recovery refusal
```

## Runtime State

| Path                                                                                       | Purpose                                                                                                          |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `~/.coral/gen2/run/coordinator.json` or `~/.coral/gen2/run-dev/coordinator.json`            | Active coordinator discovery record                                                                              |
| `~/.coral/gen2/run/coordinator.lock` or `~/.coral/gen2/run-dev/coordinator.lock`            | Per-flavor singleton coordinator lock                                                                            |
| `~/.coral/gen2/data/store/store.db` or `~/.coral/gen2/data-dev/store/store.db`              | Journal authority and projection tables                                                                          |
| `~/.coral/gen2/data/store/store-reset-quarantine/.staging/` (or the `data-dev` equivalent) | Private bounded reset transaction area; copied evidence and manifest are durable before active files are removed |
| `~/.coral/gen2/data/store/store-reset-quarantine/<uuid>/` (or the `data-dev` equivalent)   | Indefinitely retained current-build reset evidence; support-only, never restored as active state                 |
| `projection_sessions` in `store.db`                                                        | Projected provider sessions, continuation profiles, and project `scope_key`                                      |
| `projection_discuss` in `store.db`                                                         | Projected discuss snapshots and source-scoped discovery/summary state                                            |
| `recovery_quarantine` in `store.db`                                                        | Exact recovery failures and continuations retained for convergence or one-coordinate retry                        |
| `~/.coral/exports/jobs/<jobId>/result.md` or `~/.coral/exports-dev/jobs/<jobId>/result.md` | Durable wait/follow result artifact                                                                              |
| `<os-tmpdir>/coral-jobs/<jobId>/`                                                          | Live job scratch artifacts such as stdout/stderr/intermediates                                                   |
| `~/.coral/kb/` or `~/.coral/kb-dev/`                                                       | Corpus-authoritative markdown KB                                                                                 |
| `~/.coral/gen2/data/kb/` or `~/.coral/gen2/data-dev/kb/`                                   | KB runtime artifacts: text index state, Orama snapshots, source-import staging, and installed-engine projections |

Daemon-owned state is account-neutral. The `store`, `coordinator`, `exports`, `engine`, `projects`, and KB runtime families use one canonical tree per flavor; `CODEX_HOME` and `CLAUDE_CONFIG_DIR` never participate in path composition. Account selection crosses the transport boundary as validated request context. A real `ProviderSession` stores the immutable binding for one provider conversation; workflow and discussion roots persist the complete provider scope used to create future children. Recovery rehydrates those durable values and never lets the daemon boot environment choose later requests. See design-rationale §5.4.

The core architectural boundary is simple: the CLI is the only local command surface, the backend is the only daemon surface, and all long-running or resumable work is tracked as backend jobs.

Store-reset operation and reporting are deliberate local carveouts for times when the daemon refuses to boot. The destructive service lives in `src/store/operator-store-reset.ts`; the CLI only validates flags, supplies current runtime/build identity, and renders the result. `backend store-reset list|report` does not call daemon discovery, `ensure()`, IPC, HTTP, or the active-store opener; it validates the executing CLI against its adjacent build manifest and traverses quarantine through a narrow read-only filesystem port. The public renderer accepts only a branded allowlisted projection. SQLite diagnosis copies verified DB/WAL/SHM evidence to a private temp directory and supervises a fixed read-only child protocol; active and quarantined files are never opened by SQLite.

Ordinary builds generate one build-set UUID and one store-format fingerprint embedded across the backend, CLI, and Claude helper, then write the authoritative adjacent `clients/build/manifest.json` with hashes for all three artifacts. Releases copy every artifact byte-for-byte into `clients/bridge`; they do not regenerate identity. Hidden package probes and the build/release contract verifiers execute all three artifacts against that manifest, verify all three artifact hashes, require byte equality between build and release copies, and enforce the package file allowlist.

## Design Rationale

For the **why** behind these structures — the duality of authorities, causal-graph fault model, provider stream composition, the Zelda Expansion philosophy, naming/subdivision policy with rejected anti-patterns — see [`docs/design-rationale.md`](design-rationale.md).

## Rewrite Policy

The rewrite branch is clean-slate. Retired module paths, compatibility shims, and fallback aliases are not kept for convenience. If an old path no longer represents the owner, it is deleted and guarded by invariants. When implementation reveals a better owner than the document predicted, update the document and code together rather than preserving a transitional layer.

## Terminal Outcome Model

Terminal results carry a typed outcome (`TerminalOutcome`) — a discriminated union owned by the jobs domain:

- `completed` — provider turn finished successfully.
- `aborted { reason }` — closed-token reason: `signal_abort` | `user_abort` | `queue_shutdown`.
- `provider_exit { code, note? }` — provider process terminated with a numeric exit code.
- `failed { causeRef }` — upstream cause resolvable via the Journal (`CauseRef = { stream, seq }`).
- `job_fault { fault }` — typed job-lifecycle fault (ghost launch, wrapper loss, wrapper crash).

Journal reads use only the strict current domain codecs. Runtime job ingestion emits canonical domain events directly; incompatible persisted shapes change the application-wide store fingerprint and trigger destructive reset rather than translation.
Domain registries own event schemas, append validators, and reducers. `store/` runs composed validators transactionally before insert, but does not hardcode domain vocabulary.
`job.terminal.recorded` stores `{ terminal, diagnostics?, continuity? }`: output and outcome stay under `terminal`, provider warnings and canonical `diagnostics.usage` stay under `diagnostics`, and session continuity stays in the explicit continuity snapshot. `diagnostics.usage` is the durable home for provider usage; renderers derive total token counts from its additive buckets instead of storing a separate total.
Raw `job.terminal.recorded` object construction is owned by `jobs/store.ts`; providers, workflows, KB internal jobs, and recovery code finalize through jobs-owned append/materialization APIs.

CLI wait output surfaces the outcome through five exhaustive headers, followed by a usage segment when terminal diagnostics carry usage:

```
Job <id> completed
Job <id> aborted: <reason>
Job <id> provider exited <N>[: <note>]
Job <id> failed: <cause description>
Job <id> errored: <sentence> [<kind>]
```

The trailing `[<kind>]` tag on `errored` lines is the machine-readable classifier (regex `/\[(\w+)\]$/`).
