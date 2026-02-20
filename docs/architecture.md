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
│  │                                                  │  │
│  │  Tools: codex_session_create,                     │  │
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

### 1. Skill-to-Agent Routing

```
User → /coral:codex "question"
     → Skill detects persona (architect/critic/analyze/ralph/none)
     → Skill spawns Task with selected subagent_type (coral:codex-*)
     → SubagentStart Hook fires (matcher: "(^|:)codex-")
     → Delegation instructions injected via additionalContext
     → Agent calls mcp__plugin_coral_cx__codex_session_create
     → Codex response returned to skill → user
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

### 3. Direct Agent Delegation

```
User → Task tool spawns codex-delegate agent
     → SubagentStart Hook fires (matcher: "(^|:)codex-")
     → detect-codex-agent.sh detects "codex-" prefix (with optional coral: namespace)
     → Delegation instructions injected via additionalContext
     → Agent calls mcp__plugin_coral_cx__codex_session_create
     → Codex response returned verbatim
```

### 4. Session-based Conversation

```
User → codex_session_create(name="review", prompt="analyze auth.ts")
     → Codex execution → thread_id acquired (thread.started event)
     → SessionManager writes ~/.claude/coral/sessions/<project-hash>/review.json (atomic write)
     → codex_session_send(session="review", prompt="follow-up question")
     → SessionManager looks up codexThreadId by name
     → codex exec resume THREAD_ID executed
     → lastUsedAt updated
```

### 5. Session Storage Layout

```
~/.claude/coral/sessions/
└── <project-hash>/                  # sha256(resolve(workingDirectory)).slice(0, 12)
    ├── review.json
    ├── auth-audit.json
    └── perf-pass.json
```

Each file is a single `SessionEntry`. Corrupt files are skipped with a warning; valid files continue loading.

### 6. Knowledge Base Storage

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
│   └── statusline/
│       └── SKILL.md             # /coral:statusline (HUD setup)
├── agents/
│   ├── architect.md             # Claude-native architecture analysis
│   ├── critic.md                # Claude-native plan/code review
│   ├── analyst.md               # Claude-native requirements gap analysis
│   ├── ralph.md                 # Claude-native persistent execution loop
│   ├── planner.md              # Claude-native multi-round planning
│   ├── init-project.md         # Project initialization orchestrator
│   ├── codex-delegate.md        # Codex general delegation
│   ├── codex-architect.md       # Codex architecture analysis delegation
│   ├── codex-critic.md          # Codex critical review delegation
│   ├── codex-analyst.md         # Codex analysis delegation
│   └── codex-ralph.md           # Codex persistent execution delegation
├── hooks/
│   ├── hooks.json               # Hook config (matcher: "(^|:)codex-")
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
