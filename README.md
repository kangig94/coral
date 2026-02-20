# Coral

A Claude Code plugin that bridges Claude Code and OpenAI Codex CLI.

## Installation

```bash
npm install -g @openai/codex                                    # Codex CLI
```

```
/plugin marketplace add https://github.com/kangig94/coral       # in Claude Code
/plugin install coral
```

### Statusline (Optional)

Set up the coral HUD statusline for real-time session info:

```
/coral:statusline install
```

Displays: `opus 4.6 │ 5m │ 5h:56% wk:38% │ ctx:45%`

To remove: `/coral:statusline uninstall`

## Usage

```
/coral:codex review auth.ts for security issues
/coral:codex what about the token refresh logic?   # auto-continues session
```

Consecutive `/coral:codex` calls continue the same session. Say "new" to start fresh.

```
/coral:init-project                                # set up AI-assisted dev for any project
```

Generates `.claude/CLAUDE.md`, rules, agents, docs, and settings based on the detected tech stack.

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

Plans are saved to `.claude/coral/plans/`. Ralph skills are best for implementing an existing plan.

## Knowledge Base

Coral automatically manages a project-local KB (`.claude/coral/kb/`) to prevent repeating mistakes across sessions. Non-obvious discoveries are buffered as memos during work, checked on errors before debugging from scratch, and promoted to permanent entries on task completion. Git-tracked for multi-device sync.

## Configuration

```bash
export CORAL_CODEX_MODEL=gpt-5.3-codex  # Default model

# Or set in .claude/settings.json:
{
  "env": {
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
