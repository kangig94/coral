# Hooks

Hooks provide automatic context injection, agent routing, plan-mode persistence, error-aware KB reminders, and KB promotion enforcement.

## Overview

Claude Code's hook system executes scripts on specific events. Coral uses hooks at two levels:

**Plugin hooks** (`hooks/hooks.json`):
1. **SessionStart** (`*`) - Injects CLAUDE.md behavioral guidelines into every Claude session
2. **SessionStart** (`compact`) - After context compaction, restores plan-mode state and reminds about KB promotion
3. **SubagentStart** (`(^|:)codex-`) - Injects delegation instructions into agents with a `codex-` prefix
4. **UserPromptSubmit** - Tracks plan-mode activation when `/plan` or `/coral:plan` is invoked
5. **PreToolUse** - Periodically reminds Claude to write memos for non-obvious discoveries
6. **PostToolUseFailure** (`*`) - On any non-zero tool exit, reminds Claude to check `.claude/coral/kb/` before debugging
7. **PostToolUse** (`Bash`) - Detects silent failures in command output when exit codes are masked and injects the same KB lookup reminder context
8. **Stop** - Enforces KB promotion for unprocessed memos; cleans up plan-mode state
9. **TeammateIdle** (`dc-*`) - Blocks idle when discuss agents have pending actions (bid/speak/vote)

## Hook Configuration

Plugin hooks: `hooks/hooks.json`. Scripts: `hooks/detect-codex-agent.mjs`, `hooks/kb-lookup-reminder.mjs`, `hooks/silent-failure-detector.mjs`, `hooks/kb-memo-reminder.mjs`, `hooks/kb-promote-reminder.mjs`, `hooks/plan-guard.mjs`, `hooks/plan-state-tracker.mjs`, `hooks/discuss-idle-guard.mjs`.

All hook scripts are **Node.js ESM** (`.mjs`). They read input JSON from stdin, write output JSON to stdout, and **fail-open** via `try/catch { process.exit(0) }` - a crash or timeout never blocks the user.

## SessionStart Hook

Injects the plugin's CLAUDE.md content into Claude's context at the start of every session. This ensures Claude always receives the behavioral guidelines (Clarity First, Surgical Changes, etc.) and KB system instructions.

Implementation: inline `cat` command reading `CLAUDE.md` from the plugin root directory. No script file needed.

> **Note**: Codex sessions receive CLAUDE.md through a separate mechanism - the MCP server prepends it to the prompt in `executeOneShot()`. See [Core Modules](./core-modules.md) for details.

## SessionStart (Compact) Hook

Fires after context compaction (matcher: `compact`). Runs two scripts:

**Script 1: `hooks/plan-guard.mjs`** — Reads `session_id` from stdin. Checks for `.claude/coral/tmp/plan-active-{sessionId}` flag file. If present, injects `hookSpecificOutput` with `additionalContext` containing plan-mode recovery instructions (re-read SKILL.md, recover plan file, resume without starting over). If absent, exits silently.

**Script 2: `hooks/kb-promote-reminder.mjs`** — Checks for unprocessed memos in `.claude/coral/memo/`. Injects `hookSpecificOutput` with `additionalContext` reminding about KB promotion.

**Purpose**: After compaction the model loses prior context. This hook restores critical state — plan-mode awareness and KB promotion reminders — so work continues seamlessly.

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

## UserPromptSubmit Hook (Plan State Tracker)

Script: `hooks/plan-state-tracker.mjs`. Fires on every user prompt submission.

Reads `hook_event_name` and `session_id` from stdin JSON. If the user prompt matches `/plan` or `/coral:plan` (case-insensitive), creates `.claude/coral/tmp/plan-active-{sessionId}` flag file to signal that a planning session is active.

Also cleans up stale flag files older than 24 hours from other sessions.

**Purpose**: Works with plan-guard.mjs (SessionStart compact) and the Stop hook to maintain plan-mode state across context compaction. The flag persists even if the context window is compacted, allowing plan-guard to restore plan-mode awareness.

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

## Stop Hook

Runs two scripts on every response completion:

**Script 1: `hooks/kb-promote-reminder.mjs`** — Skill-scoped via state file.

**State file pattern**: Skills (ralph, bugfix) create `.claude/coral/tmp/kb-active` on start. The Stop hook checks for this file — if absent, exits silently (normal conversation unaffected).

When state file exists:
1. Delete state file (unconditionally)
2. `decision: "block"` prevents Claude from stopping
3. `reason` instructs Claude to review memos for KB promotion (even if no memos exist, the block fires to ensure the KB review step runs)

**Script 2: `hooks/plan-state-tracker.mjs`** — Cleans up the plan-active flag. If `.claude/coral/tmp/plan-active-{sessionId}` exists, deletes it (planning turn has ended).

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
- Agents without the `codex-` prefix (bare or namespaced) are filtered out at the matcher stage
- Hook scripts must be readable by the Claude Code process (no execute permission required for `.mjs` scripts — Node.js is called directly)
