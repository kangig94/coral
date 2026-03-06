# Architecture

## System Structure

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Claude Code                                                              │
│                                                                           │
│  ┌──────────────┐  ┌───────────────┐  ┌────────────────────────────────┐  │
│  │ SessionStart │  │ Hook Events   │  │  Skills /coral:*               │  │
│  │ Hooks        │  │ (plan/kb/idle │  │  discuss, codex, plan,         │  │
│  │ (CLAUDE.md   │  │  management)  │  │  ralph, analyze, ...           │  │
│  │  injection,  │  │               │  └───────────────┬────────────────┘  │
│  │  backend     │  └───────┬───────┘                  │                   │
│  │  warm-start) │          │                ┌─────────┴─────────┐         │
│  └──────────────┘          │                ▼                   ▼         │
│                            ▼                                              │
│  ┌────────────────────────────────┐  ┌─────────────────────────────────┐  │
│  │  MCP Server "ax"               │  │  MCP Server "dc"                │  │
│  │  (bridge/coral-ax.cjs)         │  │  (bridge/coral-discuss.cjs)     │  │
│  │                                │  │                                 │  │
│  │  Tools: codex + claude + wait  │  │  Tools: discuss (2 ops)         │  │
│  │         + abort + workflow     │  │    + discuss_lead (7 ops)       │  │
│  │  codex: exec/list/fork         │  │                                 │  │
│  │   + coral:<name>               │  │                                 │  │
│  │  claude: exec/list/fork        │  │                                 │  │
│  │   + coral:<agent>              │  │                                 │  │
│  │  wait: provider-agnostic       │  │                                 │  │
│  │  abort: provider-agnostic      │  │                                 │  │
│  │  workflow: pipeline executor   │  │                                 │  │
│  │                                │  │                                 │  │
│  │  ┌──────────────────────────┐  │  │  Session: {project}/.claude/    │  │
│  │  │ Thin MCP stdio proxy     │  │  │           coral/discuss/        │  │
│  │  │ HTTP → backend daemon    │  │  └─────────────────────────────────┘  │
│  │  └───────────┬──────────────┘  │                                       │
│  └──────────────┼─────────────────┘                                       │
│                 │                                                         │
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
│  └── Routes:                                                              │
│      GET  /health         → version, instanceId, uptime                   │
│      GET  /tools          → tool descriptors for MCP ListTools            │
│      POST /tool           → routeToolCall() → ExecutionService            │
│      POST /wait/stream    → SSE progress/terminal/timeout events          │
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

How the AX MCP server routes tool calls internally. The MCP stdio proxy (`bridge/server.ts`) forwards all non-wait calls to the backend daemon via HTTP. The backend's `routeToolCall()` function is the top-level router: provider lookup, optional coral dispatch, then provider execution.

### MCP Proxy Layer

```
┌──────────────────────────────────────────────────────────────────┐
│  Claude Code (Host)                                              │
│  MCP tool call: codex / claude / wait / abort / workflow         │
└─────────────────────────────┬────────────────────────────────────┘
                              │ stdio (JSON-RPC)
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  bridge/server.ts — MCP stdio proxy (composition root)           │
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
bridge/server.ts (MCP proxy)
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
bridge/server.ts parseSseBlock() → MCP progress notifications
```

Provider-agnostic: monitors any job regardless of whether it was launched by codex or claude.

### `workflow` Tool

```
workflow({ expression: "(architect, critic) -> resolver", prompt, provider })
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
        executePipeline(ast, prompt, providerName, service, ctx, ...)
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
         bridge/server.ts (MCP proxy)    │          │          │          │
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
         │  ├─ abort → jobManager.abort()                         │
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
     → Skill reads agents/discuss-lead.md (protocol injection)
     → Moderator: calls discuss_lead({ op: "_1_seed", ... }) → persona assignments
     → Spawns persona-generator agents in parallel (Task tool)
     → discuss_lead({ op: "_2_create", topic, agents }) → session_id, session_dir
     → TeamCreate "coral-dc-{session_id}"
     → Spawns discussant teammates (dc-{agent_name})
     → Discussion Loop:
        → discuss_lead({ op: "_3_step", session, timeout_seconds }) → blocks until all bids in
          → resolved: winner announced → discuss_lead(_3_step) again → blocks until speech_done
          → epoch_transition: moderator calls discuss_lead({ op: "_5_epoch", summary })
          → ended: loop exits
        → Discuss agents call discuss({ op: "bid", score }) each round
        → Winner calls discuss({ op: "speak", content })
     → final transcript via discuss_lead({ op: "_4_transcript", mode: "full" })
     → discuss_lead({ op: "_7_end", session }) → discuss_lead({ op: "_8_synthesize", session, synthesis })
     → Present synthesis to user, shutdown teammates
```

### 5. Workflow Pipeline Execution

```
User/Skill → workflow({ expression: "(architect, critic) -> resolver", prompt: "..." })
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
           → wait({ jobs: [job] }) + Read(/tmp/coral-jobs/<jobId>/result.md)
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
{project}/.claude/coral/discuss/
└── 260221-1430-a1b2-ai-ethics/      # {YYMMDD}-{HHMM}-{rand4}-{topic-slug}
    ├── state.json          # Atomic writes via .tmp + rename
    ├── state.lock/         # Cross-process mkdir lock (transient)
    └── transcript.md       # Incremental append (human-readable)
```

Each session directory is created atomically with collision detection. State mutations are serialized via a cross-process `mkdir`-based lock (`state.lock/`). `transcript.md` is append-only — the `transcript_rendered` cursor tracks which entries have been written to the markdown file.

### 10. Knowledge Base Storage

```
{project}/.claude/coral/kb/          # Git-tracked (multi-device sync)
├── domain-topic.md
└── ...

{project}/.claude/coral/memo/        # Gitignored (ephemeral buffer before promotion)
└── <timestamp>-<topic>.md
```

- **KB** is project-local and git-tracked for cross-device sync
- **Memo** is project-local and gitignored (ephemeral buffer)
- Promotion: memo → kb (on task completion or plan approval)

## Directory Structure

```
coral/
├── .claude-plugin/              # Plugin + marketplace manifests
├── src/
│   ├── types.ts                 # Shared type definitions (re-exports + execution contract types)
│   ├── shared/
│   │   ├── mcp-utils.ts         # Shared MCP response utilities
│   │   ├── schemas.ts           # Shared Zod schemas (effort levels, defaults)
│   │   └── format-progress.ts   # Progress message formatting
│   ├── bridge/                  # MCP stdio proxy to backend daemon
│   │   ├── server.ts            # MCP composition root (stdio transport)
│   │   ├── backend-tool.ts      # Bridge-local backend tool (status/shutdown, never proxied)
│   │   └── backend-client.ts    # HTTP client (ensureBackend, proxyToolCall, streamWait, getBackendStatus, shutdownBackend)
│   ├── execution/               # Persistent HTTP backend daemon
│   │   ├── server.ts            # HTTP server, routing, lifecycle, singleton startup
│   │   ├── service.ts           # ExecutionService (start/resume/fork/coralDispatch/wait)
│   │   ├── backend-lock.ts      # Singleton file lock (~/.claude/coral/backend.lock)
│   │   ├── backend-info.ts      # Connection info persistence (~/.claude/coral/backend.json)
│   │   ├── idle-timer.ts        # Auto-shutdown on idle (CORAL_BACKEND_IDLE_MS)
│   │   ├── job-manager.ts       # Job allocation, tracking, abort, signal management
│   │   ├── progress-store.ts    # Event storage/replay (/tmp/coral-jobs/)
│   │   ├── session-manager.ts   # Session persistence (~/.claude/coral/sessions/)
│   │   ├── engine.ts            # CLI spawn, child tracking, kill lifecycle
│   │   ├── instruction.ts       # Coral agent prompt/system instruction building
│   │   └── request-context.ts   # CallerContext + ToolRequest type definitions
│   ├── coral/                   # Shared coral content resolution
│   │   └── resolver.ts          # agents/ + skills/ resolver + metadata stripping
│   ├── providers/               # Provider adapter system
│   │   ├── types.ts             # Provider, ProviderRuntime, ProviderCapabilities contracts
│   │   ├── registry.ts          # Provider registration + lookup
│   │   ├── bootstrap.ts         # Built-in provider registration (codex + claude)
│   │   ├── codex/
│   │   │   ├── adapter.ts       # Codex Provider implementation
│   │   │   ├── schemas.ts       # Zod input validation
│   │   │   ├── codex-executor.ts # CLI spawn (exec/resume/fork)
│   │   │   ├── cli-detection.ts # Codex CLI availability + auth check
│   │   │   ├── output-parser.ts # JSONL event stream parser
│   │   │   ├── progress.ts      # Progress message extraction from events
│   │   │   ├── command-patterns.ts # CLI command construction
│   │   │   └── types.ts         # Codex-specific type definitions
│   │   └── claude/
│   │       ├── adapter.ts       # Claude Provider implementation
│   │       ├── types.ts         # Claude-specific type definitions
│   │       ├── schemas.ts       # Zod input validation
│   │       ├── cli-detection.ts # Claude CLI availability + auth check
│   │       ├── claude-executor.ts # CLI spawn (exec/resume/fork)
│   │       ├── output-parser.ts # JSON output parser
│   │       └── progress.ts      # Progress message extraction from events
│   ├── workflow/                # Workflow pipeline executor
│   │   ├── types.ts             # PipeAtom, PipeStep, PipelineAST
│   │   ├── pipe-parser.ts       # DSL expression parser
│   │   ├── schemas.ts           # Zod input validation
│   │   ├── pipe-executor.ts     # Launch, retry, wait, output formatting
│   │   └── handler.ts           # Entry point (DI from backend router)
│   └── discuss/                 # Discuss MCP server (dc)
│       ├── server.ts            # Composition root
│       ├── server-handlers.ts   # Tool dispatch
│       ├── lock.ts              # File locking and atomic writes
│       ├── handlers/
│       │   ├── bid.ts           # bid/speak flow
│       │   └── step.ts          # _3_step flow
│       ├── schemas.ts           # Zod validation
│       ├── state-machine.ts     # Pure state transitions
│       ├── session-store.ts     # I/O: atomic writes, locking
│       ├── transcript.ts        # Markdown rendering
│       ├── persona-seed.ts      # Persona sampling (k-DPP)
│       ├── wait.ts              # File polling
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
│   ├── hooks.json               # Hook config (matcher, timeout)
│   ├── backend-warm-start.mjs   # SessionStart backend daemon pre-spawn
│   ├── kb-lookup-reminder.mjs   # PostToolUseFailure KB hint
│   ├── silent-failure-detector.mjs # PostToolUse silent-failure detector
│   ├── kb-memo-reminder.mjs     # PreToolUse memo hint
│   ├── kb-promote-reminder.mjs  # Stop/Compact promotion hint
│   ├── plan-guard.mjs           # Compact plan-mode recovery
│   ├── plan-state-tracker.mjs   # UserPromptSubmit/Stop plan tracking
│   └── discuss-idle-guard.mjs   # TeammateIdle bid/speak/vote enforcer
├── scripts/
│   └── build-server.mjs         # esbuild bundling + version sync
├── bridge/
│   ├── coral-ax.cjs             # MCP stdio proxy bundle (committed)
│   ├── coral-backend.cjs        # HTTP backend daemon bundle (committed)
│   └── coral-discuss.cjs        # Discuss MCP server bundle (committed)
├── docs/                        # Documentation
├── vitest.config.ts
├── package.json
├── tsconfig.json
└── .gitignore
```

## Module Dependency Graph

### AX Server (`ax`) — Bridge + Backend

```
bridge/server.ts                        (MCP stdio proxy — composition root)
  ├── bridge/backend-tool.ts            (bridge-local backend tool: handler, descriptor, buildToolList)
  │   ├── bridge/backend-client.ts      (getBackendStatus, shutdownBackend)
  │   └── shared/mcp-utils.ts
  └── bridge/backend-client.ts          (HTTP client: ensureBackend, proxyToolCall, streamWait)
      ├── execution/backend-info.ts     (read connection info)
      ├── execution/backend-lock.ts     (lock path constant)
      └── shared/mcp-utils.ts

execution/server.ts                     (HTTP daemon — composition root)
  ├── execution/backend-lock.ts         (singleton lock: acquireLock, removeLockIfOwner)
  ├── execution/backend-info.ts         (connection info persistence: write/remove)
  ├── execution/idle-timer.ts           (auto-shutdown on idle)
  ├── execution/engine.ts              (activeChildren, killAllChildren)
  ├── execution/progress-store.ts       (ProgressStore: job dirs, event I/O)
  ├── execution/request-context.ts      (CallerContext, ToolRequest types)
  ├── providers/registry.ts + bootstrap.ts (provider lookup + registration)
  ├── workflow/handler.ts               (pipeline handler)
  └── execution/service.ts             (ExecutionService — business logic)
      ├── execution/job-manager.ts      (job allocation, tracking, abort, signals)
      ├── execution/progress-store.ts   (event storage/replay, /tmp/coral-jobs/)
      ├── execution/session-manager.ts  (session persistence, ~/.claude/coral/sessions/)
      ├── execution/engine.ts           (CLI spawn/kill/backpressure)
      ├── execution/instruction.ts      (coral agent instruction building)
      ├── coral/resolver.ts             (agent/skill content resolution)
      ├── providers/registry.ts         (provider lookup)
      ├── shared/schemas.ts             (CORAL_DEFAULT_EFFORT)
      ├── workflow/pipe-executor.ts → pipe-parser.ts
      └── providers/
          ├── codex/adapter.ts → {codex-executor, cli-detection, output-parser, progress, command-patterns}.ts
          └── claude/adapter.ts → {claude-executor, cli-detection, output-parser, progress}.ts

types.ts provides shared contracts across all modules
workflow/types.ts provides pipeline AST types
```

### Discuss Server (`dc`)

Strict layered dependency order (lower layers never import from higher):

```
L0  discuss/types.ts             (type definitions — zero imports)
L1  discuss/util/string.ts       (string/ID formatting)
    discuss/util/rng.ts          (seeded RNG, sampling)
    discuss/util/time.ts         (time formatting)
    discuss/util/dpp.ts          (k-DPP linear algebra → imports rng)
L2  discuss/state-machine.ts     (pure state transitions → imports util/string)
    discuss/transcript.ts        (markdown rendering)
    discuss/schemas.ts           (Zod validation)
    discuss/persona-seed.ts      (k-DPP sampling → imports util/rng, util/dpp)
L3  discuss/lock.ts              (file locking, atomic writes)
    discuss/session-store.ts     (I/O shell → imports util/string, lock, transcript)
    discuss/wait.ts              (file polling)
L4  discuss/handlers/bid.ts      (bid/speak flow)
    discuss/handlers/step.ts     (_3_step flow)
L5  discuss/server-handlers.ts   (tool dispatch → imports handlers/bid, handlers/step)
L6  discuss/server.ts            (composition root — wiring only)

shared/mcp-utils.ts ← referenced by L4–L5
```

### Key Design: Functional Core / Imperative Shell

The discuss server separates pure logic from I/O:

- **L0–L1**: Zero project imports. `util/` provides pure string, RNG, time, and DPP primitives.
- **L2 Functional Core** (`state-machine.ts`, `transcript.ts`, `persona-seed.ts`): pure functions, zero `node:fs`. Fully testable without filesystem.
- **L3 Imperative Shell** (`lock.ts`, `session-store.ts`, `wait.ts`): all filesystem operations. Atomic writes via `writeStateAtomic` (from `lock.ts`). All state mutations serialized through `withLock`.
- **L4 Handler layer**: `handlers/bid.ts` and `handlers/step.ts` contain the extracted bid/speak and `_3_step` flows.
- **L5 Dispatch**: `server-handlers.ts` is a thin router — Zod parsing, `envInt`, and routing to handlers.
