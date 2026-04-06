# Architecture

## System Structure

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Claude Code                                                              │
│                                                                           │
│  ┌──────────────┐  ┌───────────────┐  ┌────────────────────────────────┐  │
│  │ SessionStart │  │ Hook Events   │  │  Skills /coral:*               │  │
│  │ Hooks        │  │ (plan/kb/idle │  │  discuss, codex, plan,         │  │
│  │ (INJECT.md   │  │  management)  │  │  ralph, analyze, ...           │  │
│  │  injection,  │  │               │  └───────────────┬────────────────┘  │
│  │  backend     │  └───────┬───────┘                  │                   │
│  │  warm-start) │          │                ┌─────────┴──────────┐        │
│  └──────────────┘          │                ▼                    │        │
│                            ▼                                     │        │
│  ┌─────────────────────────────────────────────────────────────┐ │        │
│  │ MCP Server "ax" (bridge/coral-ax.cjs)                       │ │        │
│  │                                                             │ │        │
│  │ Tools: codex + claude + kb_* + discuss_* + wait + abort +   │ │        │
│  │        workflow + backend                                   │ │        │
│  │ codex/claude: exec/list/fork + coral:<name> dispatch        │ │        │
│  │ discuss_*: backend-managed discuss lifecycle tools          │ │        │
│  │ wait/abort/workflow/backend: proxy or bridge-local helpers  │ │        │
│  │                                                             │ │        │
│  │ Thin MCP stdio proxy -> HTTP backend daemon                 │ │        │
│  └──────────────────────────────┬──────────────────────────────┘ │        │
│                                                                  │        │
│  ┌─────────────────────────────────────────────────────────────┐ │        │
│  │ CLI (bridge/coral-cli.cjs) — parallel Bash-tool client      │ │        │
│  │ node bridge/coral-cli.cjs ...  or  coral-cli ... (hook)     │ │        │
│  │ Subcommands: codex, claude, wait, abort, workflow,          │ │        │
│  │              backend status|shutdown, discuss (all ops)     │ │        │
│  │ Uses BackendClient + streamWait/lifecycle bridge helpers    │ │        │
│  └──────────────────────────────┬──────────────────────────────┘ │        │
│                                 │                                │        │
│  Persisted discuss data: ~/.coral/projects/{slug}/discuss/       │        │
│    discovery.json + summary-index.json + <session-id>/...        │        │
│                                 │                                │        │
│                                 │                                │        │
│                                 │                                │        │
│                                 │                                │        │
│                                 │                                │        │
│                                 │                                │        │
│                                 │                                │        │
│                                 │                                │        │
└─────────────────┼─────────────────────────────────────────────────────────┘
                  │ HTTP (127.0.0.1, ephemeral port)
                  ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  Backend Daemon (bridge/coral-backend.cjs)                                │
│                                                                           │
│  Persistent HTTP server, singleton per machine                            │
│  ├── Singleton lock    (~/.claude/coral/backend.lock)                     │
│  ├── Connection info   (~/.claude/coral/backend.json)                     │
│  ├── Idle auto-shutdown (CORAL_BACKEND_IDLE_MS, default 6h)               │
│  ├── Job storage       (<os-tmpdir>/coral-jobs/<jobId>/)                  │
│  ├── Session storage   (~/.claude/coral/sessions/)                        │
│  ├── Discuss storage   ~/.coral/projects/{slug}/discuss/                  │
│  └── Routes:                                                              │
│      GET  /health         → version, instanceId, uptime                   │
│      GET  /tools          → tool descriptors for MCP ListTools            │
│      POST /tool           → routeToolCall() → ExecutionService            │
│      POST /wait/stream    → SSE progress/terminal/timeout events          │
│      GET  /api/discuss    → persisted/live discuss summaries              │
│      GET  /api/discuss/detail → projected control or audit detail         │
│      POST /admin/shutdown → graceful drain + exit                         │
│                                                                           │
│  ExecutionService → Provider.execute() → CLI spawn                        │
└───────────────────────────────────────────────────────────────────────────┘
                  │
        ┌─────────┴──────────┐
        ▼                    ▼
┌──────────────────────┐   ┌────────────────────────┐
│  Codex CLI (v0.104+) │   │  Claude CLI            │
│  codex exec --json   │   │  claude -p             │
│  --full-auto         │   │  --output-format json  │
│  JSONL event stream  │   │  JSON object output    │
└──────────────────────┘   └────────────────────────┘
```

## AX Internal Dispatch

How the AX MCP server routes tool calls internally. The MCP stdio proxy (`src/bridge/server.ts`) forwards all non-wait calls to the backend daemon via HTTP. The backend's `routeToolCall()` function is the top-level router: provider lookup, optional coral dispatch, then provider execution.

### MCP Proxy Layer

```
┌──────────────────────────────────────────────────────────────────┐
│  Claude Code (Host)                                              │
│  MCP tool call: codex / claude / wait / abort / workflow         │
└─────────────────────────────┬────────────────────────────────────┘
                              │ stdio (JSON-RPC)
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  src/bridge/server.ts — MCP stdio proxy (composition root)       │
│                                                                  │
│  name === "wait"    ? → streamWait() via POST /wait/stream (SSE) │
│  name === "backend" ? → handleBackendToolCall() (bridge-local)   │
│  otherwise          → proxyToolCall() via POST /tool             │
└─────────────────────────────┬────────────────────────────────────┘
                              │ HTTP (127.0.0.1)
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  execution/server.ts — Backend daemon                            │
│                                                                  │
│  POST /tool → routeToolCall(request, helpers)                    │
│                                                                  │
│  name === "abort"    → helpers.abortJobs(jobIds)                 │
│  name === "workflow" → handleWorkflow() via ExecutionService     │
│  provider in registry? YES → ExecutionService.{start,resume,...} │
│                        NO  → 404 unknown tool                    │
└──────────────────────────────────────────────────────────────────┘
```

### Provider Tools (`codex`, `claude`, and future providers)

```
<provider>({ op, ... })
        │
        ▼
execution/server.ts routeToolCall()
        │
        ├─ getNewProvider(name) from providers/registry.ts
        ├─ op starts with "coral:" ?
        │   YES → ExecutionService.coralDispatch()
        │         ├─ resolveCoralContent(name) from execution/resolver.ts
        │         ├─ buildCoralInstruction() from execution/instruction.ts
        │         └─ routes to start() or resume() with instruction injected
        │
        │   NO  → ExecutionService.{start,resume,fork,list}()
        │
        ▼
provider adapter (`providers/<name>/adapter.ts`)
        │
        ├─ action === "exec"   → spawn CLI (background)
        ├─ action === "resume" → spawn CLI with conversationRef
        ├─ action === "fork"   → spawn CLI forking from conversationRef
        └─ (list handled by ExecutionService directly)
```

`coral:` resolution is centralized in `execution/resolver.ts`; provider adapters only implement provider-specific injection:
- Codex: prepends coral content to prompt with `\n\n---\n\n`, forces `bypass: true`
- Claude: uses coral content as `--append-system-prompt`, forces `bypass: true`

### `wait` Tool

```
wait({ jobs: [jobId1, jobId2], timeout_seconds, cursor })
        │
        ▼
src/bridge/server.ts (MCP proxy)
        │
        ├─ ensureBackend() → get port/token
        └─ streamWait(jobIds, timeout, backendInfo, cursor)
            │
            ▼
        POST /wait/stream (SSE)
            │
            ▼
execution/server.ts handleWaitStream()
        │
        └─ ExecutionService.waitStream(request)
            │
            ├─ poll loop (500ms interval):
            │   ├─ progressStore.replayFrom(jobId, cursor) → progress events
            │   ├─ check for terminal events (completed/error/aborted)
            │   └─ check timeout
            └─ yield SSE events: progress / terminal / timeout
                │
                ▼
src/bridge/server.ts parseSseBlock() → MCP progress notifications
```

Provider-agnostic: monitors any job regardless of whether it was launched by codex or claude. Completed terminal results always include `result.path`; `result.content` is optional enrichment when the serialized response fits within the inline budget. Workflow callers should use `result.content ?? Read(result.path)`. Provider callers should prefer `result.content` and treat `result.path` as a best-effort recovery artifact when content is absent.

### `workflow` Tool

```
workflow({ expression: "(architect, critic) -> resolver", start_prompt, provider })
        │
        ▼
handleWorkflow()                              workflow/handler.ts
        │
        ├─ parseExpression(expression) → AST: PipeAtom[][]
        ├─ normalizeAst(ast, defaultProvider)
        ├─ validateNamespaces / validateParallelDuplicates
        └─ ExecutionService.executeWorkflow(ast, input, ctx)
                │
                ▼
        executePipeline(ast, start_prompt, providerName, service, ctx, ...)
                │
                ▼
        For each step:
        ├─ Parallel atoms → launchAtomWithRetry()
        │   ├─ AgentAtom:  service.coralDispatch(provider, coralName, ...)
        │   └─ PromptAtom: service.start(provider, { prompt, instruction })
        │                       ↓
        │               Re-enters ExecutionService (recursive)
        ├─ waitForAllAtoms:
        │   ├─ forward atom progress ("atom <agent>: <message>") into workflow progress stream
        │   ├─ detect stale atoms (no activity for 900s default timeout)
        │   └─ abort + resume stale atoms (max 2 retries) before failing workflow
        └─ Format XML output → pass as next step's prompt
```

### Summary: End-to-End Flow

```
                    ┌──────────────┐
                    │  MCP Client  │
                    └──────┬───────┘
                           │ stdio (JSON-RPC)
              ┌────────────┼─────────────┬──────────┬──────────┐
              ▼            ▼             ▼          ▼          ▼          ▼
          "codex"      "claude"       "wait"    "abort"   "workflow" "backend"
              │            │             │          │          │          │
              └────────┬───┘             │          │          │          │
                       │                 │          │          │          │
         src/bridge/server.ts (MCP proxy)│          │          │          │
              │                          │          │          │ (bridge-local,no HTTP)
              ▼                          ▼          ▼          ▼          │
         ┌───────────────────────────────────────────────────────────────┐
         │  HTTP → execution/server.ts (backend daemon)                  │
         │                                                               │
         │  routeToolCall()                                              │
         │  ├─ provider op → ExecutionService                            │
         │  │   ├─ coral:<name> → coralDispatch()                        │
         │  │   │               → resolver + instruction                 │
         │  │   │               → start() or resume()                    │
         │  │   └─ exec/resume/fork/list → direct                        │
         │  │                      ↓                                     │
         │  │               Provider.execute()                           │
         │  │               → spawn CLI (background)                     │
         │  │               → write progress to <os-tmpdir>/coral-jobs/  │
         │  │                                                            │
         │  ├─ abort → abortJobs() / ExecutionService.abort()            │
         │  ├─ workflow → executeWorkflow → executePipeline              │
         │  └─ wait → SSE stream from waitStream()                       │
         │           → poll <os-tmpdir>/coral-jobs/ for events           │
         └───────────────────────────────────────────────────────────────┘
```

## Data Flow

### 1. Skill-to-Agent Routing

```
User → /coral:codex "question"
     → Skill detects intent (review/investigate/ralph/general)
     → Review intent:
        → Parallel codex calls: codex({ op: "coral:architect", ... }) + codex({ op: "coral:critic", ... })
        → wait tool loop with timeout until both complete
     → Results synthesized
     → Other intents:
        → Skill calls codex({ op: "coral:<agent>" }) or codex({ op: "exec" }) directly
        → Codex response returned to user
```

### 2. Thin Skill → Agent Protocol Loading

```
User → /coral:plan "task description"
     → Skill contains embedded planning protocol
     → Claude executes planning protocol in main context
     → Phase 2 (Claude): Task(coral:architect) + Task(coral:critic) in parallel
     → Review loop until converged → plan file written

User → /coral:plan --codex "task description"
     → Skill contains embedded planning protocol
     → Claude executes planning protocol in main context
     → Phase 1 (Codex): codex({ op: "coral:architect" }) + codex({ op: "coral:critic" })
     → Phase 2 (Claude): Task(coral:architect) + Task(coral:critic)
     → Review loop until converged → plan file written

User → /coral:init-project
     → Skill reads agents/init-project.md (protocol injection)
     → Claude executes init-project protocol in main context
     → Phase 1: Scan project → Phase 2: Write plan + spawn reviewers
     → Plan verified → Phase 3: spawn general-purpose with ralph protocol
     → Ralph generates artifacts → Phase 4: Report
```

### 3. Direct Codex Execution (via /codex skill)

```
User → /codex skill analyzes intent
     → Review?   → Parallel codex calls (op: "coral:architect" + op: "coral:critic")
     → Analyze?  → Direct MCP call with scanner protocol (no subagent)
     → Ralph?    → Direct MCP call with ralph protocol (no subagent)
     → General?  → Direct MCP call, verbatim prompt (no subagent)
```

### 4. Discuss - Moderated Multi-Agent Discussion

```
User → /coral:discuss "AI ethics in healthcare"
     → Skill calls discuss_seed({ controversy_axes, n, seed }) → persona assignments
     → Spawns persona-generator agents in parallel (Task tool) → full personas
     → Skill calls discuss_start({ topic, agents }) → session_id
     → Backend resolves DiscussContext, appends session.created + bidding.opened
     → Collects initial bids → control loop drives rounds:
        → Provider turns via ExecutionService → commit event batches
        → eventBus emits discuss:updated after every batch
     → User/observer: discuss_watch (poll events), discuss_participate (bid/speak)
     → /api/discuss + /api/discuss/detail read projected snapshots
     → discuss_abort appends a durable terminal event
```

### 5. Workflow Pipeline Execution

```
User/Skill → workflow({ expression: "(architect, critic) -> resolver", start_prompt: "..." })
           → handleWorkflow(args, service, ctx)
           → Schema validation + AST parsing + namespace validation
           → ExecutionService.executeWorkflow fires background handler:
              Step 1: Promise.all → launchAtomWithRetry(architect) + launchAtomWithRetry(critic)
                → service.coralDispatch(codex, "architect", { prompt: "..." })
                → service.coralDispatch(codex, "critic", { prompt: "..." })
              → waitForAllAtoms forwards atom progress + performs stale detection/recovery
              → formatStepOutput → "<architect>...\n</architect>\n\n<critic>...\n</critic>"
              Step 2: launchAtomWithRetry(resolver) with step 1 XML output as prompt
              → waitForAllAtoms
              → readAtomOutput(result.md)
           → Final output written to <os-tmpdir>/coral-jobs/<jobId>/result.md
           → wait({ jobs: [job] }) returns result.path (+ optional result.content)
           → workflow caller uses result.content ?? Read(result.path)
```

### 6. Session-based Conversation (Codex)

```
User → codex({ op: "exec", name: "review", prompt: "analyze auth.ts" })
     → launch returns job ID + session ID immediately
     → completion stores conversationRef in SessionManager under <uuid>.json (atomic write)
     → codex({ op: "exec", session: "<uuid>", prompt: "follow-up question" })
     → ExecutionService routes to resume() via SessionManager lookup
     → codex exec resume CONVERSATION_REF executed
     → lastUsedAt updated
```

### 7. Job Storage Layout

```
<os-tmpdir>/coral-jobs/
└── <jobId>/                      # one dir per job attempt
    ├── status.json               # phase, launch state, sessionId, provider
    ├── progress.jsonl            # append-only progress events
    └── result.md                 # final output text (on completion)
```

Each job directory is created when the job is allocated. Progress events are appended as JSONL lines. Terminal results are written atomically.

### 8. Session Storage Layout (AX)

```
~/.claude/coral/sessions/
└── <project-hash>/                  # sha256(resolve(workingDirectory)).slice(0, 12)
    ├── 8f6b4c2e-6dd6-53d5-b149-f72f0f6f7d2f.json
    ├── 1e8c7f32-0d1b-4a73-8d2f-6a6ed6fca12a.json
    └── ...
```

Each file is a single `SessionEntry`. Corrupt files are skipped with a warning; valid files continue loading.

### 9. Session Storage Layout (Discuss)

```
~/.coral/
├── discuss-sources.json               # Shared source registry for recovery
└── projects/
    └── <source-slug>/
        └── discuss/
            ├── discovery.json         # Source-scoped recovery index
            ├── summary-index.json     # Source-scoped listing index
            └── <session-id>/
                ├── event-log.jsonl    # Canonical append-only event stream
                └── state.json         # Derived PersistedDiscussSnapshot
```

`DiscussSessionStore.append()` writes in strict order: append + `fdatasync` the event log, reduce into the next snapshot, atomically rewrite `state.json`, then atomically merge `discovery.json` and `summary-index.json`. `state.json` is an optimization and restart seed; `event-log.jsonl` is the authority. Same-source checkouts share this persisted storage; `projectRoot` remains metadata for live attachment and display.

### 10. Knowledge Base Storage

```
~/.coral/
├── kb/                             # Shared cross-project knowledge base
│   ├── domain-topic.md
│   └── ...
├── discuss-sources.json            # Shared discuss source registry
└── projects/
    └── <source-slug>/              # owner-repo or local-dirname
        ├── memo/
        │   └── <timestamp>-<topic>.md
        ├── plans/
        ├── analysis/
        └── discuss/
```

- **KB** (`~/.coral/kb/`) is global and shared across projects. Notes in `kb/notes/`, principles in `kb/principles/`. The KB directory is a git repo when multi-device sync is enabled.
- **Project working data** lives under `~/.coral/projects/{slug}/`, where `{slug}` comes from the canonical git source (`owner/repo` -> `owner-repo`) with `local/<dirname>` fallback.
- Agents write memos under `~/.coral/projects/{slug}/memo/`, then use KB tools (`kb_search`, `kb_promote`, `kb_update`, `kb_delete`, `kb_reindex`) for note operations.
- **KB git cycle**: When the KB directory has a git remote, curate auto-manages sync. On start: `fetch` + `rebase` (conflict: `abort` + `merge -X theirs`, stash preserves uncommitted new notes). After curate: `push` (failure: `pull --rebase` + retry). `.gitignore` tracks `curate-state.json`, `data/`, `.obsidian/` (device-local files excluded from sync). Curate classification metadata lost to `-X theirs` is re-applied in the next curate cycle (idempotent).

**Vector Search** (activated by `/coral:equip kb`):

```
~/.coral/kb/
├── .entity-graph.json      Entity metadata + relationships (git-tracked, LLM-generated)
└── communities/            Community markdown files (Obsidian graph visualization)

~/.coral/data/kb/
├── index.json              Derived cache (rebuilt from frontmatter + entity graph)
├── orama-index.json        Orama BM25 snapshot
├── curate-state.json       Curation progress
└── vec/                    Vector search (installed by equip kb)
    ├── coral-vec.node      C++ addon (DuckDB + USearch)
    └── specs/{specId}/     Per-embedding-spec snapshots
        ├── ACTIVE          Atomic pointer to live snapshot
        └── snapshots/{id}/
            ├── store.duckdb    Chunk vectors + metadata
            ├── manifest.json   Entry content hashes
            └── engines/        Search engine index files
```

Hybrid search pipeline: query → embed via EmbeddingProvider → vector chunk search (USearch HNSW) → aggregate chunks to entries → RRF fusion with Orama BM25 + entity graph ranking (third channel) → merged `KbResult[]`. Graph ranking resolves query terms to entity names/aliases, performs bounded 1-hop expansion via relationship edges, and contributes a capped score at the fusion boundary. Falls back to text-only when addon is absent; graph channel disabled when `.entity-graph.json` is missing.

## Directory Structure

```
coral/
├── src/
│   ├── bridge/              # L2 — MCP stdio proxy (→ coral-ax.cjs)
│   │   └── server.ts        #   Composition root: stdio → HTTP relay
│   ├── cli/                 # L2 — Commander CLI client (→ coral-cli.cjs)
│   │   └── bootstrap.ts     #   Entry point
│   ├── execution/           # L1 — Backend HTTP daemon (→ coral-backend.cjs)
│   │   ├── server.ts        #   Composition root: HTTP server + DI wiring
│   │   ├── server-types.ts  #   Leaf types: LifecycleState, BackendServerInfo
│   │   ├── lifecycle.ts     #   Singleton startup/shutdown state machine
│   │   ├── service.ts       #   ExecutionService: launch/wait/abort/workflow
│   │   ├── tool-router.ts   #   Top-level tool dispatch (ToolDomainResult)
│   │   ├── tool-response.ts #   Unified domain result contract
│   │   ├── engine.ts        #   LaunchCoordinator + CLI spawn/queue/child lifecycle
│   │   ├── event-bus.ts     #   TypedEventBus class (backend-local, no singleton)
│   │   ├── host-manager.ts  #   ProviderHostManager: provider server lifecycle + RPC
│   │   └── discuss/         #   Discuss runtime (loop, subflows, persistence)
│   ├── providers/           # L0 — Provider adapters
│   │   ├── registry.ts      #   ProviderRegistry class (instance-scoped)
│   │   ├── codex/           #   Codex CLI adapter
│   │   ├── claude/          #   Claude CLI adapter
│   │   └── claude-appserver/#   Claude provider server (broker protocol)
│   ├── discuss/             # L0 — Discuss domain (pure, zero I/O)
│   │   └── view-types.ts    #   Shared view DTOs (breaks views↔projections cycle)
│   ├── kb/                  # L0 — Knowledge base (search, mutation, curation)
│   │   ├── contracts.ts     #   KbRuntime interface, vector types (leaf, no cycles)
│   │   ├── entity-consolidation.ts # Entity name normalization, alias emission, relationship rewiring
│   │   ├── community-detection.ts # Entity-graph hierarchical Louvain community detection
│   │   └── markdown-entries.ts    # Sorted markdown entry scanning
│   ├── workflow/            # L0 — Pipeline executor (parser, AST, retry)
│   │   └── types.ts         #   WorkflowExecutionPort (standalone, no back-edges)
│   ├── shared/              # L0 — Shared utilities (types, mcp-utils, schemas)
│   │   ├── session-entry.ts #   SessionEntry validator + lenient reader
│   │   └── fs-lock.ts       #   mkdir-based filesystem lock (cross-process)
│   ├── infra/               # L0 — Path resolution, backend connection info
│   └── client/              # L0 — Public barrel for external consumers
├── agents/                  # Agent protocol definitions (.md)
├── skills/                  # Slash command SKILL.md files
├── hooks/                   # Hook scripts (.mjs) + hooks.json config
├── methods/                 # Cross-cutting HOW methodology files
├── bridge/                  # Built bundles (committed): coral-ax.cjs, coral-backend.cjs, coral-cli.cjs
├── scripts/                 # Build scripts
└── docs/                    # Documentation
```

Hooks are wired in `hooks/hooks.json` across `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, and `Stop` events. All scripts are Node.js ESM (`.mjs`) that fail-open.

## Module Dependency Graph

Layer dependencies (see `.claude/rules/design-philosophy.md` for full table):

```
L2  bridge/server.ts ──→ shared/, client/, infra/
    cli/bootstrap.ts ──→ bridge/backend-client, client/, shared/

L1  execution/server.ts ──→ execution/*, providers/, kb/, discuss/, workflow/, infra/, shared/
      Creates and owns: LaunchCoordinator, TypedEventBus, ProviderRegistry,
      DiscussContextRegistry, ProviderHostManager — all backend-local, no singletons
    execution/service.ts ──→ engine, progress-store, session-manager, providers/*, resolver
      Receives coordinator/event-bus/registry via ExecutionServiceDeps
    execution/discuss/* ──→ discuss/ (domain), execution/service (provider turns)
      session-store.ts uses per-session filesystem lock (shared/fs-lock.ts)

L0  providers/{codex,claude,claude-appserver}/ ──→ shared/ only
    providers/registry.ts ──→ ProviderRegistry class (instance-scoped, no module globals)
    discuss/ ──→ (pure, no imports from execution or bridge)
      view-types.ts is the leaf type module (views.ts + projections.ts both import from it)
    kb/ ──→ shared/ only
      contracts.ts is the leaf type module (runtime.ts implements, consumers type-import)
      entity-consolidation.ts: entity name normalization, alias emission, relationship rewiring
      community-detection.ts: entity-relationship graph → louvain.detailed() hierarchical communities
      curate-state.ts: CurateState with pendingRepair + repair frontier normalizer + topology/summary fingerprints
    workflow/ ──→ shared/ only
      types.ts defines WorkflowExecutionPort (standalone interface, no execution imports)
    shared/, infra/, client/ ──→ (no upward imports)
      shared/session-entry.ts: SessionEntry contract shared between client/ and execution/
      shared/fs-lock.ts: cross-process mkdir-based lock used by discuss + session-manager
```

Cross-cutting: `shared/types.ts` provides contracts across all layers. `client/index.ts` is the public barrel for external consumers (coral-reef).

### Key Design: Event-Sourced Control Loop

- Deciders in the state machine never mutate state directly — they validate input and emit event batches
- The reducer is the single replay path for both live execution and restart recovery
- The session store owns durability: append-only log first, snapshot second, discovery index third
- Projections give the API, watch history, and reef sync paths one shared read-model contract

## Plugin Extension Points

### Extension Point Catalog

| Category | Count | Location | Description |
|----------|-------|----------|-------------|
| MCP Tools | 10+ | `src/execution/tool-router.ts` | codex, claude, discuss_*, kb_*, wait, abort, workflow, backend |
| Hooks | 13 scripts | `hooks/` | Lifecycle injection, KB reminders, backend warm-start, HUD updates |
| Skills | 14 directories | `skills/` | Slash commands: plan, discuss, codex, ralph, analyze, init-project, etc. |
| Agents | 10 definitions | `agents/` | Protocol definitions for Claude-native and Codex-delegated agents |
| Methods | 8 HOW files | `methods/` | Cross-cutting methodology (review, synthesize, complete, provenance, etc.) |

### Plugin Lifecycle

```
install (clone / marketplace)
    │
    ▼
configure (.mcp.json — CLAUDE_PLUGIN_ROOT auto-resolved)
    │
    ▼
activate (SessionStart hooks fire)
    ├── INJECT.md injected into context
    ├── Backend daemon warm-started (if not running)
    └── HUD auto-update check
    │
    ▼
run (MCP tool calls via ax proxy → backend daemon)
    ├── Tool routing: provider tools, discuss, kb, workflow
    ├── CLI spawn: Codex/Claude subprocesses via engine queue
    └── Session persistence: atomic writes to ~/.claude/coral/
    │
    ▼
idle (backend auto-shutdown after CORAL_BACKEND_IDLE_MS, default 6h)
    │
    ▼
deactivate (POST /admin/shutdown → graceful drain + exit)
```
