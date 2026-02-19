# Architecture

## System Structure

```
┌──────────────────────────────────────────────────────┐
│  Claude Code                                          │
│                                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ SessionStart  │  │ SubagentStart│  │   Skills    │ │
│  │ Hook          │  │ Hook         │  │  /coral:*   │ │
│  │ (CLAUDE.md    │  │ (codex-*     │  └──────┬──────┘ │
│  │  injection)   │  │  delegation) │         │        │
│  └──────────────┘  └──────┬───────┘         │        │
│                           │                  │        │
│                           ▼                  ▼        │
│  ┌─────────────────────────────────────────────────┐  │
│  │  MCP Server "coral" (bridge/coral-server.cjs)   │  │
│  │                                                  │  │
│  │  On new session:                                 │  │
│  │  - Prepend CLAUDE.md to prompt                   │  │
│  │  - --add-dir ~/.claude/coral/memo (sandbox)      │  │
│  │                                                  │  │
│  │  Tools: codex_execute, codex_session_create,     │  │
│  │         codex_session_send, codex_session_list,  │  │
│  │         codex_session_fork                       │  │
│  └────────────────────┬────────────────────────────┘  │
│                       │                                │
└───────────────────────┼────────────────────────────────┘
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
     → Skill calls mcp__cx__codex_execute
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
     → Agent calls mcp__cx__codex_execute (tools restriction leaves no alternative)
     → Codex response returned verbatim
```

### 3. Session-based Conversation

```
User → codex_session_create(name="review", prompt="analyze auth.ts")
     → Codex execution → thread_id acquired (thread.started event)
     → SessionManager writes ~/.claude/coral/sessions/<project-hash>/review.json (atomic write)
     → codex_session_send(session="review", prompt="follow-up question")
     → SessionManager looks up codexThreadId by name
     → codex exec resume THREAD_ID executed
     → lastUsedAt updated
```

### 4. Session Storage Layout

```
~/.claude/coral/sessions/
└── <project-hash>/                  # sha256(resolve(workingDirectory)).slice(0, 12)
    ├── review.json
    ├── auth-audit.json
    └── perf-pass.json
```

Each file is a single `SessionEntry`. Corrupt files are skipped with a warning; valid files continue loading.

### 5. Knowledge Base Storage

```
{project}/.claude/coral/kb/          # Git-tracked (multi-device sync)
├── domain-topic.md
└── ...

~/.claude/coral/memo/                # Device-local (buffer before promotion)
└── <project-hash>/
    └── <timestamp>-<topic>.md
```

- **KB** is project-local and git-tracked for cross-device sync
- **Memo** is global and device-local (ephemeral buffer)
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
│   └── mcp/
│       ├── server.ts            # MCP server entry point (stdio)
│       ├── schemas.ts           # Zod input validation schemas
│       ├── codex-executor.ts    # Codex CLI execution logic
│       ├── session-manager.ts   # Per-session file persistence
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
│   │   └── SKILL.md             # /coral:plan (Claude-native planning)
│   ├── coplan/
│   │   └── SKILL.md             # /coral:coplan (cross-model planning)
│   ├── statusline/
│   │   └── SKILL.md             # /coral:statusline (HUD setup)
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
  └── session-manager.ts      (file I/O, per-session files, atomic writes)

types.ts ← referenced by all modules
```

- `schemas.ts` — zod schemas + type extraction (pure definitions)
- `output-parser.ts` and `cli-detection.ts` — independent modules with no external dependencies
- `codex-executor.ts` — combines parser and detection modules + process management
- `session-manager.ts` — uses filesystem only (no Codex dependency), stores one JSON file per session
- `server.ts` — integrates MCP SDK + executor + session manager + graceful shutdown
