# Architecture

## System Structure

```
┌─────────────────────────────────────────────────┐
│  Claude Code                                     │
│                                                   │
│  ┌──────────┐   ┌──────────────────┐             │
│  │  Skills   │   │  SubagentStart   │             │
│  │ /coral:*  │   │  Hook (injection)│             │
│  └─────┬─────┘   └────────┬─────────┘             │
│        │                  │ Fires on "codex-*"    │
│        │                  │ Injects delegation    │
│        ▼                  ▼                       │
│  ┌────────────────────────────────┐               │
│  │  MCP Server "coral"            │               │
│  │  (bridge/coral-server.cjs)     │               │
│  │                                │               │
│  │  Tools:                        │               │
│  │  - codex_execute               │               │
│  │  - codex_session_create        │               │
│  │  - codex_session_send          │               │
│  │  - codex_session_list          │               │
│  │  - codex_session_fork          │               │
│  │                                │               │
│  │  Hardening:                    │               │
│  │  - Zod input validation        │               │
│  │  - Process tracking + limits   │               │
│  │  - Graceful shutdown (SIGTERM) │               │
│  └──────────┬─────────────────────┘               │
│             │                                     │
└─────────────┼─────────────────────────────────────┘
              ▼
   ┌──────────────────────┐
   │  Codex CLI (v0.101+) │
   │  codex exec --json   │
   │  --full-auto          │
   │  JSONL event stream   │
   └──────────────────────┘
```

## Data Flow

### 1. Direct Execution (Skill or MCP Tool Call)

```
User → /coral:codex "question"
     → Skill calls mcp__coral__codex_execute
     → Zod schema validation
     → MCP Server spawns codex exec
     → Codex CLI outputs JSONL to stdout
     → parseCodexJsonl() extracts text + thread_id
     → Result returned to user
```

### 2. Agent Delegation (Automatic Routing)

```
User → Task tool spawns codex-delegate agent
     → SubagentStart Hook fires (matcher: "codex-.*")
     → detect-codex-agent.sh detects "codex-" prefix
     → Delegation instructions injected via additionalContext
     → Agent calls mcp__coral__codex_execute (tools restriction leaves no alternative)
     → Codex response returned verbatim
```

### 3. Session-based Conversation

```
User → codex_session_create(name="review", prompt="analyze auth.ts")
     → Codex execution → thread_id acquired (thread.started event)
     → SessionManager registers in .claude/coral/sessions.json (atomic write)
     → codex_session_send(session="review", prompt="follow-up question")
     → SessionManager looks up codexThreadId by name
     → codex exec resume THREAD_ID executed
     → lastUsedAt updated
```

## Directory Structure

```
coral/
├── .claude-plugin/
│   └── plugin.json              # Plugin manifest
├── .mcp.json                    # MCP server registration
├── src/
│   ├── types.ts                 # Shared type definitions (CodexThreadEvent etc.)
│   └── mcp/
│       ├── server.ts            # MCP server entry point (stdio)
│       ├── schemas.ts           # Zod input validation schemas
│       ├── codex-executor.ts    # Codex CLI execution logic
│       ├── session-manager.ts   # Session registry + persistence
│       ├── output-parser.ts     # JSONL event parsing
│       ├── cli-detection.ts     # Codex CLI existence check
│       └── __tests__/           # Tests (vitest)
│           ├── schemas.test.ts
│           ├── output-parser.test.ts
│           ├── codex-executor.test.ts
│           ├── session-manager.test.ts
│           └── cli-detection.test.ts
├── skills/
│   ├── architect/
│   │   └── SKILL.md             # /coral:architect (Claude-native)
│   ├── critic/
│   │   └── SKILL.md             # /coral:critic (Claude-native)
│   ├── analyze/
│   │   └── SKILL.md             # /coral:analyze (Claude-native)
│   ├── ralph/
│   │   └── SKILL.md             # /coral:ralph (Claude-native)
│   ├── codex-ralph/
│   │   └── SKILL.md             # /coral:codex-ralph (Codex delegation)
│   ├── codex/
│   │   └── SKILL.md             # /coral:codex (Codex CLI)
│   ├── plan/
│   │   └── SKILL.md             # /coral:plan (Codex architect/critic)
│   └── session/
│       └── SKILL.md             # /coral:session (session management)
├── agents/
│   ├── architect.md             # Claude-native architecture analysis
│   ├── critic.md                # Claude-native plan/code review
│   ├── analyst.md               # Claude-native requirements gap analysis
│   ├── ralph.md                 # Claude-native persistent execution loop
│   ├── codex-delegate.md        # Codex general delegation
│   ├── codex-architect.md       # Codex architecture analysis delegation
│   ├── codex-critic.md          # Codex critical review delegation
│   ├── codex-analyst.md         # Codex analysis delegation
│   └── codex-ralph.md           # Codex persistent execution delegation
├── hooks/
│   ├── hooks.json               # Hook config (matcher: "codex-.*")
│   └── detect-codex-agent.sh    # SubagentStart detection script
├── scripts/
│   └── build-server.mjs         # esbuild bundling
├── bridge/
│   └── coral-server.cjs         # Bundle output (committed, no build required)
├── docs/                        # Documentation
├── vitest.config.ts             # Test configuration
├── package.json
├── tsconfig.json
└── .gitignore
```

## Module Dependency Graph

```
server.ts
  ├── schemas.ts        (zod input validation)
  ├── codex-executor.ts
  │     ├── output-parser.ts  (pure functions)
  │     └── cli-detection.ts  (caching singleton)
  └── session-manager.ts      (file I/O, atomic writes)

types.ts ← referenced by all modules
```

- `schemas.ts` — zod schemas + type extraction (pure definitions)
- `output-parser.ts` and `cli-detection.ts` — independent modules with no external dependencies
- `codex-executor.ts` — combines parser and detection modules + process management
- `session-manager.ts` — uses filesystem only (no Codex dependency)
- `server.ts` — integrates MCP SDK + executor + session manager + graceful shutdown
