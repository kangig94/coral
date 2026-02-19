# Coral

A Claude Code plugin that bridges Claude Code and OpenAI Codex CLI.

## Installation

### Via Marketplace (Recommended)

```bash
# 1. Install Codex CLI (required)
npm install -g @openai/codex
```

Then in Claude Code:

```
# 2. Add to marketplace
/plugin marketplace add https://github.com/kangig94/coral

# 3. Install plugin
/plugin install coral
```

MCP tools, agents, skills, and hooks are all available immediately.

### Manual

```bash
# 1. Install Codex CLI (required)
npm install -g @openai/codex

# 2. Clone and load plugin
git clone https://github.com/kangig94/coral.git
claude --plugin-dir /path/to/coral
```

The bundled output (`bridge/coral-server.cjs`) is included in the repository, so no build step is needed.

### Statusline (Optional)

Set up the coral HUD statusline for real-time session info:

```
/coral:statusline install
```

Displays: `opus 4.6 │ 5m │ 5h:56% wk:38% │ ctx:45%`

To remove: `/coral:statusline uninstall`

## Usage

### Project Setup

Initialize any project for AI-assisted development:

```
/coral:init-project
```

Generates `.claude/CLAUDE.md` (slim hub), `.claude/rules/` (modular rules with `paths:` frontmatter), domain-specific agents, architecture docs, dev guide, and settings — based on the project's detected tech stack. Supports 30+ domains across frontend, backend, mobile, infra, ML, systems, and GPU.

For new projects, run with `new` to scaffold via conversation:

```
/coral:init-project new
```

### Quick Execution

Use slash commands to query Codex directly:

```
/coral:codex implement fibonacci sequence in Python
/coral:codex analyze this code for security vulnerabilities
```

Consecutive `/coral:codex` calls automatically continue the same session — no need to create a named session for multi-turn conversations:

```
/coral:codex review auth.ts for security issues
# ... Codex responds ...
/coral:codex what about the token refresh logic?
# continues the same Codex session
```

To start fresh instead of continuing, say "new" in your prompt.

### Sessions (Multi-turn Conversations)

Create named sessions to maintain conversation context with Codex:

```
# Create session
/coral:codex session create my-review analyze the auth logic in auth.ts

# Follow-up
/coral:codex session send my-review tell me more about JWT token expiry handling

# Fork session (resume-based)
/coral:codex session fork my-review

# List sessions
/coral:codex session list
```

### Knowledge Base

Coral automatically manages a knowledge base to prevent repeating mistakes across sessions:

- **Memo**: During work, non-obvious discoveries are buffered to `.claude/coral/memo/`
- **Lookup**: On errors, the KB at `{project}/.claude/coral/kb/` is checked before debugging from scratch
- **Promotion**: On task completion, valuable memos are promoted to permanent KB entries
- **Invalidation**: KB entries that contradict current code are updated or removed

KB files are stored in the project directory (`.claude/coral/kb/`) for git-based multi-device sync. See `CLAUDE.md` for behavioral details.

### Claude-native Analysis

Slash commands for Claude to analyze directly (default routing):

```
/coral:architect review the architecture of this module
/coral:critic review this plan
/coral:analyze investigate the root cause of this error
```

### Planning

Claude-native planning with parallel architect/critic self-review:

```
/coral:plan add retry logic to the API client
```

Cross-model planning — Claude synthesizes, Codex reviews (architect + critic):

```
/coral:coplan redesign the session management system
```

Both use the synthesizer model — feedback is classified as Adopt / Adapt / Defer / Diverge. Plans are saved to `.claude/coral/plans/`.

### Persistent Execution

Use ralph for tasks that require guaranteed completion with verification:

```
/coral:ralph implement the caching layer and verify all tests pass
```

### Persistent Execution via Codex

Use codex-ralph for Codex-powered execution with Claude-controlled verification loop:

```
/coral:codex-ralph implement the caching layer and verify all tests pass
```

### Agent Delegation

Spawn agents via the Task tool. Claude-native is default; Codex is used only on explicit request:

| Agent | Type | Purpose |
|---|---|---|
| `architect` | Claude-native | Architecture analysis (default) |
| `critic` | Claude-native | Plan/code review (default) |
| `analyst` | Claude-native | Requirements gap analysis (default) |
| `ralph` | Claude-native | Persistent execution with verification (default) |
| `planner` | Claude-native | Multi-round planning with parallel reviewer verification |
| `init-project` | Claude-native | Project initialization orchestrator (scan → plan → execute → report) |
| `codex-delegate` | Codex-bound | General — forwards all work to Codex |
| `codex-architect` | Codex-bound | Architecture analysis via Codex |
| `codex-critic` | Codex-bound | Critical review via Codex |
| `codex-analyst` | Codex-bound | Analysis via Codex |
| `codex-ralph` | Codex-bound | Single-shot Codex execution (Claude controls loop) |

## MCP Tools

Four tools provided by the plugin:

| Tool | Description |
|---|---|
| `codex_session_create` | Create a session and execute a prompt (name auto-generated if omitted) |
| `codex_session_send` | Send a follow-up message to an existing session |
| `codex_session_list` | List registered sessions |
| `codex_session_fork` | Fork a session to start a new conversation (resume-based) |

All inputs are validated at runtime with zod schemas.

## Configuration

Adjust behavior with environment variables:

```bash
export CORAL_CODEX_TIMEOUT_MS=900000        # Timeout (default: 900000ms / 15 min)
export CORAL_CODEX_MODEL=gpt-5.3-codex  # Default model
```

Or set them in `.claude/settings.json`:

```json
{
  "env": {
    "CORAL_CODEX_TIMEOUT_MS": "600000",
    "CORAL_CODEX_MODEL": "gpt-5.3-codex"
  }
}
```

## Development

```bash
npm install
npm run build     # TypeScript compile + esbuild bundle
npm test          # Run tests with vitest
```

## Adding New Agents

### Codex-bound Agent

Create `agents/codex-<name>.md` — it automatically becomes a Codex delegation agent:

```yaml
---
name: codex-<name>
description: <description>
tools: mcp__cx__codex_session_create, mcp__cx__codex_session_send
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
- [MCP Tools](docs/mcp-tools.md) — Input/output specs for all 4 tools
- [Core Modules](docs/core-modules.md) — TypeScript module details
- [Agents](docs/agents.md) — Agent definitions and routing guarantees
- [Hooks](docs/hooks.md) — SubagentStart hook behavior
- [Skills](docs/skills.md) — Slash command usage
- [Build System](docs/build-system.md) — Build pipeline
- [Configuration](docs/configuration.md) — Environment variables and config files

## Requirements

- Node.js 18+
- Codex CLI v0.101+ (`npm install -g @openai/codex`)
- jq (for hook scripts)
