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
│  │  Tools: codex                  │  │  Tools: discuss + 8 ops         │  │
│  │  (exec, list, fork, abort)     │  │  (create/bid/wait/speak/        │  │
│  │                                │  │   transcript/state/end/         │  │
│  │                                │  │   epoch_summary), persona_seed  │  │
│  │  Session: ~/.claude/coral/     │  │                                 │  │
│  │           sessions/            │  │  Session: {project}/.claude/    │  │
│  │                                │  │           coral/discuss/        │  │
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
     → Analyze?  → Direct MCP call with analyst protocol (no subagent)
     → Ralph?    → Direct MCP call with ralph protocol (no subagent)
     → General?  → Direct MCP call, verbatim prompt (no subagent)
```

### 4. Discuss - Moderated Multi-Agent Discussion

```
User → /coral:discuss "AI ethics in healthcare"
     → Skill reads agents/discuss-lead.md (protocol injection)
     → Moderator analyzes topic → determines 3-8 roles
     → Spawns persona-generator agents in parallel (Task tool)
     → discuss({ "op": "create", topic, agents }) → session_id, session_dir
     → TeamCreate "coral-dc-{session_id}"
     → Spawns discussant teammates (dc-{agent_name})
     → Discussion Loop:
        → Broadcast "Step N. Call `discuss({ op: "bid", ... })`."
        → discuss({ op: "wait", condition: "all_bids", ... }) → auto-resolves → 4-way branch
          → winner → notify → discuss({ op: "wait", condition: "speech_delivered", ... }) → broadcast transcript
          → no_winner + new_epoch → epoch transition (server auto-reset quotas)
          → no_winner → synthesis (all_below_threshold / all_blocked / max_epochs_reached)
          → timeout → force end
     → `discuss({ op: "end", ... })` → full transcript → synthesis → present to user
     → Shutdown teammates, TeamDelete
```

### 5. Session-based Conversation (Codex)

```
User → codex({ op: "exec", name="review", prompt="analyze auth.ts" })
     → Codex execution → session ID acquired (thread.started event)
     → SessionManager writes ~/.claude/coral/sessions/<project-hash>/review.json (atomic write)
     → codex({ op: "exec", session="review", prompt="follow-up question" })
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
└── 260221-1430-a1b2-ai-ethics/
    ├── state.json          # Atomic writes via .tmp + rename
    ├── state.lock/         # Cross-process mkdir lock (transient)
    └── transcript.md       # Incremental append (human-readable)
```

Each session directory is created atomically with collision detection. State mutations are serialized via a cross-process `mkdir`-based lock (`state.lock/`). Transcript.md is append-only - `transcript_rendered` cursor tracks which entries have been written to .md.

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
│   ├── types.ts                 # Shared type definitions
│   ├── shared/                  # Shared MCP utilities
│   ├── codex/                   # Codex MCP server (cx)
│   └── discuss/                 # Discuss MCP server (dc)
├── skills/                      # Slash command SKILL.md files (one dir per skill)
├── agents/                      # Agent protocol definitions
├── hooks/
│   ├── hooks.json               # Hook config (matcher, timeout)
│   └── detect-codex-agent.sh   # SubagentStart detection script
├── scripts/
│   └── build-server.mjs        # esbuild bundling
├── bridge/
│   ├── coral-codex.cjs         # Codex MCP server bundle (committed)
│   └── coral-discuss.cjs       # Discuss MCP server bundle (committed)
├── docs/                        # Documentation
├── vitest.config.ts
├── package.json
├── tsconfig.json
└── .gitignore
```

## Module Dependency Graph

### Codex Server (`cx`)

```
codex/server.ts  (wiring only - SDK setup, transport, signals)
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
discuss/server.ts  (wiring only - SDK setup, transport, signals)
  └── discuss/server-handlers.ts  (tool dispatch + `discuss({ op: "wait", ... })` integration)
        ├── discuss/schemas.ts          (zod input validation)
        ├── discuss/state-machine.ts    (pure state transitions, zero I/O)
        ├── discuss/session-store.ts    (I/O shell: atomic writes, cross-process lock)
        │     └── discuss/transcript.ts (rendering, called via save())
        ├── discuss/persona-seed.ts      (pure k-DPP sampling, zero I/O)
        ├── discuss/conditions.ts       (pure predicates for `discuss({ op: "wait", ... })`)
        ├── discuss/wait.ts             (async file polling)
        └── shared/mcp-utils.ts         (textResult, jsonResult)

discuss/types.ts ← referenced by all discuss modules
```

### Key Design: Functional Core / Imperative Shell

The discuss server separates pure logic from I/O:
- **Functional Core** (`state-machine.ts`): all state transitions are pure functions `(state, args) → Result<T>`. Zero `node:fs` imports. Fully testable without filesystem.
- **Imperative Shell** (`session-store.ts`): handles atomic writes, cross-process locking, state migration, and incremental transcript append.
- **Condition predicates** (`conditions.ts`): pure boolean functions used by `discuss({ op: "wait", ... })` to detect when to unblock.
- **Wait module** (`wait.ts`): polls `state.json` at intervals until a predicate is true or timeout expires.
