# Configuration

Environment variables, config files, and the plugin manifest.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CORAL_CODEX_MODEL` | `gpt-5.3-codex` | Default Codex model |

### Usage — Shell

```bash
export CORAL_CODEX_MODEL=gpt-5.3-codex
```

### Usage — .claude/settings.json

Alternatively, set environment variables in `.claude/settings.json` (project-level or global). This persists across sessions without shell exports.

```json
{
  "env": {
    "CORAL_CODEX_MODEL": "gpt-5.3-codex"
  }
}
```

## Config Files

### .claude-plugin/plugin.json — Plugin Manifest

Metadata for Claude Code to recognize the plugin.

| Field | Description |
|---|---|
| `name` | Plugin name (used as skill prefix: `coral:*`) |
| `version` | Semantic version (auto-synced from `package.json` on build) |
| `description` | Plugin description |
| `author` | Author info |

Version is managed in `package.json` (single source of truth) and synced to `plugin.json` and `marketplace.json` automatically during build.

### .mcp.json — MCP Server Registration

Registers the MCP server with Claude Code.

```json
{
  "mcpServers": {
    "cx": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/bridge/coral-server.cjs"]
    }
  }
}
```

| Field | Description |
|---|---|
| `cx` | MCP server name (tool prefix in Claude Code: `mcp__plugin_coral_cx__*`) |
| `command` | Execution command |
| `args` | Execution arguments (`CLAUDE_PLUGIN_ROOT` is auto-replaced) |

### .claude/coral/sessions/<project-hash>/<session-name>.json — Session Files

Runtime-managed per-session storage files.

```json
{
  "name": "session-name",
  "codexThreadId": "thread-uuid-from-codex",
  "model": "gpt-5.3-codex",
  "createdAt": "2026-02-18T08:30:00.000Z",
  "lastUsedAt": "2026-02-18T09:15:00.000Z",
  "workingDirectory": "/home/user/project"
}
```

**Location**: `~/.claude/coral/sessions/<project-hash>/<session-name>.json`
**Project hash**: `sha256(resolve(workingDirectory)).slice(0, 12)`
**Creation**: Auto-created by `SessionManager` (including project hash directory)
**Updates**: Written to disk immediately on session register, use, or delete (atomic write via `*.tmp` + rename)

### hooks/hooks.json — Hook Configuration

Two hooks are configured:

- **SessionStart**: Injects CLAUDE.md content into Claude's context at session start
- **SubagentStart**: Detects `codex-*` agents (bare or namespaced) and injects delegation instructions

See [Hooks documentation](./hooks.md) for details.

## Dependencies

### Runtime Dependencies

| Package | Version | Purpose |
|---|---|---|
| `@modelcontextprotocol/sdk` | ^1.26.0 | MCP server framework |
| `zod` | ^3.23.8 | Schema validation (MCP SDK dependency + input validation) |

### Dev Dependencies

| Package | Version | Purpose |
|---|---|---|
| `typescript` | ^5.7.2 | TypeScript compiler |
| `@types/node` | ^22.19.7 | Node.js type definitions |
| `esbuild` | ^0.27.2 | Build bundler |
| `vitest` | ^4.0.17 | Test framework |

### External Dependencies

| Tool | Purpose | Installation |
|---|---|---|
| Codex CLI v0.101+ | OpenAI model execution | `npm install -g @openai/codex` |
| jq | JSON parsing in hook scripts | System package manager (hook skips silently if missing) |
| Node.js 18+ | Runtime | nvm, etc. |

## File Role Summary

```
.claude-plugin/plugin.json  -> Claude Code recognizes the plugin
.mcp.json                   -> Claude Code registers/starts the MCP server
hooks/hooks.json            -> Claude Code configures SessionStart + SubagentStart hooks
hooks/detect-codex-agent.sh -> Detection script executed by the hook
.claude/coral/sessions/<project-hash>/*.json -> Runtime per-session files (auto-created)
bridge/coral-server.cjs     -> MCP server executable (committed, no build required)
```
