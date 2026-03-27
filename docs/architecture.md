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
│  │ Tools: codex + claude + kb_* + discuss_* + wait + abort +  │ │        │
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
│  Persisted discuss data: ~/.coral/projects/{slug}/discuss/ │        │
│    discovery.json + summary-index.json + <session-id>/...  │        │
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
│  ├── Job storage       (/tmp/coral-jobs/<jobId>/)                         │
│  ├── Session storage   (~/.claude/coral/sessions/)                        │
│  ├── Discuss storage   ~/.coral/projects/{slug}/discuss/           │
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
        │         ├─ resolveCoralContent(name) from coral/resolver.ts
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

`coral:` resolution is centralized in `coral/resolver.ts`; provider adapters only implement provider-specific injection:
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
workflow({ expression: "(architect, critic) -> resolver", init_prompt, provider })
        │
        ▼
handleWorkflow()                              workflow/handler.ts
        │
        ├─ parseExpression(expression) → AST: PipeAtom[][]
        ├─ normalizeAst(ast, defaultProvider)
        ├─ validateAtoms / validateNamespaces / validateParallelDuplicates
        ├─ stale_timeout_seconds default = 900 (0 disables stale recovery)
        └─ ExecutionService.executeWorkflow(ast, input, ctx)
                │
                ▼
        executePipeline(ast, init_prompt, providerName, service, ctx, ...)
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
        │   ├─ detect stale atoms (no activity for stale_timeout_seconds)
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
              │                          │          │          │   (bridge-local,
              ▼                          ▼          ▼          ▼   no HTTP)  │
         ┌────────────────────────────────────────────────────────┐
         │  HTTP → execution/server.ts (backend daemon)           │
         │                                                        │
         │  routeToolCall()                                       │
         │  ├─ provider op → ExecutionService                     │
         │  │   ├─ coral:<name> → coralDispatch()                 │
         │  │   │               → resolver + instruction          │
         │  │   │               → start() or resume()             │
         │  │   └─ exec/resume/fork/list → direct                 │
         │  │                      ↓                              │
         │  │               Provider.execute()                    │
         │  │               → spawn CLI (background)              │
         │  │               → write progress to /tmp/coral-jobs/  │
         │  │                                                     │
         │  ├─ abort → abortJobs() / ExecutionService.abort()     │
         │  ├─ workflow → executeWorkflow → executePipeline       │
         │  └─ wait → SSE stream from waitStream()                │
         │           → poll /tmp/coral-jobs/ for events           │
         └────────────────────────────────────────────────────────┘
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
     → execution/server.ts resolves DiscussContext + DiscussSessionStore
     → discuss-operations.ts appends session.created + bidding.opened
     → discuss-subflows.ts collects initial bids
     → discuss-loop.ts drives the live control loop:
        → discuss-executor.ts launches provider turns via ExecutionService (pool: 'discuss')
        → discuss-persistence.ts commits bid/speech/follow-up/synthesis event batches
        → discuss-registry.ts maintains attached sessions + live watch buffers
        → eventBus emits discuss:updated after every committed batch
     → User/observer: discuss_watch (poll events), discuss_participate (bid/speak)
     → /api/discuss + /api/discuss/detail read projected snapshots
     → discuss_abort appends a durable terminal event
```

### 5. Workflow Pipeline Execution

```
User/Skill → workflow({ expression: "(architect, critic) -> resolver", init_prompt: "..." })
           → AX router calls handleWorkflow(args, service, ctx)
           → Schema validation + AST parsing + atoms/namespace validation + stale_timeout_seconds
           → ExecutionService.executeWorkflow fires background handler:
              Step 1: Promise.all → launchAtomWithRetry(architect) + launchAtomWithRetry(critic)
                → service.coralDispatch(codex, "architect", { prompt: "..." })
                → service.coralDispatch(codex, "critic", { prompt: "..." })
              → waitForAllAtoms forwards atom progress + performs stale detection/recovery
              → formatStepOutput → "<architect>...\n</architect>\n\n<critic>...\n</critic>"
              Step 2: launchAtomWithRetry(resolver) with step 1 XML output as prompt
              → waitForAllAtoms
              → readAtomOutput(result.md)
           → Final output written to /tmp/coral-jobs/<jobId>/result.md
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
/tmp/coral-jobs/
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

## Directory Structure

``` 
coral/
├── .claude-plugin/              # Plugin + marketplace manifests
├── src/
│   ├── types.ts                 # Shared execution + provider contract types
│   ├── shared/
│   │   ├── mcp-utils.ts         # Shared MCP helpers and result formatting
│   │   ├── schemas.ts           # Shared Zod schemas and defaults
│   │   ├── sse-parser.ts        # HTTP/SSE parsing for wait streams
│   │   └── format-progress.ts   # Progress message formatting
│   ├── bridge/                  # MCP stdio proxy to backend daemon
│   │   ├── server.ts            # MCP stdio proxy composition root
│   │   ├── backend-tool.ts      # Bridge-local backend tool (status/shutdown)
│   │   └── backend-client.ts    # HTTP client for backend lifecycle + tool proxying
│   ├── client/
│   │   ├── backend-health.ts    # Backend health response contracts
│   │   ├── backend-lifecycle.ts # Backend startup/ensure helpers
│   │   ├── discuss.ts           # Discuss summary/detail/watch DTO builders
│   │   ├── paths.ts             # Filesystem path resolution for Coral data
│   │   └── readers.ts           # Read persisted discuss/job/backend state
│   ├── execution/               # Persistent HTTP backend daemon
│   │   ├── server.ts            # HTTP server, routing, lifecycle, singleton startup
│   │   ├── service.ts           # ExecutionService (start/resume/fork/coralDispatch/wait/workflow)
│   │   ├── abort-registry.ts    # Abort bookkeeping for live jobs
│   │   ├── backend-lock.ts      # Singleton file lock (~/.claude/coral/backend.lock)
│   │   ├── backend-info.ts      # Connection info persistence (~/.claude/coral/backend.json)
│   │   ├── event-bus.ts         # In-process backend event fanout
│   │   ├── idle-timer.ts        # Auto-shutdown on idle (CORAL_BACKEND_IDLE_MS)
│   │   ├── progress-store.ts    # Event storage/replay (/tmp/coral-jobs/)
│   │   ├── session-index.ts     # Session discovery across project roots
│   │   ├── session-manager.ts   # Session persistence (~/.claude/coral/sessions/)
│   │   ├── engine.ts            # CLI spawn, queueing, and child lifecycle
│   │   ├── instruction.ts       # Coral agent prompt/system instruction building
│   │   ├── request-context.ts   # CallerContext + ToolRequest type definitions
│   │   ├── discuss-operations.ts # Primary discuss runtime entry (imported by server.ts)
│   │   ├── discuss-loop.ts      # Live discuss control-loop runner
│   │   ├── discuss-subflows.ts  # Bid/speech/follow-up/synthesis subflows
│   │   ├── discuss-persistence.ts # Commit/rebuild helpers around the session store
│   │   ├── discuss-registry.ts  # Attached live sessions + watch buffering
│   │   ├── discuss-executor.ts  # Provider execution + attempt bookkeeping
│   │   ├── discuss-context.ts   # Shared discuss context types + DiscussManagerError
│   │   ├── discuss-context-registry.ts # Project-root registry of discuss contexts
│   │   ├── discuss-prompts.ts   # Bid/speech prompt construction
│   │   └── discuss-session-store.ts # Durable discuss event log + snapshot I/O
│   ├── coral/                   # Shared coral content resolution
│   │   └── resolver.ts          # agents/ + skills/ resolver + metadata stripping
│   ├── providers/               # Provider adapter system
│   │   ├── types.ts             # Provider, ProviderRuntime, ProviderCapabilities contracts
│   │   ├── registry.ts          # Provider registration + lookup
│   │   ├── bootstrap.ts         # Built-in provider registration (codex + claude)
│   │   ├── cli-detection.ts     # Shared CLI availability + auth probes
│   │   ├── result-mapping.ts    # Provider result normalization
│   │   ├── codex/
│   │   │   ├── adapter.ts       # Codex Provider implementation
│   │   │   ├── schemas.ts       # Zod input validation
│   │   │   ├── codex-executor.ts # CLI spawn (exec/resume/fork)
│   │   │   ├── output-parser.ts # JSONL event stream parser
│   │   │   ├── progress.ts      # Progress message extraction from events
│   │   │   ├── command-patterns.ts # CLI command construction
│   │   │   └── types.ts         # Codex-specific type definitions
│   │   └── claude/
│   │       ├── adapter.ts       # Claude Provider implementation
│   │       ├── schemas.ts       # Zod input validation
│   │       ├── claude-executor.ts # CLI spawn (exec/resume/fork)
│   │       ├── output-parser.ts # JSON output parser
│   │       ├── progress.ts      # Progress message extraction from events
│   │       └── types.ts         # Claude-specific type definitions
│   ├── workflow/                # Workflow pipeline executor
│   │   ├── types.ts             # PipeAtom, PipeStep, PipelineAST
│   │   ├── pipe-parser.ts       # DSL expression parser
│   │   ├── schemas.ts           # Zod input validation
│   │   ├── pipe-executor.ts     # Launch, retry, wait, output formatting
│   │   └── handler.ts           # Backend router entry point
│   ├── kb/                      # Knowledge base tools + storage adapters
│   │   ├── runtime.ts           # KbRuntime: index state, cache, mutation lock, adapter lifecycle
│   │   ├── search.ts            # Orama-backed search
│   │   ├── read.ts              # Note + memo reads
│   │   ├── memo.ts              # Project-scoped memo creation
│   │   ├── promote.ts           # Memo -> note promotion
│   │   ├── update.ts            # Note mutation
│   │   ├── delete.ts            # Note deletion
│   │   ├── curate.ts            # Background metadata/principle curation scheduler
│   │   ├── curate-state.ts      # Curate cursor, retries, pending discovery state
│   │   ├── curate-tags.ts       # Tag cleanup + normalization
│   │   ├── frontmatter.ts       # Markdown frontmatter parsing + serialization
│   │   ├── validation.ts        # Slug/text validation helpers
│   │   ├── mutation-helpers.ts  # Atomic writes + index mutation helpers
│   │   ├── text-artifacts.ts    # Text index rebuilds + Orama snapshots
│   │   ├── orama-factory.ts     # Orama schema/tokenizer construction
│   │   ├── reindex.ts           # Full text/hybrid index rebuild entry
│   │   ├── reindex-enhanced.ts  # LanceDB rebuild adapter hook
│   │   ├── paths.ts             # KB notes/principles/runtime path helpers
│   │   ├── types.ts             # KB result + input types
│   │   └── lancedb-runtime.ts   # Runtime-only LanceDB adapter loader
│   └── discuss/                 # Discuss domain + projections
│       ├── events.ts            # Domain event union + persisted runtime types
│       ├── reducer.ts           # Event replay into snapshot state
│       ├── projections.ts       # Control/audit/watch projections
│       ├── schemas.ts           # Tool input schemas for discuss_* APIs
│       ├── state-helpers.ts     # Domain state helpers
│       ├── state-machine.ts     # Pure deciders: state -> event batches
│       ├── transcript.ts        # Transcript rendering helpers
│       ├── persona-seed.ts      # Persona sampling (k-DPP)
│       ├── types.ts             # Discuss type definitions
│       └── util/
│           ├── string.ts        # String/ID formatting utilities
│           ├── rng.ts           # Seeded RNG and sampling primitives
│           ├── time.ts          # Time formatting utilities
│           └── dpp.ts           # k-DPP linear algebra
├── methods/                     # Cross-cutting HOW methodology files (see docs/methodology.md)
├── skills/                      # Slash command SKILL.md files (one dir per skill)
├── agents/                      # Agent protocol definitions
├── hooks/
│   ├── hooks.json               # Hook event wiring and timeouts
│   ├── backend-warm-start.mjs   # SessionStart backend pre-spawn
│   ├── cli-resolve.mjs          # PreToolUse Bash CLI path resolution
│   ├── coral-skill-vars.mjs     # Inject Coral skill variables before skill runs
│   ├── hud-auto-update.mjs      # SessionStart HUD refresh
│   ├── kb-lookup-reminder.mjs   # KB lookup reminders after Bash failures/use
│   ├── kb-memo-reminder.mjs     # Memo reminder on user prompt submit
│   ├── kb-promote-gate.mjs      # Stop/submit/compact promotion gate
│   ├── post-compact.mjs         # Post-compact cleanup
│   ├── pre-compact.mjs          # Pre-compact checkpointing
│   ├── ralph-loop.mjs           # Ralph loop guardrails
│   ├── session-start.mjs        # SessionStart INJECT.md / project bootstrap
│   └── lib/
│       └── hook-utils.mjs       # Shared stdin/path helpers for hooks
├── scripts/
│   └── build-server.mjs         # esbuild bundling + version sync
├── bridge/
│   ├── coral-ax.cjs             # MCP stdio proxy bundle (committed)
│   ├── coral-backend.cjs        # HTTP backend daemon bundle (committed)
│   └── coral-cli.cjs            # Parallel Bash-tool client bundle (committed)
├── docs/                        # Documentation
├── vitest.config.ts
├── package.json
├── tsconfig.json
└── .gitignore
```

The current hook surface is `hooks.json`, 11 top-level hook scripts, and the shared `hooks/lib/hook-utils.mjs` helper library. `hooks/hooks.json` wires them across `SessionStart`, `PreCompact`, `PostToolUseFailure`, `PostToolUse`, `UserPromptSubmit`, `PreToolUse`, and `Stop`.

## Module Dependency Graph

### AX Server (`ax`) — Bridge + Backend

```
src/bridge/server.ts                    (MCP stdio proxy — composition root)
  ├── src/bridge/backend-tool.ts        (bridge-local backend tool: handler, descriptor, buildToolList)
  │   ├── src/bridge/backend-client.ts  (getBackendStatus, shutdownBackend)
  │   └── src/shared/mcp-utils.ts
  ├── src/bridge/backend-client.ts      (ensureBackend, proxyToolCall, streamWait)
  │   ├── src/client/backend-lifecycle.ts
  │   ├── src/client/backend-health.ts
  │   ├── src/execution/backend-info.ts
  │   ├── src/shared/mcp-utils.ts
  │   └── src/shared/sse-parser.ts
  └── src/shared/{mcp-utils,schemas}.ts

src/execution/server.ts                 (HTTP daemon — composition root)
  ├── src/execution/{backend-lock,backend-info,idle-timer,engine,event-bus}.ts
  ├── src/execution/{progress-store,request-context,session-index,session-manager}.ts
  ├── src/providers/{registry,bootstrap}.ts
  ├── src/workflow/handler.ts
  ├── src/discuss/persona-seed.ts
  ├── src/execution/discuss-context.ts
  ├── src/execution/discuss-context-registry.ts
  ├── src/execution/discuss-session-store.ts
  ├── src/execution/discuss-operations.ts
  ├── src/kb/{curate,delete,memo,paths,promote,read,reindex,runtime,search,update}.ts
  └── src/execution/service.ts          (ExecutionService — provider/workflow runtime)
      ├── src/execution/abort-registry.ts
      ├── src/execution/engine.ts
      ├── src/execution/progress-store.ts
      ├── src/execution/session-manager.ts
      ├── src/execution/instruction.ts
      ├── src/coral/resolver.ts
      ├── src/providers/registry.ts
      ├── src/workflow/pipe-executor.ts → src/workflow/pipe-parser.ts
      └── src/providers/
          ├── codex/adapter.ts → {codex-executor, output-parser, progress, command-patterns}.ts + src/providers/cli-detection.ts
          └── claude/adapter.ts → {claude-executor, output-parser, progress}.ts + src/providers/cli-detection.ts

src/types.ts provides shared contracts across the bridge, backend, and providers
src/workflow/types.ts provides pipeline AST types
```

### Knowledge Base Subsystem

The KB stack is split between backend routing, runtime/index state, markdown-vault helpers, search/rebuild code, and an automated curation scheduler:

```
src/execution/server.ts
  ├── src/kb/runtime.ts          (KbRuntime bootstrap + index state + mutation lock)
  ├── src/kb/search.ts           (kb_search)
  ├── src/kb/read.ts             (kb_read + memo reads)
  ├── src/kb/memo.ts             (kb_memo)
  ├── src/kb/promote.ts          (kb_promote)
  ├── src/kb/update.ts           (kb_update)
  ├── src/kb/delete.ts           (kb_delete)
  ├── src/kb/reindex.ts          (kb_reindex)
  ├── src/kb/curate.ts           (background curate scheduler)
  └── src/kb/paths.ts            (runtime dir resolution)

src/kb/runtime.ts
  ├── src/kb/paths.ts            (notes/principles/runtime paths)
  ├── src/kb/orama-factory.ts    (Orama DB + tokenizer)
  ├── src/kb/text-artifacts.ts   (full text rebuild into index + Orama snapshot)
  ├── src/kb/lancedb-runtime.ts  (optional enhanced-search adapter)
  ├── src/kb/mutation-helpers.ts (atomic JSON writes)
  └── src/kb/curate-state.ts     (curate-state filename contract)

src/kb/search.ts
  ├── src/kb/orama-factory.ts
  ├── src/kb/runtime.ts
  └── src/kb/types.ts

src/kb/read.ts
  ├── src/kb/frontmatter.ts
  ├── src/kb/paths.ts
  └── src/kb/validation.ts

src/kb/{promote,update,delete}.ts
  ├── src/kb/mutation-helpers.ts
  ├── src/kb/frontmatter.ts
  ├── src/kb/read.ts             (update/promote reuse parsed markdown)
  ├── src/kb/validation.ts
  └── src/kb/paths.ts

src/kb/curate.ts
  ├── src/kb/curate-state.ts
  ├── src/kb/curate-tags.ts
  ├── src/kb/frontmatter.ts
  ├── src/kb/read.ts
  ├── src/kb/mutation-helpers.ts
  ├── src/kb/runtime.ts
  └── src/kb/validation.ts

src/kb/reindex.ts
  ├── src/kb/reindex-enhanced.ts
  ├── src/kb/text-artifacts.ts
  └── src/kb/types.ts

src/kb/types.ts
  (KbSearchInput, KbPromoteInput, KbUpdateInput, KbReadInput, KbDeleteInput,
   KbReindexInput, KbPrinciplesInput, KbMemoInput, KbResult, KbIndex, ReindexResult)
```

### Discuss Subsystem

The current discuss stack is event-sourced and split across pure domain modules, read models, durable storage, and a live runtime centered on `src/execution/discuss-operations.ts`:

```
Pure domain
  src/discuss/types.ts
  src/discuss/util/{string,time,rng,dpp}.ts
  src/discuss/events.ts
  src/discuss/state-machine.ts        (deciders emit validated event batches)
  src/discuss/reducer.ts              (events -> PersistedDiscussSnapshot)
  src/discuss/transcript.ts
  src/discuss/persona-seed.ts

Read models + persisted readers
  src/discuss/projections.ts          (control/audit/watch projections)
  src/client/discuss.ts               (stable DTO builders for API responses)
  src/client/{paths,readers}.ts       (persisted discuss paths + snapshot/event readers)

Durability
  src/execution/discuss-session-store.ts
    -> src/client/{paths,readers,discuss}.ts
    -> src/discuss/reducer.ts

Live runtime
  src/execution/discuss-operations.ts (primary entry imported by src/execution/server.ts)
    -> src/execution/discuss-loop.ts
    -> src/execution/discuss-subflows.ts
    -> src/execution/discuss-executor.ts
    -> src/execution/discuss-persistence.ts
    -> src/execution/discuss-registry.ts
    -> src/execution/discuss-context.ts
    -> src/execution/discuss-session-store.ts

  src/execution/discuss-loop.ts
    -> src/execution/discuss-subflows.ts
    -> src/execution/discuss-persistence.ts
    -> src/execution/discuss-registry.ts
    -> src/execution/discuss-context.ts

  src/execution/discuss-subflows.ts
    -> src/execution/discuss-prompts.ts
    -> src/execution/discuss-executor.ts
    -> src/execution/discuss-persistence.ts
    -> src/discuss/{state-machine,reducer,transcript}.ts

  src/execution/discuss-executor.ts
    -> src/execution/service.ts
    -> src/client/readers.ts
    -> src/execution/discuss-persistence.ts
```

### Key Design: Event-Sourced Control Loop

- Deciders in `state-machine.ts` never mutate `DiscussState` directly. They validate input and emit event batches.
- `reducer.ts` is the single replay path for both live execution and restart recovery.
- `DiscussSessionStore` owns durability: append-only log first, snapshot second, discovery index third.
- `src/execution/discuss-operations.ts` is the runtime entry point imported by `src/execution/server.ts`; `src/execution/discuss-loop.ts` and `src/execution/discuss-subflows.ts` drive the live loop over persisted snapshots.
- `DiscussManagerError` still exists, but it now lives in `src/execution/discuss-context.ts`.
- `projections.ts` and `client/discuss.ts` give the API, watch history, and reef sync paths one shared read-model contract.
