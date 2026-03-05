# Architecture

## System Structure

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Claude Code                                                              │
│                                                                           │
│  ┌──────────────┐  ┌───────────────┐  ┌────────────────────────────────┐  │
│  │ SessionStart │  │ Hook Events   │  │  Skills /coral:*               │  │
│  │ Hook         │  │ (plan/kb/idle │  │  discuss, codex, plan,         │  │
│  │ (CLAUDE.md   │  │  management)  │  │  ralph, analyze, ...           │  │
│  │  injection)  │  │               │  └───────────────┬────────────────┘  │
│  └──────────────┘  └───────┬───────┘                  │                   │
│                            │                ┌─────────┴─────────┐         │
│                            ▼                ▼                   ▼         │
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
│  │  Session: ~/.claude/coral/     │  │  Session: {project}/.claude/    │  │
│  │           sessions/            │  │           coral/discuss/        │  │
│  └───────────────┬────────────────┘  └─────────────────────────────────┘  │
│                  │                                                        │
└──────────────────┼────────────────────────────────────────────────────────┘
                   ▼
        ┌──────────────────────┐   ┌────────────────────────┐
        │  Codex CLI (v0.104+) │   │  Claude CLI            │
        │  codex exec --json   │   │  claude -p             │
        │  --full-auto         │   │  --output-format json  │
        │  JSONL event stream  │   │  JSON object output    │
        └──────────────────────┘   └────────────────────────┘
```

## AX Internal Dispatch

How the AX MCP server routes tool calls internally. The top-level router (`server-handlers.ts`) is registry-first: provider lookup, optional coral dispatch, then provider handler execution.

### Top-Level Router

```
┌──────────────────────────────────────────────────────────────────┐
│  Claude Code (Host)                                              │
│  MCP tool call: codex / claude / wait / abort / workflow         │
└─────────────────────────────┬────────────────────────────────────┘
                              │ stdio (JSON-RPC)
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  server.ts — MCP Server (composition root, wiring only)          │
│  CallToolRequest → handleToolCall(name, rawArgs, sessionManager) │
└─────────────────────────────┬────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  server-handlers.ts — Top-level Router                           │
│                                                                  │
│  provider in registry?   YES → provider.handleOp / handleCoralOp │
│                          NO  → wait/abort/workflow/unknown tool  │
└──────────────────────────────────────────────────────────────────┘
```

### Provider Tools (`codex`, `claude`, and future providers)

```
<provider>({ op, ... })
        │
        ▼
server/server-handlers.handleToolCall()
        │
        ├─ getProvider(name) from providers/registry.ts
        ├─ op starts with "coral:" ?
        │   YES → coral/dispatch.handleCoralDispatch()
        │         ├─ resolveCoralContent(name) from coral/resolver.ts
        │         └─ provider.handleCoralOp(coralName, coralContent, ...)
        │
        │   NO  → provider.handleOp(...)
        │
        ▼
provider adapter (`providers/<name>/server-handlers.ts`)
        │
        ├─ op === "exec" / "fork" → launchJob() → spawn CLI (background)
        ├─ op === "list"          → provider session list
        └─ op === "coral:*"       → provider-specific coral injection path
```

`coral:` resolution is centralized in `src/coral/dispatch.ts`; provider adapters only implement provider-specific injection:
- Codex: prepends coral content to prompt with `\n\n---\n\n`, forces `bypass: true`
- Claude: `stripAgentMetadata(...)` into `system_prompt`, forces `bypass: true`

### `wait` Tool

```
wait({ sessions: [uuid1, uuid2], timeout_seconds })
        │
        ▼
runner/job-manager.handleWait()               job-manager.ts:165
        │
        ├─ resolveSessionDir(id) for each session
        ├─ poll loop (500ms interval):
        │   ├─ readProgressEvents() → MCP progress notifications
        │   ├─ readSessionStatus(dir) → check completed/error
        │   └─ check timeout / shutdown signal
        └─ return { status, completed_session, session_dir }
```

Provider-agnostic: monitors any session regardless of whether it was launched by codex or claude.

### `workflow` Tool

```
workflow({ expression: "(architect, critic) -> resolver", prompt, provider })
        │
        ▼
handleWorkflow()                              workflow/handler.ts
        │
        ├─ parseExpression(expression) → AST: PipeAtom[][]
        ├─ normalizeAst(ast, defaultProvider)
        ├─ validateArgs / validateNamespaces / validateParallelDuplicates
        ├─ stale_timeout_seconds default = 900 (0 disables stale recovery)
        └─ executePipeline(ast, prompt, handleToolCall, ...)
                │
                ▼
        For each step:
        ├─ Parallel atoms → launchAtomWithRetry()
        │   ├─ AgentAtom:  handleToolCall(provider, { op: "coral:{name}", prompt })
        │   └─ PromptAtom: handleToolCall(provider, { op: "coral:workflow-literal", prompt })
        │                       ↓
        │               Re-enters top-level handleToolCall() (recursive)
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
                           │
              ┌────────────┼─────────────┬──────────┐
              ▼            ▼             ▼          ▼          ▼
          "codex"      "claude"       "wait"    "abort"   "workflow"
              │            │             │          │          │
              ▼            ▼             │          │          ▼
     provider registry lookup            │
         │                               │
         ├─ coral:<name> → coral/dispatch│
         │               → resolver      │
         │               → handleCoralOp │
         │                               │
         └─ non-coral op → handleOp      │
                          → launchJob()  │
                              ↓          │
                       spawn CLI         │
                       (background)      │
                              ↓          │
  result → session_dir ◄─────────────────┴───────────────┐
  (background)              poll loop
                                │
                                └─ abort({ sessions }) → activeSessions controller.abort()
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
           → AX router calls handleWorkflow(args, handleToolCall, sessionManager)
           → Schema validation + AST parsing + args/namespace validation + stale_timeout_seconds
           → launchJob fires background handler:
              Step 1: Promise.all → launchAtomWithRetry(architect) + launchAtomWithRetry(critic)
                → dispatch(codex, { op: "coral:architect", prompt: "..." })
                → dispatch(codex, { op: "coral:critic", prompt: "..." })
              → waitForAllAtoms forwards atom progress + performs stale detection/recovery
              → formatStepOutput → "<architect>...\n</architect>\n\n<critic>...\n</critic>"
              Step 2: launchAtomWithRetry(resolver) with step 1 XML output as prompt
              → waitForAllAtoms
              → readAtomOutput(result.md)
           → Final output written to session_dir/result.md
           → wait({ sessions: [session] }) + Read(session_dir + "/result.md")
```

### 6. Session-based Conversation (Codex)

```
User → codex({ op: "exec", name: "review", prompt: "analyze auth.ts" })
     → launch returns coral session UUID + session_dir immediately
     → completion stores internal thread_id in SessionManager under <uuid>.json (atomic write)
     → codex({ op: "exec", session: "<uuid>", prompt: "follow-up question" })
     → SessionManager looks up by UUID
     → codex exec resume THREAD_ID executed
     → lastUsedAt updated
```

### 7. Session Storage Layout (Codex)

```
~/.claude/coral/sessions/
└── <project-hash>/                  # sha256(resolve(workingDirectory)).slice(0, 12)
    ├── 8f6b4c2e-6dd6-53d5-b149-f72f0f6f7d2f.json
    ├── 1e8c7f32-0d1b-4a73-8d2f-6a6ed6fca12a.json
    └── ...
```

Each file is a single `SessionEntry`. Corrupt files are skipped with a warning; valid files continue loading.

### 8. Session Storage Layout (Discuss)

```
{project}/.claude/coral/discuss/
└── 260221-1430-a1b2-ai-ethics/      # {YYMMDD}-{HHMM}-{rand4}-{topic-slug}
    ├── state.json          # Atomic writes via .tmp + rename
    ├── state.lock/         # Cross-process mkdir lock (transient)
    └── transcript.md       # Incremental append (human-readable)
```

Each session directory is created atomically with collision detection. State mutations are serialized via a cross-process `mkdir`-based lock (`state.lock/`). `transcript.md` is append-only — the `transcript_rendered` cursor tracks which entries have been written to the markdown file.

### 9. Knowledge Base Storage

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
│   ├── types.ts                 # Shared Codex event/result types
│   ├── shared/
│   │   └── mcp-utils.ts         # Shared MCP response utilities
│   ├── server/                  # Unified MCP server (tool router)
│   │   ├── server.ts            # Composition root
│   │   └── server-handlers.ts   # Pure router (registry + coral dispatch + wait/abort/workflow)
│   ├── runner/                  # Shared runner infrastructure
│   │   ├── types.ts             # SessionProvider, SessionEntry, CompletionMetadata
│   │   ├── engine.ts            # spawnCli, child caps, kill lifecycle
│   │   ├── session-manager.ts   # Provider-scoped persisted session registry
│   │   ├── progress.ts          # Session dir + status/progress I/O
│   │   └── job-manager.ts       # launchJob, activeSessions, provider-agnostic wait polling
│   ├── coral/                   # Shared coral content resolution + dispatch
│   │   ├── resolver.ts          # agents/ + skills/ resolver + metadata stripping
│   │   └── dispatch.ts          # coral:<name> routing to provider adapters
│   ├── providers/               # Provider adapter system
│   │   ├── types.ts             # ProviderAdapter + NotifyFn contract
│   │   ├── registry.ts          # Provider registration + lookup
│   │   ├── bootstrap.ts         # Built-in provider registration
│   │   ├── codex/
│   │   │   ├── server-handlers.ts
│   │   │   ├── schemas.ts
│   │   │   ├── codex-executor.ts
│   │   │   ├── cli-detection.ts
│   │   │   ├── output-parser.ts
│   │   │   ├── progress.ts
│   │   │   └── mcp-utils.ts
│   │   └── claude/
│   │       ├── server-handlers.ts
│   │       ├── types.ts
│   │       ├── schemas.ts
│   │       ├── cli-detection.ts
│   │       └── claude-executor.ts
│   ├── workflow/                # Workflow pipeline executor
│   │   ├── types.ts             # PipeAtom, PipeStep, PipelineAST
│   │   ├── pipe-parser.ts       # DSL expression parser
│   │   ├── schemas.ts           # Zod input validation
│   │   ├── pipe-executor.ts     # Launch, retry, wait, output formatting
│   │   └── handler.ts           # Entry point (DI from ax router)
│   └── discuss/                 # Discuss MCP server (dc)
│       ├── server.ts            # Composition root
│       ├── server-handlers.ts   # Tool dispatch
│       ├── lock.ts              # File locking and atomic writes
│       ├── handlers/
│       │   ├── bid.ts           # bid/speak flow
│       │   ├── step.ts          # _3_step flow
│       │   └── utils.ts         # Cross-handler shared utilities
│       ├── schemas.ts           # Zod validation
│       ├── state-machine.ts     # Pure state transitions
│       ├── session-store.ts     # I/O: atomic writes, locking
│       ├── transcript.ts        # Markdown rendering
│       ├── persona-seed.ts      # Persona sampling (k-DPP)
│       ├── conditions.ts        # Pure predicates
│       ├── wait.ts              # File polling
│       ├── types.ts             # Discuss type definitions
│       └── util/
│           ├── string.ts        # String/ID formatting utilities
│           ├── rng.ts           # Seeded RNG and sampling primitives
│           └── dpp.ts           # k-DPP linear algebra
├── methods/                     # Cross-cutting HOW methodology files (see docs/methodology.md)
├── skills/                      # Slash command SKILL.md files (one dir per skill)
├── agents/                      # Agent protocol definitions
├── hooks/
│   ├── hooks.json               # Hook config (matcher, timeout)
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
│   ├── coral-ax.cjs             # Unified ax MCP server bundle (committed)
│   └── coral-discuss.cjs        # Discuss MCP server bundle (committed)
├── docs/                        # Documentation
├── vitest.config.ts
├── package.json
├── tsconfig.json
└── .gitignore
```

## Module Dependency Graph

### Unified AX Server (`ax`)

```
server/server.ts                    (composition root)
  └── server/server-handlers.ts     (pure router: provider registry + coral dispatch + wait + abort + workflow)
      ├── providers/bootstrap.ts
      ├── providers/registry.ts
      ├── coral/dispatch.ts
      │   └── coral/resolver.ts
      ├── providers/codex/server-handlers.ts
      │   ├── providers/codex/{schemas,codex-executor,cli-detection,output-parser,progress,mcp-utils}.ts
      │   └── runner/{job-manager,session-manager,progress,engine}.ts
      ├── providers/claude/server-handlers.ts
      │   ├── providers/claude/{schemas,cli-detection,claude-executor,types}.ts
      │   └── runner/{job-manager,session-manager,engine}.ts
      ├── workflow/handler.ts            (pipeline handler, DI via handleToolCall)
      │   ├── workflow/schemas.ts
      │   ├── workflow/pipe-executor.ts
      │   │   └── workflow/pipe-parser.ts
      │   └── runner/{job-manager,progress}.ts
      └── shared/mcp-utils.ts

runner/types.ts + types.ts provide shared contracts across adapters
workflow/types.ts provides pipeline AST types (imports runner/types.ts)
```

### Discuss Server (`dc`)

Strict layered dependency order (lower layers never import from higher):

```
L0  discuss/types.ts             (type definitions — zero imports)
L1  discuss/util/string.ts       (string/ID formatting)
    discuss/util/rng.ts          (seeded RNG, sampling)
    discuss/util/dpp.ts          (k-DPP linear algebra → imports rng)
L2  discuss/state-machine.ts     (pure state transitions → imports util/string)
    discuss/conditions.ts        (pure predicates)
    discuss/transcript.ts        (markdown rendering)
    discuss/schemas.ts           (Zod validation)
    discuss/persona-seed.ts      (k-DPP sampling → imports util/rng, util/dpp)
L3  discuss/lock.ts              (file locking, atomic writes)
    discuss/session-store.ts     (I/O shell → imports util/string, lock, transcript)
    discuss/wait.ts              (file polling)
L4  discuss/handlers/utils.ts    (cross-handler utilities → imports session-store type-only)
L5  discuss/handlers/bid.ts      (bid/speak flow)
    discuss/handlers/step.ts     (_3_step flow)
L6  discuss/server-handlers.ts   (tool dispatch → imports handlers/bid, handlers/step, handlers/utils)
L7  discuss/server.ts            (composition root — wiring only)

shared/mcp-utils.ts ← referenced by L4–L6
```

### Key Design: Functional Core / Imperative Shell

The discuss server separates pure logic from I/O:

- **L0–L1**: Zero project imports. `util/` provides pure string, RNG, and DPP primitives.
- **L2 Functional Core** (`state-machine.ts`, `conditions.ts`, `transcript.ts`, `persona-seed.ts`): pure functions, zero `node:fs`. Fully testable without filesystem.
- **L3 Imperative Shell** (`lock.ts`, `session-store.ts`, `wait.ts`): all filesystem operations. Atomic writes via `writeStateAtomic` (from `lock.ts`). All state mutations serialized through `withLock`.
- **L4–L5 Handler layer**: `handlers/utils.ts` provides shared utilities (`resolveSession`, `resultToMcp`, `endContent`). `handlers/bid.ts` and `handlers/step.ts` contain the extracted bid/speak and `_3_step` flows.
- **L6 Dispatch**: `server-handlers.ts` is a thin router — Zod parsing, `envInt`, and routing to handlers.
