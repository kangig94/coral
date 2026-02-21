# Architecture

## System Structure

```
┌──────────────────────────────────────────────────────────────────────┐
│  Claude Code                                                         │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────────┐  │
│  │ SessionStart │  │ SubagentStart│  │   Skills /coral:*          │  │
│  │ Hook         │  │ Hook         │  │   discuss, codex, plan,    │  │
│  │ (CLAUDE.md   │  │ (codex-*     │  │   ralph, architect, ...    │  │
│  │  injection)  │  │  delegation) │  └──────────┬─────────────────┘  │
│  └──────────────┘  └──────┬───────┘             │                    │
│                           │            ┌────────┴────────┐           │
│                           ▼            ▼                 ▼           │
│  ┌──────────────────────────────┐  ┌──────────────────────────────┐  │
│  │  MCP Server "cx"            │  │  MCP Server "dc"             │  │
│  │  (bridge/coral-codex.cjs)   │  │  (bridge/coral-discuss.cjs)  │  │
│  │                              │  │                              │  │
│  │  Tools: codex_session_*     │  │  Tools: discuss_*            │  │
│  │  (create, send, list, fork) │  │  (create, bid, wait, speak,  │  │
│  │                              │  │   transcript, state, end,    │  │
│  │  Session: ~/.claude/coral/  │  │   epoch_summary)             │  │
│  │           sessions/          │  │                              │  │
│  └──────────────┬───────────────┘  │  Session: {project}/.claude/ │  │
│                 │                   │           coral/discuss/     │  │
│                 │                   └──────────────────────────────┘  │
└─────────────────┼────────────────────────────────────────────────────┘
                  ▼
       ┌──────────────────────┐
       │  Codex CLI (v0.101+) │
       │  codex exec --json   │
       │  --full-auto         │
       │  JSONL event stream  │
       └──────────────────────┘
```

## Data Flow

### 1. Skill-to-Agent Routing

```
User → /coral:codex "question"
     → Skill detects intent (review/investigate/ralph/general)
     → Review intent:
        → Spawn parallel subagents (coral:codex-proxy Role:architect + coral:codex-proxy Role:critic)
        → SubagentStart Hook fires → delegation instructions injected
        → Agents call codex_session_create → results synthesized
     → Other intents:
        → Skill reads agent protocol (agents/codex-proxy.md)
        → Skill calls codex_session_create/send directly (no subagent)
        → Codex response returned to user
```

### 2. Thin Skill → Agent Protocol Loading

```
User → /coral:plan "task description"
     → Skill reads agents/planner.md (protocol injection)
     → Claude executes planner protocol in main context
     → Planner spawns Task(coral:architect) + Task(coral:critic) in parallel
     → Review loop until converged → plan file written

User → /coral:init-project
     → Skill reads agents/init-project.md (protocol injection)
     → Claude executes init-project protocol in main context
     → Phase 1: Scan project → Phase 2: spawn Task(coral:planner)
     → Planner returns verified plan → Phase 3: spawn Task(coral:ralph)
     → Ralph generates artifacts → Phase 4: Report
```

### 3. Direct Codex Execution (via /codex skill)

```
User → /codex skill analyzes intent
     → Review?   → Parallel subagent spawn (codex-proxy Role:architect + codex-proxy Role:critic)
     → Analyze?  → Direct MCP call with analyst protocol (no subagent)
     → Ralph?    → Direct MCP call with ralph protocol (no subagent)
     → General?  → Direct MCP call, verbatim prompt (no subagent)
```

### 4. Discuss — Moderated Multi-Agent Discussion

```
User → /coral:discuss "AI ethics in healthcare"
     → Skill reads agents/discuss-lead.md (protocol injection)
     → Moderator analyzes topic → determines 3-8 roles
     → Spawns persona-generator agents in parallel (Task tool)
     → discuss_create({ topic, agents }) → session_id, session_dir
     → TeamCreate "coral-dc-{session_id}"
     → Spawns discussant teammates (dc-{agent_name})
     → Discussion Loop:
        → Broadcast "Step N. Call discuss_bid."
        → discuss_wait(all_bids) → auto-resolves → 4-way branch
          → winner → notify → discuss_wait(speech_delivered) → broadcast transcript
          → no_winner + new_epoch → epoch transition (server auto-reset quotas)
          → no_winner → synthesis (all_below_threshold / all_blocked / max_epochs_reached)
          → timeout → force end
     → discuss_end → full transcript → synthesis → present to user
     → Shutdown teammates, TeamDelete
```

### 5. Session-based Conversation (Codex)

```
User → codex_session_create(name="review", prompt="analyze auth.ts")
     → Codex execution → thread_id acquired (thread.started event)
     → SessionManager writes ~/.claude/coral/sessions/<project-hash>/review.json (atomic write)
     → codex_session_send(session="review", prompt="follow-up question")
     → SessionManager looks up codexThreadId by name
     → codex exec resume THREAD_ID executed
     → lastUsedAt updated
```

### 6. Session Storage Layout (Codex)

```
~/.claude/coral/sessions/
└── <project-hash>/                  # sha256(resolve(workingDirectory)).slice(0, 12)
    ├── review.json
    ├── auth-audit.json
    └── perf-pass.json
```

Each file is a single `SessionEntry`. Corrupt files are skipped with a warning; valid files continue loading.

### 7. Session Storage Layout (Discuss)

```
{project}/.claude/coral/discuss/
└── 260221-1430-a1b2-ai-ethics/
    ├── state.json          # Atomic writes via .tmp + rename
    ├── state.lock/         # Cross-process mkdir lock (transient)
    └── transcript.md       # Incremental append (human-readable)
```

Each session directory is created atomically with collision detection. State mutations are serialized via a cross-process `mkdir`-based lock (`state.lock/`). Transcript.md is append-only — `transcript_rendered` cursor tracks which entries have been written to .md.

### 8. Knowledge Base Storage

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
├── .claude-plugin/
│   ├── plugin.json              # Plugin manifest
│   └── marketplace.json         # Marketplace manifest
├── .mcp.json                    # MCP server registration
├── CLAUDE.md                    # Behavioral guidelines + KB instructions
├── src/
│   ├── types.ts                 # Shared type definitions (CodexThreadEvent etc.)
│   ├── shared/
│   │   └── mcp-utils.ts         # Shared MCP response helpers (textResult, jsonResult)
│   ├── codex/
│   │   ├── server.ts            # Codex MCP server entry point (stdio, transport, signals)
│   │   ├── server-handlers.ts   # Business logic handlers + dispatch
│   │   ├── schemas.ts           # Zod input validation schemas
│   │   ├── codex-executor.ts    # Codex CLI execution logic
│   │   ├── session-manager.ts   # Per-session file persistence
│   │   ├── output-parser.ts     # JSONL event parsing
│   │   ├── cli-detection.ts     # Codex CLI existence check
│   │   ├── progress.ts          # Progress file utilities
│   │   └── __tests__/           # Tests (vitest)
│   │       ├── server-handlers.test.ts
│   │       ├── schemas.test.ts
│   │       ├── output-parser.test.ts
│   │       ├── codex-executor.test.ts
│   │       ├── session-manager.test.ts
│   │       ├── cli-detection.test.ts
│   │       └── server-progress.test.ts
│   └── discuss/
│       ├── server.ts            # Discuss MCP server entry point (stdio, transport, signals)
│       ├── server-handlers.ts   # Tool definitions + dispatch (discuss_* tools)
│       ├── schemas.ts           # Zod schemas for discuss_* tool inputs
│       ├── state-machine.ts     # Pure state transitions (zero I/O)
│       ├── session-store.ts     # I/O shell: atomic writes, cross-process lock, migration
│       ├── conditions.ts        # Pure condition predicates for discuss_wait
│       ├── wait.ts              # Async file polling (waitForCondition)
│       ├── transcript.ts        # Transcript rendering (pure functions)
│       ├── types.ts             # DiscussState, TranscriptEntry, Result<T>, WaitCondition
│       └── __tests__/           # Tests (vitest)
│           ├── state-machine.test.ts
│           ├── conditions.test.ts
│           ├── session-store.test.ts
│           ├── wait.test.ts
│           ├── transcript.test.ts
│           ├── schemas.test.ts
│           └── server-handlers.test.ts
├── skills/
│   ├── architect/
│   │   └── SKILL.md             # /coral:architect (Claude-native)
│   ├── critic/
│   │   └── SKILL.md             # /coral:critic (Claude-native)
│   ├── analyze/
│   │   └── SKILL.md             # /coral:analyze (Claude-native)
│   ├── ralph/
│   │   └── SKILL.md             # /coral:ralph (Claude-native)
│   ├── discuss/
│   │   ├── SKILL.md             # /coral:discuss (multi-agent discussion)
│   │   └── template/
│   │       └── persona-template.md  # Persona structure template
│   ├── codex-analyze/
│   │   └── SKILL.md             # /coral:codex-analyze (Codex delegation)
│   ├── codex-ralph/
│   │   └── SKILL.md             # /coral:codex-ralph (Codex delegation)
│   ├── codex/
│   │   └── SKILL.md             # /coral:codex (Codex CLI)
│   ├── init-project/
│   │   └── SKILL.md             # /coral:init-project (project initialization)
│   ├── plan/
│   │   └── SKILL.md             # /coral:plan (Claude-native planning)
│   ├── coplan/
│   │   └── SKILL.md             # /coral:coplan (cross-model planning)
│   └── statusline/
│       └── SKILL.md             # /coral:statusline (HUD setup)
├── agents/
│   ├── architect.md             # Claude-native architecture analysis
│   ├── critic.md                # Claude-native plan/code review
│   ├── analyst.md               # Claude-native requirements gap analysis
│   ├── ralph.md                 # Claude-native persistent execution loop
│   ├── planner.md               # Claude-native multi-round planning
│   ├── init-project.md          # Project initialization orchestrator
│   ├── discuss-lead.md          # Discussion moderator protocol
│   ├── discussant.md            # Discussion participant protocol
│   ├── persona-generator.md     # Persona creation agent
│   └── codex-proxy.md           # Codex delegation proxy (analyst/architect/critic/ralph roles)
├── hooks/
│   ├── hooks.json               # Hook config (matcher: "(^|:)codex-")
│   └── detect-codex-agent.sh    # SubagentStart detection script
├── scripts/
│   └── build-server.mjs         # esbuild bundling
├── bridge/
│   ├── coral-codex.cjs         # Codex MCP server bundle (committed)
│   └── coral-discuss.cjs       # Discuss MCP server bundle (committed)
├── docs/                        # Documentation
├── vitest.config.ts             # Test configuration
├── package.json
├── tsconfig.json
└── .gitignore
```

## Module Dependency Graph

### Codex Server (`cx`)

```
codex/server.ts  (wiring only — SDK setup, transport, signals)
  └── codex/server-handlers.ts  (business logic, dispatch, background/foreground)
        ├── codex/schemas.ts        (zod input validation)
        ├── codex/codex-executor.ts
        │     ├── codex/output-parser.ts  (pure functions)
        │     └── codex/cli-detection.ts  (caching singleton)
        ├── codex/session-manager.ts      (file I/O, per-session files, atomic writes)
        ├── codex/progress.ts             (progress file I/O, pure helpers)
        └── shared/mcp-utils.ts           (textResult, jsonResult)

types.ts ← referenced by all codex modules
```

### Discuss Server (`dc`)

```
discuss/server.ts  (wiring only — SDK setup, transport, signals)
  └── discuss/server-handlers.ts  (tool dispatch + discuss_wait integration)
        ├── discuss/schemas.ts          (zod input validation)
        ├── discuss/state-machine.ts    (pure state transitions, zero I/O)
        ├── discuss/session-store.ts    (I/O shell: atomic writes, cross-process lock)
        │     └── discuss/transcript.ts (rendering, called via save())
        ├── discuss/conditions.ts       (pure predicates for discuss_wait)
        ├── discuss/wait.ts             (async file polling)
        └── shared/mcp-utils.ts         (textResult, jsonResult)

discuss/types.ts ← referenced by all discuss modules
```

### Key Design: Functional Core / Imperative Shell

The discuss server separates pure logic from I/O:
- **Functional Core** (`state-machine.ts`): all state transitions are pure functions `(state, args) → Result<T>`. Zero `node:fs` imports. Fully testable without filesystem.
- **Imperative Shell** (`session-store.ts`): handles atomic writes, cross-process locking, state migration, and incremental transcript append.
- **Condition predicates** (`conditions.ts`): pure boolean functions used by `discuss_wait` to detect when to unblock.
- **Wait module** (`wait.ts`): polls `state.json` at intervals until a predicate is true or timeout expires.
