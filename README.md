# Coral

A Claude Code plugin providing structured agents with Codex CLI bridge and moderated multi-agent discussions.

## Installation

```bash
# Codex CLI
npm install -g @openai/codex

# in Claude Code
/plugin marketplace add https://github.com/kangig94/coral
/plugin install coral
```

### Statusline (Optional)

Set up the coral HUD statusline for real-time session info:

```
/coral:statusline install
```

Displays: `opus 4.6 │ 5m │ 5h:56% (3:12) wk:38% (5.2d) │ ctx:45%`

To remove: `/coral:statusline uninstall`

## Usage

Consecutive `/coral:codex` calls continue the same session. Say "new" to start fresh.

```
/coral:codex review auth.ts for security issues

# auto-continues session
/coral:codex what about the token refresh logic?
```

Generates `.claude/CLAUDE.md`, rules, agents, docs, and settings based on the detected tech stack.

```
# set up AI-assisted dev for any project
/coral:init-project "description of the project"
```

### Discuss

Coral's moderated multi-agent discussion system. Multiple AI agents with distinct personas debate a topic through structured turn-taking — all coordinated by a dedicated MCP server that enforces fair participation, prevents deadlocks, and ensures clean termination.

```
/coral:discuss AI ethics in healthcare
/coral:discuss pros and cons of microservices vs monolith
/coral:discuss should AI-generated art be copyrightable
```

**How it works:**

1. **Persona generation** — Coral analyzes the topic and spawns 3-8 unique personas in parallel (e.g., bioethicist, patient advocate, AI researcher, hospital administrator). Each has distinct expertise, communication style, and perspective biases.

2. **Bidding for the floor** — Each round, agents bid 0-100 on how strongly they want to speak. The highest bidder above the threshold wins. This prevents any single agent from monopolizing and surfaces the most urgent arguments first.

3. **Evidence-backed speeches** — Winners research via web search before speaking. The server enforces that all agents read the latest transcript before bidding — no uninformed participation allowed.

4. **Multi-epoch continuation** — When all speaking quotas are exhausted, agents vote: agree to end (0) or continue (1). A single dissenting vote triggers a new epoch with fresh quotas for everyone. Discussions go as deep as the agents need.

5. **Structured synthesis** — When the discussion concludes, the moderator generates a structured summary: key arguments, turning points, points of consensus, and unresolved questions.

**Debate mode** — Topics with adversarial framing (pro/con, vs, should/should not) automatically activate debate mode. Agents declare stances, and if the sides are imbalanced (e.g., 5 pro vs 1 con), Coral assigns a devil's advocate from the majority to argue the opposing position.

**Architecture:**

```
discuss-lead (moderator)
  ├── persona-generator ×N (parallel)
  ├── discuss MCP server (state, enforcement, transcript)
  └── dc-{agent} ×N (discussant teammates)
        └── discuss_wait → bid/speak/vote loop
```

The MCP server owns all state transitions. Agents cannot speak out of turn, bid without reading context, or bypass the voting protocol. Transcripts are saved to `.claude/coral/discuss/` as both structured JSON and readable Markdown.

### Skills

| Skill | Description | Example |
|---|---|---|
| `/coral:architect` | Architecture review (Claude) | `review the architecture of this module` |
| `/coral:critic` | Plan/code critique (Claude) | `review this plan` |
| `/coral:analyze` | Deep analysis (Claude) | `investigate the root cause of this error` |
| `/coral:codex-analyze` | Deep analysis (Codex + Claude synthesis) | `investigate why the session lookup is slow` |
| `/coral:plan` | Planning with architect/critic review | `add retry logic to the API client` |
| `/coral:coplan` | Cross-model planning (Codex reviews) | `redesign the session management system` |
| `/coral:ralph` | Persistent execution loop (sonnet) | `implement the caching layer` |
| `/coral:codex-ralph` | Persistent execution via Codex (sonnet) | `implement the caching layer` |
| `/coral:init-project` | Project initialization orchestrator | `"React + FastAPI project"` |
| `/coral:discuss` | Moderated multi-agent discussion | `AI ethics in healthcare` |
| `/coral:statusline` | HUD statusline setup | `install` |

Plans are saved to `.claude/coral/plans/`. Ralph skills are best for implementing an existing plan.

## Knowledge Base

Coral automatically manages a project-local KB (`.claude/coral/kb/`) to prevent repeating mistakes across sessions. Non-obvious discoveries are buffered as memos during work, checked on errors before debugging from scratch, and promoted to permanent entries on task completion. Git-tracked for multi-device sync.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CORAL_CODEX_MODEL` | `gpt-5.3-codex` | Default Codex CLI model |
| `CORAL_DISCUSS_BID_THRESHOLD` | `50` | Minimum bid score (1-100) for floor eligibility in discussions |
| `CORAL_DISCUSS_TTL_DAYS` | `30` | Days before completed discuss sessions are auto-pruned |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | _(unset)_ | **Required** for `/coral:discuss`. Set to `1` to enable Agent Teams. |
| `ENABLE_TOOL_SEARCH` | `auto` | Lazy-load MCP tool definitions instead of injecting all into system prompt. `auto` (≥10%), `auto:5` (≥5%), `true` (always on). |

Set in `.claude/settings.json` (persists across sessions):

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CORAL_DISCUSS_BID_THRESHOLD": "50",
    "CORAL_DISCUSS_TTL_DAYS": "30",
    "ENABLE_TOOL_SEARCH": "auto:5"
  }
}
```

Or via shell: `export CORAL_CODEX_MODEL=gpt-5.3-codex`

## Development

```bash
npm install
npm run build     # TypeScript compile + esbuild bundle
npm test          # Run tests with vitest
```

### Git Workflow

- **`main`**: Release branch. Always deployable.
- **`dev`**: Integration branch. Direct commits allowed for small changes.
- **Feature branches**: Branch from `dev`, rebase merge back via PR.
- **Release**: Squash merge `dev` → `main` via PR.

Merge policy:
- **feature → dev**: rebase (preserve individual commits)
- **dev → main**: squash (one commit per release, traceable via `(#N)`)

## Adding New Agents

### Codex-bound Agent

Create `agents/codex-<name>.md` — it automatically becomes a Codex delegation agent:

```yaml
---
name: codex-<name>
description: <description>
tools: mcp__plugin_coral_cx__codex_session_create, mcp__plugin_coral_cx__codex_session_send
---
```

### Claude-native Agent

Create `agents/<name>.md` (without `codex-` prefix):

```yaml
---
name: <name>
description: "<description>. Use PROACTIVELY when [trigger]. NOT for [exclusion]."
model: opus
disallowedTools: Write, Edit
---
```

## Documentation

Detailed technical documentation is available in the `docs/` directory:

- [Architecture](docs/architecture.md) — Architecture and data flow
- [MCP Tools](docs/mcp-tools.md) — Input/output specs for all MCP tools (Codex + Discuss)
- [Core Modules](docs/core-modules.md) — TypeScript module details
- [Agents](docs/agents.md) — Agent definitions and routing guarantees
- [Hooks](docs/hooks.md) — SubagentStart hook behavior
- [Skills](docs/skills.md) — Slash command usage
- [Build System](docs/build-system.md) — Build pipeline
- [Configuration](docs/configuration.md) — Environment variables and config files

## Requirements

- Node.js 18+
- Codex CLI v0.101+ (`npm install -g @openai/codex`)
