# Configuration

Environment variables, config files, and the plugin manifest.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CORAL_CODEX_MODEL` | `gpt-5.3-codex` | Default Codex model |
| `CORAL_DISCUSS_BID_THRESHOLD` | `50` | Minimum bid score (1–100) for discuss floor eligibility |
| `CORAL_DISCUSS_TTL_DAYS` | `30` | Days before completed discuss sessions are auto-pruned |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | _(unset)_ | Required for `/coral:discuss`. Set to `1`. |

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

Registers both MCP servers with Claude Code.

```json
{
  "mcpServers": {
    "cx": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/bridge/coral-codex.cjs"]
    },
    "dc": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/bridge/coral-discuss.cjs"]
    }
  }
}
```

| Field | Description |
|---|---|
| `cx` | Codex MCP server (tool prefix: `mcp__plugin_coral_cx__*`) — Codex CLI session tools |
| `dc` | Discuss MCP server (tool prefix: `mcp__plugin_coral_dc__*`) — discussion session tools |
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
| Node.js 18+ | Runtime | nvm, etc. |

### {project}/.claude/coral/discuss/ — Discuss Session Storage

Runtime-managed discuss session directories. Created by the `dc` MCP server.

```
{project}/.claude/coral/discuss/
└── 260221-1430-a1b2-ai-ethics/
    ├── state.json          # Session state (atomic writes via .tmp + rename)
    └── transcript.md       # Human-readable transcript (incremental append)
```

**Location**: `{project}/.claude/coral/discuss/{session_dir}/`
**Session ID format**: `yymmdd-HHmm-xxxx` (compact timestamp + 4-char random suffix)
**Directory name**: `{session_id}-{topic_slug}` (slug preserves CJK characters)
**Concurrency**: Cross-process `mkdir`-based lock (`state.lock/`) serializes state mutations

## File Role Summary

```
.claude-plugin/plugin.json  -> Claude Code recognizes the plugin
.mcp.json                   -> Claude Code registers/starts both MCP servers (cx + dc)
hooks/hooks.json            -> Claude Code configures SessionStart + SubagentStart hooks
hooks/detect-codex-agent.sh -> Detection script executed by the hook
.claude/coral/sessions/<project-hash>/*.json -> Runtime Codex session files (auto-created)
.claude/coral/discuss/<session-dir>/         -> Runtime discuss session dirs (auto-created)
bridge/coral-codex.cjs     -> Codex MCP server executable (committed)
bridge/coral-discuss.cjs   -> Discuss MCP server executable (committed)
```
