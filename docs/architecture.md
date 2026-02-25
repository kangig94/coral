# Architecture

## System Structure

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Claude Code                                                              │
│                                                                           │
│  ┌──────────────┐  ┌───────────────┐  ┌────────────────────────────────┐  │
│  │ SessionStart │  │ SubagentStart │  │  Skills /coral:*               │  │
│  │ Hook         │  │ Hook          │  │  discuss, codex, plan,         │  │
│  │ (CLAUDE.md   │  │ (codex-*      │  │  ralph, analyze, ...           │  │
│  │  injection)  │  │  delegation)  │  └───────────────┬────────────────┘  │
│  └──────────────┘  └───────┬───────┘                  │                   │
│                            │                ┌─────────┴─────────┐         │
│                            ▼                ▼                   ▼         │
│  ┌────────────────────────────────┐  ┌─────────────────────────────────┐  │
│  │  MCP Server "cx"               │  │  MCP Server "dc"                │  │
│  │  (bridge/coral-codex.cjs)      │  │  (bridge/coral-discuss.cjs)     │  │
│  │                                │  │                                 │  │
│  │  Tool: codex                   │  │  Tools: discuss (2 ops)         │  │
│  │  (exec, list, fork, abort)     │  │    + discuss_lead (7 ops)       │  │
│  │                                │  │                                 │  │
│  │  Session: ~/.claude/coral/     │  │  Session: {project}/.claude/    │  │
│  │           sessions/            │  │           coral/discuss/        │  │
│  └───────────────┬────────────────┘  └─────────────────────────────────┘  │
│                  │                                                        │
└──────────────────┼────────────────────────────────────────────────────────┘
                   ▼
        ┌──────────────────────┐
        │  Codex CLI (v0.104+) │
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
     → Agents call codex({ op: "exec", ... }) → results synthesized
     → Other intents:
        → Skill reads agent protocol (agents/codex-proxy.md)
        → Skill calls codex({ op: "exec" }) directly (no subagent)
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
     → discuss_lead({ op: "_7_end", synthesis }) → final transcript via _4_transcript
     → Present synthesis to user, shutdown teammates
```

### 5. Session-based Conversation (Codex)

```
User → codex({ op: "exec", name: "review", prompt: "analyze auth.ts" })
     → Codex execution → session ID acquired (thread.started event)
     → SessionManager writes ~/.claude/coral/sessions/<project-hash>/review.json (atomic write)
     → codex({ op: "exec", session: "review", prompt: "follow-up question" })
     → SessionManager looks up sessionId by name
     → codex exec resume SESSION_ID executed
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
└── 260221-1430-a1b2-ai-ethics/      # {YYMMDD}-{HHMM}-{rand4}-{topic-slug}
    ├── state.json          # Atomic writes via .tmp + rename
    ├── state.lock/         # Cross-process mkdir lock (transient)
    └── transcript.md       # Incremental append (human-readable)
```

Each session directory is created atomically with collision detection. State mutations are serialized via a cross-process `mkdir`-based lock (`state.lock/`). `transcript.md` is append-only — the `transcript_rendered` cursor tracks which entries have been written to the markdown file.

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
├── .claude-plugin/              # Plugin + marketplace manifests
├── src/
│   ├── types.ts                 # Shared Codex type definitions
│   ├── shared/
│   │   └── mcp-utils.ts         # Shared MCP response utilities
│   ├── codex/                   # Codex MCP server (cx)
│   │   ├── server.ts            # Composition root
│   │   ├── server-handlers.ts   # Business logic
│   │   ├── schemas.ts           # Zod validation
│   │   ├── codex-executor.ts    # Process management
│   │   ├── output-parser.ts     # JSONL parsing
│   │   ├── cli-detection.ts     # CLI availability
│   │   ├── session-manager.ts   # Session persistence
│   │   └── progress.ts          # Background progress files
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
├── skills/                      # Slash command SKILL.md files (one dir per skill)
├── agents/                      # Agent protocol definitions
├── hooks/
│   ├── hooks.json               # Hook config (matcher, timeout)
│   ├── detect-codex-agent.mjs   # SubagentStart delegation hook
│   ├── kb-lookup-reminder.mjs   # PostToolUseFailure KB hint
│   ├── kb-memo-reminder.mjs     # PreToolUse memo hint
│   ├── kb-promote-reminder.mjs  # Stop/PreCompact promotion hint
│   └── discuss-idle-guard.mjs   # TeammateIdle bid/speak enforcer
├── scripts/
│   └── build-server.mjs         # esbuild bundling + version sync
├── bridge/
│   ├── coral-codex.cjs          # Codex MCP server bundle (committed)
│   └── coral-discuss.cjs        # Discuss MCP server bundle (committed)
├── docs/                        # Documentation
├── vitest.config.ts
├── package.json
├── tsconfig.json
└── .gitignore
```

## Module Dependency Graph

### Codex Server (`cx`)

```
codex/server.ts  (composition root — wiring only)
  └── codex/server-handlers.ts  (business logic, dispatch, background/foreground)
        ├── codex/schemas.ts        (Zod input validation)
        ├── codex/codex-executor.ts (process spawn, timeout, buffer)
        │     ├── codex/output-parser.ts  (pure JSONL → result)
        │     └── codex/cli-detection.ts  (cached singleton)
        ├── codex/session-manager.ts     (atomic file I/O)
        ├── codex/progress.ts            (progress file I/O)
        └── shared/mcp-utils.ts          (textResult, jsonResult)

types.ts ← referenced by all codex modules
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
