# Hooks

Hooks provide automatic context injection, agent routing, HUD auto-update, error-aware KB reminders, and KB promotion enforcement.

## Overview

Claude Code's hook system executes scripts on specific events. Coral uses hooks at two levels:

**Plugin hooks** (`hooks/hooks.json`):
1. **SessionStart** (`*`) - Injects INJECT.md behavioral guidelines with `{{CORAL_PROJECTS}}` and `{{PROJECT_SOURCE}}` substituted to the active project path/source, warm-starts the backend daemon, and auto-updates HUD script
2. **SessionStart** (`compact`) - After context compaction, reminds about memo review plus tool-based KB search/promotion
3. **SubagentStart** (`*`) - Injects INJECT.md into subagents (without owner-only blocks — no session ID, no memo/promotion commands)
4. **UserPromptSubmit** - Creates session-scoped KB flag for `/coral:ralph`|`/coral:bugfix`, creates ralph loop state for `/coral:ralph`|`/ralph`, and periodically reminds about memo writing
5. **PreToolUse** (`Skill`) - Creates session-scoped KB flag when Claude calls Skill("coral:ralph"|"coral:bugfix"), and creates ralph loop state when Claude calls Skill("coral:ralph")
6. **PostToolUseFailure** (`*`) - On any non-zero tool exit, reminds Claude to search KB before debugging from scratch
7. **PostToolUse** (`Bash`) - Detects silent failures in command output when exit codes are masked and injects the same KB lookup reminder context
8. **Stop** - Enforces KB promotion for unprocessed memos and drives prompt-mode ralph loop iteration


## Hook Configuration

Plugin hooks: `hooks/hooks.json`. Scripts: `hooks/session-start.mjs`, `hooks/subagent-start.mjs`, `hooks/kb-lookup-reminder.mjs`, `hooks/kb-memo-reminder.mjs`, `hooks/kb-promote-gate.mjs`, `hooks/ralph-loop.mjs`, `hooks/backend-warm-start.mjs`, `hooks/hud-auto-update.mjs`.

All hook scripts are **Node.js ESM** (`.mjs`). They read input JSON from stdin, write output JSON to stdout, and **fail-open** via `try/catch { process.exit(0) }` - a crash or timeout never blocks the user.

## SessionStart Hook

Injects the plugin's INJECT.md content into Claude's context at the start of every session. This ensures Claude always receives the behavioral guidelines (Clarity First, Surgical Changes, etc.) and KB system instructions.

Implementation: `hooks/session-start.mjs` reads `INJECT.md` from the plugin root, resolves the active source slug from `CLAUDE_PROJECT_DIR`, substitutes the project-specific placeholders, and returns the result via `hookSpecificOutput.additionalContext`.

> **Note**: Codex sessions receive INJECT.md through a separate mechanism - the MCP server prepends it to the prompt in `executeOneShot()`. See [Core Modules](./core-modules.md) for details.

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

**Script: `hooks/kb-promote-gate.mjs`** — Checks for unprocessed memos in `~/.coral/projects/{slug}/memo/`. Injects `hookSpecificOutput` with `additionalContext` reminding Claude to review memos first, use `kb_search` to check duplicates, then promote only durable knowledge with `kb_promote`.

**Purpose**: After compaction the model loses prior context. This hook restores KB promotion reminders so work continues seamlessly.

## SubagentStart Hook

Script: `hooks/subagent-start.mjs`. Fires when any subagent is spawned via the Agent tool (matcher: `*`, timeout: 3s). Injects INJECT.md behavioral guidelines into the subagent's context.

Unlike SessionStart, this hook always strips `SESSION_ID_ONLY` blocks — subagents receive KB search commands (read-only) but not memo, promotion, or update/delete commands. `{{SESSION_ID}}` is substituted as empty string.

> **Note**: Codex delegation does not trigger SubagentStart. Codex sessions receive INJECT.md through the MCP server's `executeOneShot()` prepend. See [Core Modules](./core-modules.md) for details.

## UserPromptSubmit Hook (Memo Reminder)

Script: `hooks/kb-memo-reminder.mjs`. Injects `additionalContext` reminding Claude to write memos only for discoveries that would save someone hours (painful root causes, gotchas contradicting docs). Fires on every user message (not on every tool call).

**Throttled (60 min)**: Reads `session_id` from stdin JSON, creates a flag file under `<os-tmpdir>/coral/<project-slug>/`. Subsequent calls within 60 minutes exit silently; after 60 minutes, the flag refreshes and the reminder fires again. OS temp directory auto-cleans on reboot.

## PostToolUseFailure + PostToolUse Hook (KB Lookup Reminder)

Script: `hooks/kb-lookup-reminder.mjs`. Handles two events in one script:

- **PostToolUseFailure** (`*`) — On any tool failure, immediately reminds Claude to use `kb_search({ query: "<keywords>" })`.
- **PostToolUse** (`Bash`) — On successful Bash executions (exit 0), detects silent failures via two-stage filter: first checks for exit-code-masking constructs (`| tee`, `|| true`, `|| :`), then regex-matches output for failure patterns (`Failed to build`, `BUILD FAILED`, `Traceback`, `npm ERR!`, `^error[E...]`).

The two events are complementary — `PostToolUseFailure` covers non-zero exits, `PostToolUse` covers silent failures with zero exits. They never overlap on the same tool execution.

**Output**: `hookSpecificOutput.additionalContext` with the `kb_search` reminder plus KB topic names derived from note filenames. Non-blocking.

**Fail-open**: Missing KB directory, no `.md` files, no pattern match — silent exit 0.

## UserPromptSubmit Hook (KB Flag — User Slash Commands)

Script: `hooks/kb-promote-gate.mjs`.

Creates a session-scoped flag file `<os-tmpdir>/coral/<project-slug>/kb-active-{session_id}` when the user types `/coral:ralph` or `/coral:bugfix` directly. User-typed slash commands are expanded by the CLI before reaching Claude, so they do not trigger PreToolUse — this hook covers that path.

## PreToolUse Hook (Skill KB Flag — Claude-Initiated)

Script: `hooks/kb-promote-gate.mjs`. Matcher: `Skill`.

Creates the same session-scoped flag when Claude internally calls `Skill("coral:ralph")` or `Skill("coral:bugfix")` (e.g., when plan skill routes to ralph via AskUserQuestion). Input shape: `{ tool_name: "Skill", tool_input: { skill: "coral:ralph", args: "..." } }`.

## Stop Hook

Script: `hooks/kb-promote-gate.mjs`. Session-scoped via flag file.

**Flag file pattern**: The UserPromptSubmit and PreToolUse(Skill) hooks create `<os-tmpdir>/coral/<project-slug>/kb-active-{session_id}` for KB-producing skills. The Stop hook checks for its own session's flag — if absent, exits silently (normal conversation unaffected). Flag files auto-clean on OS reboot.

When flag exists:
1. Delete session's flag file
2. `decision: "block"` prevents Claude from stopping
3. `reason` instructs Claude to review memos, use `kb_search` to check for duplicates, then selectively promote durable knowledge with `kb_promote` (even if no memos exist, the block fires to ensure the KB review step runs)


## Ralph Loop Hook (ralph-loop.mjs)

Script: `hooks/ralph-loop.mjs`. Enables prompt-mode iteration for `coral:ralph` while leaving plan-mode execution unchanged.

Handles three events:
- **UserPromptSubmit** — detects `/coral:ralph` or `/ralph`, creates `<os-tmpdir>/coral/<project-slug>/ralph-state-{session_id}.json`, and injects the absolute state path through `hookSpecificOutput.additionalContext`
- **PreToolUse** (`Skill`) — detects `Skill("coral:ralph")`, creates the same defaulted state file, and injects the same context
- **Stop** — checks the session-scoped state file and either allows exit or blocks stop to re-inject the stored prompt

State file format:

```json
{"prompt":"","iteration":1,"maxIterations":0,"completionPromise":"TASK COMPLETE"}
```

The hook creates the defaults. The LLM only writes the cleaned prompt into `prompt` and overrides `maxIterations` or `completionPromise` when needed.

Stop hook flow:
1. Early guard: allow `context_limit` compaction stops and user-requested stops through immediately
2. State check: no session file or empty `prompt` means no loop
3. Max iterations: if `maxIterations > 0` and `iteration >= maxIterations`, delete the state file and allow exit
4. Promise detection: check `last_assistant_message` first, then `transcript_path` fallback, for `<promise>...</promise>` matching `completionPromise`
5. Block: increment `iteration`, atomically rewrite the state file, then return `decision: "block"` with the stored prompt as `reason`

This coexists with `kb-promote-gate.mjs` on Stop. Multiple Stop hooks can each return `decision: "block"` without conflict, so KB promotion enforcement and ralph prompt looping both remain active.

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
