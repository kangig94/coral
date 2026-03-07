# Hooks

Hooks provide automatic context injection, agent routing, HUD auto-update, error-aware KB reminders, and KB promotion enforcement.

## Overview

Claude Code's hook system executes scripts on specific events. Coral uses hooks at two levels:

**Plugin hooks** (`hooks/hooks.json`):
1. **SessionStart** (`*`) - Injects CLAUDE.md behavioral guidelines, warm-starts the backend daemon, and auto-updates HUD script
2. **SessionStart** (`compact`) - After context compaction, reminds about KB promotion
3. **UserPromptSubmit** - Creates session-scoped KB flag when user types `/coral:ralph` or `/coral:bugfix`
4. **PreToolUse** - Periodically reminds Claude to write memos for non-obvious discoveries
5. **PreToolUse** (`Skill`) - Creates session-scoped KB flag when Claude calls Skill("coral:ralph"|"coral:bugfix")
6. **PostToolUseFailure** (`*`) - On any non-zero tool exit, reminds Claude to check `.claude/coral/kb/` before debugging
7. **PostToolUse** (`Bash`) - Detects silent failures in command output when exit codes are masked and injects the same KB lookup reminder context
8. **Stop** - Enforces KB promotion for unprocessed memos
9. **TeammateIdle** (`dc-*`) - Blocks idle when discuss agents have pending actions (bid/speak/vote)

## Hook Configuration

Plugin hooks: `hooks/hooks.json`. Scripts: `hooks/kb-lookup-reminder.mjs`, `hooks/silent-failure-detector.mjs`, `hooks/kb-memo-reminder.mjs`, `hooks/kb-promote-reminder.mjs`, `hooks/discuss-idle-guard.mjs`, `hooks/backend-warm-start.mjs`, `hooks/hud-auto-update.mjs`.

All hook scripts are **Node.js ESM** (`.mjs`). They read input JSON from stdin, write output JSON to stdout, and **fail-open** via `try/catch { process.exit(0) }` - a crash or timeout never blocks the user.

## SessionStart Hook

Injects the plugin's CLAUDE.md content into Claude's context at the start of every session. This ensures Claude always receives the behavioral guidelines (Clarity First, Surgical Changes, etc.) and KB system instructions.

Implementation: inline `cat` command reading `CLAUDE.md` from the plugin root directory. No script file needed.

> **Note**: Codex sessions receive CLAUDE.md through a separate mechanism - the MCP server prepends it to the prompt in `executeOneShot()`. See [Core Modules](./core-modules.md) for details.

## SessionStart Hook (Backend Warm-Start)

Script: `hooks/backend-warm-start.mjs`. Fires at session start (matcher: `*`, timeout: 10s). Ensures the coral-backend HTTP daemon is running before the session begins.

**Sequence**:
1. Reads `~/.claude/coral/backend.json` for existing backend connection info
2. If the file exists and contains a PID, checks if the process is alive via `process.kill(pid, 0)`
3. If the process is alive, exits immediately (backend already running)
4. If the process is not alive (or no file exists), spawns `bridge/coral-backend.cjs` as a detached child process with stdio ignored and `child.unref()`

**Fail-open**: The entire script is wrapped in `try/catch {}`. If `CLAUDE_PLUGIN_ROOT` is unset, the hook exits silently. Any error during file read, PID check, or spawn results in a silent exit — the backend will be started lazily on first tool call if the hook fails.

## SessionStart Hook (HUD Auto-Update)

Script: `hooks/hud-auto-update.mjs`. Fires at session start (matcher: `*`, timeout: 3s). Silently updates the installed HUD script if a newer version is available in the plugin cache.

**Sequence**:
1. Reads `~/.claude/hud/coral-hud.mjs` — if missing, exits (HUD not installed)
2. Computes SHA-256 hash of installed file and source (`skills/statusline/coral-hud.mjs`)
3. If hashes match, exits (already up to date)
4. If different, copies source over installed file

**Fail-open**: Entire script wrapped in `try/catch {}`. Uninstalled HUD or missing plugin root results in silent exit.

## SessionStart (Compact) Hook

Fires after context compaction (matcher: `compact`).

**Script: `hooks/kb-promote-reminder.mjs`** — Checks for unprocessed memos in `.claude/coral/memo/`. Injects `hookSpecificOutput` with `additionalContext` reminding about KB promotion.

**Purpose**: After compaction the model loses prior context. This hook restores KB promotion reminders so work continues seamlessly.

## Removed SubagentStart Hook

The prior `SubagentStart` codex delegation hook has been removed. Codex delegation now uses
direct MCP tool dispatch (`codex({ op: "coral:<agent>", ... })`) and executor-side
`ensureMultiAgent()` configuration.

## PreToolUse Hook (Memo Reminder)

Script: `hooks/kb-memo-reminder.mjs`. Injects `additionalContext` reminding Claude to write memos when discovering non-obvious lessons.

**Throttled (15 min)**: Reads `session_id` from stdin JSON, creates `.claude/coral/tmp/memo-reminded-<session_id>` flag file. Subsequent calls within 15 minutes exit silently; after 15 minutes, the flag refreshes and the reminder fires again. Also cleans up stale flags older than 24 hours.

## PostToolUseFailure Hook

On any tool failure, reminds Claude to check `.claude/coral/kb/` before debugging from scratch. Script: `hooks/kb-lookup-reminder.mjs`. Matcher: `*` (all tools).

**Output**: `hookSpecificOutput.additionalContext` with KB file listing. Non-blocking — Claude receives the reminder as additional context.

**Fail-open**: If KB directory doesn't exist or has no `.md` files — silent exit 0.

## PostToolUse Hook (Silent Failure Detector)

On successful Bash tool executions (`PostToolUse` only fires when exit code is 0), detects failure signals in command output that indicate masked failures and injects the same KB lookup reminder flow. Script: `hooks/silent-failure-detector.mjs`. Matcher: `Bash`.

**Two-stage filter**: First checks if the command contains an exit-code-masking construct (`| tee`, `|| true`, `|| :`). If no masking construct is present, the hook exits immediately — no output inspection needed, since unmasked failures trigger `PostToolUseFailure` directly. Only masked commands proceed to the second stage: regex matching against stdout/stderr for failure patterns (`Failed to build`, `BUILD FAILED`, `Traceback (most recent call last)`, `npm ERR!`, `^error[E...]`).

**Relationship to PostToolUseFailure**: `PostToolUseFailure` covers non-zero exits. `PostToolUse` covers silent failures with zero exits. The two hooks are complementary and do not overlap on the same tool execution.

**Fail-open**: Any parse/read error, no pattern match, or empty KB directory — silent exit 0.

## UserPromptSubmit Hook (KB Flag — User Slash Commands)

Script: `hooks/kb-promote-reminder.mjs`.

Creates a session-scoped flag file `.claude/coral/tmp/kb-active-{session_id}` when the user types `/coral:ralph` or `/coral:bugfix` directly. User-typed slash commands are expanded by the CLI before reaching Claude, so they do not trigger PreToolUse — this hook covers that path.

## PreToolUse Hook (Skill KB Flag — Claude-Initiated)

Script: `hooks/kb-promote-reminder.mjs`. Matcher: `Skill`.

Creates the same session-scoped flag when Claude internally calls `Skill("coral:ralph")` or `Skill("coral:bugfix")` (e.g., when plan skill routes to ralph via AskUserQuestion). Input shape: `{ tool_name: "Skill", tool_input: { skill: "coral:ralph", args: "..." } }`.

## Stop Hook

Script: `hooks/kb-promote-reminder.mjs`. Session-scoped via flag file.

**Flag file pattern**: The UserPromptSubmit and PreToolUse(Skill) hooks create `.claude/coral/tmp/kb-active-{session_id}` for KB-producing skills. The Stop hook checks for its own session's flag — if absent, exits silently (normal conversation unaffected). Stale flags (>24h) from expired sessions are cleaned up automatically.

When flag exists:
1. Delete session's flag file
2. `decision: "block"` prevents Claude from stopping
3. `reason` instructs Claude to review memos for KB promotion (even if no memos exist, the block fires to ensure the KB review step runs)

## TeammateIdle Hook (Discuss Idle Guard)

Script: `hooks/discuss-idle-guard.mjs`. Fires when a teammate goes idle (matcher: agent names matching `dc-*`).

Reads the discuss session's `state.json` and checks whether the idle agent has a pending action:
- Has a pending bid to submit → block idle (exit 2)
- Is the current speaker with no speech delivered → block idle (exit 2)
- Has a pending vote to cast → block idle (exit 2)
- No pending action → allow idle (exit 0)

**Purpose**: Prevents discuss agents from going idle mid-protocol. If a discussant agent becomes idle before submitting a bid, delivering a speech, or casting a vote, the hook blocks the idle and the agent receives a reminder to complete its action.

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

- If the timeout is exceeded, the hook is ignored and the agent runs normally
- Invalid JSON output from the hook is ignored
- Hook scripts must be readable by the Claude Code process (no execute permission required for `.mjs` scripts — Node.js is called directly)
