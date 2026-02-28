# Configuration

Environment variables, config files, and the plugin manifest.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CORAL_CODEX_MODEL` | `gpt-5.3-codex` | Default Codex model for new sessions |
| `CORAL_DISCUSS_BID_THRESHOLD` | `30` | Minimum bid score (1–100) for floor eligibility. Stored per-session at creation time. |
| `CORAL_DISCUSS_MAX_EPOCHS` | `2` | Maximum epochs before discussion ends automatically (1–10). Stored per-session at creation time. |
| `CORAL_DISCUSS_QUOTA_PER_EPOCH` | `3` | Speaking turns per agent per epoch (1–10). Stored per-session at creation time. |
| `CORAL_DISCUSS_TTL_DAYS` | `30` | Days before completed discuss sessions are eligible for pruning |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | _(unset)_ | Required for `/coral:discuss`. Set to `1`. |

### Usage - Shell

```bash
export CORAL_CODEX_MODEL=gpt-5.3-codex
export CORAL_DISCUSS_BID_THRESHOLD=50
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

### Usage - .claude/settings.json

Set environment variables in `.claude/settings.json` (project-level or global). This persists across sessions without shell exports.

```json
{
  "env": {
    "CORAL_CODEX_MODEL": "gpt-5.3-codex",
    "CORAL_DISCUSS_BID_THRESHOLD": "50",
    "CORAL_DISCUSS_MAX_EPOCHS": "3",
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

## Config Files

### .claude-plugin/plugin.json - Plugin Manifest

Metadata for Claude Code to recognize the plugin.

| Field | Description |
|---|---|
| `name` | Plugin name (used as skill prefix: `coral:*`) |
| `version` | Semantic version (auto-synced from `package.json` on build) |
| `description` | Plugin description |
| `author` | Author info |

Version is managed in `package.json` (single source of truth) and synced to `plugin.json` and `marketplace.json` automatically during `npm run build`. Never edit the version in `plugin.json` directly.

### .mcp.json - MCP Server Registration

Registers both MCP servers with Claude Code. `cx` runs `bridge/coral-codex.cjs` and `dc` runs `bridge/coral-discuss.cjs` via Node.js stdio transport.

### hooks/hooks.json - Hook Configuration

Configures all 9 hooks: SessionStart (CLAUDE.md injection), SessionStart/compact (plan-mode recovery + KB promotion reminder), SubagentStart (codex agent detection), UserPromptSubmit (plan state tracking), PreToolUse (memo reminder), PostToolUse (silent failure detector), PostToolUseFailure (KB lookup reminder), Stop (KB promotion gate + plan state cleanup), TeammateIdle (discuss idle guard).

See [Hooks documentation](./hooks.md) for details.

### Codex Session Files

**Location**: `~/.claude/coral/sessions/<project-hash>/<session-name>.json`

**Project hash**: `sha256(resolve(workingDirectory)).slice(0, 12)` — isolates sessions per project

**Creation**: Auto-created by `SessionManager` when a new session starts

**Format**: Single `SessionEntry` JSON object per file

**Updates**: Written atomically (`.tmp` + rename) on session create, use, or delete

**Corruption handling**: Invalid JSON files are skipped with a warning; other sessions load normally

### Discuss Session Directories

**Location**: `{project}/.claude/coral/discuss/{session_dir}/`

**Session ID format**: `yymmdd-HHmm-xxxx` (compact timestamp + 4-char random suffix)

**Directory name**: `{session_id}-{topic_slug}` (slug preserves CJK characters, truncated to 40 chars)

**Concurrency**: Cross-process `mkdir`-based lock (`state.lock/`) serializes all state mutations

**Contents**:
- `state.json` — full discussion state (atomic writes via `.tmp` + rename)
- `state.lock/` — transient lock directory (created/removed per mutation)
- `transcript.md` — human-readable incremental append log

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
| Codex CLI v0.104+ | OpenAI model execution | `npm install -g @openai/codex` |
| Node.js 18+ | Runtime | nvm, etc. |

## File Role Summary

```
.claude-plugin/plugin.json  -> Claude Code recognizes the plugin
.mcp.json                   -> Claude Code registers/starts both MCP servers (cx + dc)
hooks/hooks.json            -> Claude Code configures all 8 hooks
hooks/detect-codex-agent.mjs  -> SubagentStart detection script
hooks/kb-lookup-reminder.mjs  -> PostToolUseFailure KB hint script
hooks/silent-failure-detector.mjs -> PostToolUse silent-failure KB hint script
hooks/kb-memo-reminder.mjs    -> PreToolUse memo reminder script
hooks/kb-promote-reminder.mjs -> Stop/Compact promotion script
hooks/plan-guard.mjs          -> Compact plan-mode recovery script
hooks/plan-state-tracker.mjs  -> UserPromptSubmit/Stop plan tracking script
hooks/discuss-idle-guard.mjs  -> TeammateIdle bid/speak/vote enforcer

~/.claude/coral/sessions/<project-hash>/*.json  -> Runtime Codex session files (auto-created)
{project}/.claude/coral/discuss/<session-dir>/  -> Runtime discuss session dirs (auto-created)

bridge/coral-codex.cjs   -> Codex MCP server bundle (committed)
bridge/coral-discuss.cjs -> Discuss MCP server bundle (committed)
```
