# Configuration

Environment variables, config files, and the plugin manifest.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CORAL_CODEX_MODEL` | `gpt-5.4` | Default Codex model for new sessions |
| `CORAL_CODEX_EFFORT` | `xhigh` | Codex reasoning effort (`low`, `medium`, `high`, `xhigh`) |
| `CORAL_CLAUDE_EFFORT` | `high` | Claude reasoning effort (`low`, `medium`, `high`, `xhigh`→`high`) |
| `CORAL_CLAUDE_MODEL_CAP` | `opus` | Maximum Claude model tier (`opus`, `sonnet`, `haiku`). Requests for higher tiers are downgraded. |
| `CORAL_EFFORT` | _(none)_ | Global effort override — if set, applies to any provider without its own `CORAL_<PROVIDER>_EFFORT` |
| `CORAL_MAX_SESSIONS` | `10` | Max concurrent CLI sessions (range: 1–10) |
| `CORAL_DISCUSS_BID_THRESHOLD` | `30` | Minimum bid score (1–100) for floor eligibility. Stored per-session at creation time. |
| `CORAL_DISCUSS_MAX_EPOCHS` | `2` | Maximum epochs before discussion ends automatically (1–10). Stored per-session at creation time. |
| `CORAL_DISCUSS_QUOTA_PER_EPOCH` | `3` | Speaking turns per agent per epoch (1–10). Stored per-session at creation time. |
| `CORAL_DISCUSS_TTL_DAYS` | `0` | Days before completed discuss sessions are eligible for pruning (0 = disabled) |
| `CORAL_BACKEND_IDLE_MS` | `21600000` | Backend daemon idle timeout in milliseconds (default 6 hours) |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | _(unset)_ | Required for `/coral:discuss` and `/coral:ralph --team`. Set to `1`. |

### Usage - Shell

```bash
export CORAL_CODEX_MODEL=gpt-5.4
export CORAL_CODEX_EFFORT=high
export CORAL_DISCUSS_BID_THRESHOLD=50
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

### Usage - .claude/settings.json

Set environment variables in `.claude/settings.json` (project-level or global). This persists across sessions without shell exports.

```json
{
  "env": {
    "CORAL_CODEX_MODEL": "gpt-5.4",
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

Registers the MCP server with Claude Code. `ax` runs `bridge/coral-ax.cjs`, which proxies all tools (`codex`, `claude`, `abort`, `workflow`, `discuss`, `discuss_watch`) to the backend daemon (`bridge/coral-backend.cjs`) and intercepts bridge-local tools (`wait`, `backend`).

### hooks/hooks.json - Hook Configuration

Configures all 9 hooks: SessionStart (CLAUDE.md injection with `{{CORAL_PROJECTS}}` substitution + backend warm-start + HUD auto-update), SessionStart/compact (post-compaction KB promotion reminder), UserPromptSubmit (KB flag + ralph loop state + memo reminder), PreToolUse (KB flag + ralph loop state + CLI path resolution), PostToolUse (silent failure detector), PostToolUseFailure (KB lookup reminder), Stop (KB promotion gate + plan state cleanup), TeammateIdle (discuss idle guard).

See [Hooks documentation](./hooks.md) for details.

### AX Session Files (Codex + Claude)

**Location**: `~/.claude/coral/sessions/<project-hash>/<session-uuid>.json`

**Project hash**: `sha256(resolve(workingDirectory)).slice(0, 12)` — isolates sessions per project

**Creation**: Auto-created by `SessionManager` when a resumable session completes

**Format**: Single provider-aware `SessionEntry` JSON object per file (`provider: "codex" | "claude"`)

**Updates**: Written atomically (`.tmp` + rename) on session create, use, or delete

**Corruption handling**: Invalid JSON files are skipped with a warning; other sessions load normally

### Discuss Session Directories

**Location**: `~/.coral/projects/{source-slug}/discuss/{session_dir}/`

**Source slug**: canonical git source (`owner/repo` -> `owner-repo`) with `local/<dirname>` fallback

**Session ID format**: `yymmdd-HHmm-xxxx` (compact timestamp + 4-char random suffix)

**Directory name**: `{session_id}-{topic_slug}` (slug preserves CJK characters, truncated to 40 chars)

**Concurrency**: The backend serializes discuss mutations with in-process promise-chain locks keyed by source/session

**Contents**:
- `event-log.jsonl` — append-only authority log
- `state.json` — derived discussion snapshot (atomic writes via `.tmp` + rename)

**Parent directory metadata**:
- `discovery.json` — source-scoped recovery index
- `summary-index.json` — source-scoped listing index
- `~/.coral/discuss-sources.json` — shared source registry used for discovery and recovery

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
.mcp.json                   -> Claude Code registers/starts both MCP servers (ax + dc)
hooks/hooks.json            -> Claude Code configures all 9 hooks
hooks/kb-lookup-reminder.mjs  -> PostToolUseFailure/PostToolUse KB hint script
hooks/kb-memo-reminder.mjs    -> UserPromptSubmit memo reminder script
hooks/kb-promote-gate.mjs -> Stop/Compact promotion script
hooks/backend-warm-start.mjs  -> SessionStart backend warm-start hook
hooks/hud-auto-update.mjs    -> SessionStart HUD auto-update hook

~/.claude/coral/sessions/<project-hash>/*.json  -> Runtime AX session files (Codex + Claude, auto-created)
~/.claude/coral/backend.json                    -> Runtime backend connection info (auto-created)
~/.claude/coral/backend.lock                    -> Runtime backend singleton lock (auto-created)
/tmp/coral-jobs/<jobId>/                        -> Runtime job directories (temporary)
~/.coral/discuss-sources.json                   -> Shared discuss source registry (auto-created)
~/.coral/projects/<source-slug>/discuss/<session-dir>/  -> Runtime discuss session dirs (auto-created)

bridge/coral-ax.cjs      -> Unified AX MCP server bundle (codex + claude + wait + abort + workflow + discuss + backend, committed)
bridge/coral-backend.cjs  -> HTTP backend daemon bundle (committed)
```
