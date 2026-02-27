# Hooks

Hooks provide automatic context injection, agent routing, error-aware KB reminders, and KB promotion enforcement.

## Overview

Claude Code's hook system executes scripts on specific events. Coral uses hooks at two levels:

**Plugin hooks** (`hooks/hooks.json`):
1. **SessionStart** - Injects CLAUDE.md behavioral guidelines into every Claude session
2. **SubagentStart** - Injects delegation instructions into agents with a `codex-` prefix (with or without `coral:` namespace)
3. **PermissionRequest** - Auto-approves Coral's internal Bash commands (`.claude/coral/tmp` directory operations)
4. **PreToolUse** - On first tool call per session, reminds Claude to write memos for non-obvious discoveries
5. **PostToolUseFailure** - On any tool failure, reminds Claude to check `.claude/coral/kb/` before debugging
6. **Stop** - On response completion, blocks Claude from stopping if unprocessed memos exist in `.claude/coral/memo/`
7. **PreCompact** - Before context compaction, reminds about unprocessed memos for KB promotion
8. **TeammateIdle** - Blocks idle when discuss agents have pending actions (bid/speak)

## Hook Configuration

Plugin hooks: `hooks/hooks.json`. Scripts: `hooks/detect-codex-agent.mjs`, `hooks/permission-handler.mjs`, `hooks/kb-lookup-reminder.mjs`, `hooks/kb-memo-reminder.mjs`, `hooks/kb-promote-reminder.mjs`, `hooks/discuss-idle-guard.mjs`.

All hook scripts are **Node.js ESM** (`.mjs`). They read input JSON from stdin, write output JSON to stdout, and **fail-open** via `try/catch { process.exit(0) }` - a crash or timeout never blocks the user.

## SessionStart Hook

Injects the plugin's CLAUDE.md content into Claude's context at the start of every session. This ensures Claude always receives the behavioral guidelines (Clarity First, Surgical Changes, etc.) and KB system instructions.

Implementation: inline `cat` command reading `CLAUDE.md` from the plugin root directory. No script file needed.

> **Note**: Codex sessions receive CLAUDE.md through a separate mechanism - the MCP server prepends it to the prompt in `executeOneShot()`. See [Core Modules](./core-modules.md) for details.

## SubagentStart Hook

Matches agents with the `codex-` prefix (bare or namespaced, e.g., `coral:codex-proxy`) and injects delegation instructions. Timeout: 5 seconds (hook is ignored if exceeded).

Script: `hooks/detect-codex-agent.mjs`. Reads the SubagentStart event JSON from stdin, extracts `agent_name`, and outputs delegation instructions as `hookSpecificOutput` JSON.

### Execution Flow

```
1. SubagentStart event fires (matcher: "(^|:)codex-")
2. Event JSON received via stdin
   e.g.: {"agent_name": "codex-proxy", "task": "..."}
3. Extract agent_name from JSON (standard JSON.parse)
   - "agent_name" field takes priority
   - Falls back to "name" field
   - Exit 0 if neither found
4. Check for "codex-" prefix (case-insensitive, supports `coral:codex-*` namespace)
5a. Match found → ensure Codex multi_agent config, output hookSpecificOutput JSON
    → Claude Code injects additionalContext into the agent
5b. No match → exit 0 (no output, terminate silently)
    → Hook ignored, agent runs normally
```

### Injected Context

```
Codex delegation context: You are a Codex delegation agent. You MUST use
the codex MCP tool (`codex({ op: "exec", ... })`) to forward ALL work to
Codex CLI. Do NOT generate your own response in place of calling Codex.
Call the MCP tool immediately with the full task.
```

This message is appended to the agent's system prompt, forcing the agent to call the Codex MCP tool.

## PermissionRequest Hook

Script: `hooks/permission-handler.mjs`. Matcher: `Bash`. Auto-approves Coral's internal Bash commands without requiring user confirmation.

**Approved patterns** (`.claude/coral/tmp` directory operations only):
- `mkdir -p .../.claude/coral/tmp` — creates the state file directory
- `touch .../.claude/coral/tmp/...` — creates/refreshes state files (e.g., `kb-active`)

**Why**: Skills (ralph, debug) use ```` ```! ```` blocks that execute `mkdir -p && touch` on load to set up state files. Without this hook, non-bypass users would be prompted for permission on every skill invocation — but the ```` ```! ```` auto-execution context has no interactive approval mechanism.

**Security scope**: Only matches commands targeting `.claude/coral/tmp`. Chained commands (`&&`) are split and each part is checked independently. Commands not matching any pattern fall through to normal permission flow.

**Fail-open**: Any parse error or unexpected input → silent exit 0 (normal permission flow continues).

## PostToolUseFailure Hook

On any tool failure, reminds Claude to check `.claude/coral/kb/` before debugging from scratch. Script: `hooks/kb-lookup-reminder.mjs`. Matcher: `*` (all tools).

**Output**: `hookSpecificOutput.additionalContext` with KB file listing. Non-blocking — Claude receives the reminder as additional context.

**Fail-open**: If KB directory doesn't exist or has no `.md` files — silent exit 0.

## PreCompact Hook

Before context compaction, checks for unprocessed memos in `.claude/coral/memo/`. Script: `hooks/kb-promote-reminder.mjs`.

**Output**: `systemMessage` shown to the user as a warning. PreCompact has no decision control — cannot inject context into Claude or block compaction.

**Fail-open**: If memo directory doesn't exist or has no files — silent exit 0.

## PreToolUse Hook (Memo Reminder)

Script: `hooks/kb-memo-reminder.mjs`. Fires once per session (flag file keyed by `session_id`). Injects `additionalContext` reminding Claude to write memos when discovering non-obvious lessons.

**Throttled (15 min)**: Reads `session_id` from stdin JSON, creates `.claude/coral/tmp/memo-reminded-<session_id>` flag file. Subsequent calls within 15 minutes exit silently; after 15 minutes, `touch` refreshes the mtime and the reminder fires again.

## Stop Hook (KB Promotion)

Script: `hooks/kb-promote-reminder.mjs`. Fires on every response completion, but **skill-scoped** via state file.

**State file pattern**: Skills (ralph, debug) create `.claude/coral/tmp/kb-active` on start. The Stop hook checks for this file — if absent, exits silently (normal conversation unaffected).

When state file exists and unprocessed memos found in `.claude/coral/memo/`:
1. Delete state file (unconditionally)
2. `decision: "block"` prevents Claude from stopping
3. `reason` instructs Claude to review memos for KB promotion

**Fail-open**: If state file absent, or memo directory empty — silent exit 0.

## TeammateIdle Hook (Discuss Idle Guard)

Script: `hooks/discuss-idle-guard.mjs`. Fires when a teammate goes idle (matcher: agent names matching `dc-*`).

Reads the discuss session's `state.json` and checks whether the idle agent has a pending action:
- Has a pending bid to submit → block idle (exit 2)
- Is the current speaker with no speech delivered → block idle (exit 2)
- No pending action → allow idle (exit 0)

**Purpose**: Prevents discuss agents from going idle mid-protocol. If a discussant agent becomes idle before submitting a bid or delivering a speech, the hook blocks the idle and the agent receives a reminder to complete its action.

**Fail-open**: Any read error or missing session file → silent exit 0 (allow idle).

## Node.js ESM Conventions

All hook scripts follow these conventions:

```javascript
// hooks/example-hook.mjs
import { readFileSync } from 'node:fs';

try {
  const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
  // ... hook logic ...
  const output = { /* result */ };
  process.stdout.write(JSON.stringify(output) + '\n');
} catch {
  // Fail-open: any error exits silently
  process.exit(0);
}
```

Key requirements:
- **ESM**: `import` syntax, `.mjs` extension
- **stdin**: read event JSON via `readFileSync('/dev/stdin', 'utf8')` or equivalent
- **stdout**: write JSON output (not `console.log` — corrupts MCP transport if server is involved)
- **Fail-open**: wrap all logic in `try/catch { process.exit(0) }`
- **No external dependencies**: use only `node:fs`, `node:path`, `node:os`, `node:crypto`

## Notes

- If the 5-second timeout is exceeded, the hook is ignored and the agent runs normally
- Invalid JSON output from the hook is ignored
- Agents without the `codex-` prefix (bare or namespaced) are filtered out at the matcher stage
- Hook scripts must be readable by the Claude Code process (no execute permission required for `.mjs` scripts — Node.js is called directly)
