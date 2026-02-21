# Coral Plugin

A general-purpose Claude Code plugin that provides structured agents with a Codex CLI bridge.

## Key Features

- **TypeScript MCP server** wrapping Codex CLI with 4 tools
- **Agent auto-routing**: Hook + tools restriction + system prompt for triple-layer guarantee on `codex-*` prefix agents
- **Session persistence**: Name-based session registry for multi-turn conversations (atomic writes)
- **Skill commands**: `/coral:codex`, `/coral:analyze`, `/coral:codex-analyze`, `/coral:plan`, `/coral:coplan`, `/coral:ralph`, `/coral:codex-ralph`, `/coral:init-project`, `/coral:discuss`, `/coral:statusline`
- **Input validation**: Zod schema validation on all MCP tool inputs
- **Process management**: Child process tracking, 10MB buffer limit, graceful shutdown

## Quick Start

```bash
# Bundle is included in the repo — no build required
claude --plugin-dir /path/to/coral
```

For development:

```bash
npm install
npm run build     # TypeScript compile + esbuild bundle
npm test          # Run tests with vitest
```

## Documentation

| Document | Description |
|---|---|
| [Architecture](./architecture.md) | Architecture overview and data flow |
| [MCP Tools](./mcp-tools.md) | Detailed specs for all 4 MCP tools |
| [Core Modules](./core-modules.md) | TypeScript core module descriptions |
| [Agents](./agents.md) | Agent definitions and routing guarantees |
| [Hooks](./hooks.md) | SubagentStart hook-based auto-routing |
| [Skills](./skills.md) | Slash command usage |
| [Build System](./build-system.md) | Build pipeline and bundling |
| [Configuration](./configuration.md) | Environment variables and config files |

## Requirements

- Node.js 18+
- Codex CLI v0.101+ (`npm install -g @openai/codex`)
- Claude Code (plugin-compatible version)
