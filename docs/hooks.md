# Hooks

Hooks provide automatic context injection, agent routing, error-aware KB reminders, and KB promotion enforcement.

## Overview

Claude Code's hook system executes shell scripts on specific events. Coral uses hooks at two levels:

**Plugin hooks** (`hooks/hooks.json`):
1. **SessionStart** - Injects CLAUDE.md behavioral guidelines into every Claude session
2. **SubagentStart** - Injects delegation instructions into agents with a `codex-` prefix (with or without `coral:` namespace)
3. **PreToolUse** - On first tool call per session, reminds Claude to write memos for non-obvious discoveries
4. **PostToolUseFailure** - On any tool failure, reminds Claude to check `.claude/coral/kb/` before debugging
5. **Stop** - On response completion, blocks Claude from stopping if unprocessed memos exist in `.claude/coral/memo/`
6. **PreCompact** - Before context compaction, reminds about unprocessed memos for KB promotion
7. **TeammateIdle** - Blocks idle when discuss agents have pending actions

## Hook Configuration

Plugin hooks: `hooks/hooks.json`. Scripts: `hooks/detect-codex-agent.sh`, `hooks/kb-lookup-reminder.sh`, `hooks/kb-memo-reminder.sh`, `hooks/kb-promote-reminder.sh`, `hooks/discuss-idle-guard.sh`.

## SessionStart Hook

Injects the plugin's CLAUDE.md content into Claude's context at the start of every session. This ensures Claude always receives the behavioral guidelines (Simplicity First, Surgical Changes, etc.) and KB system instructions.

> **Note**: Codex sessions receive CLAUDE.md through a separate mechanism - the MCP server prepends it to the prompt in `executeOneShot()`. See [Core Modules](./core-modules.md) for details.

## SubagentStart Hook

Matches agents with the `codex-` prefix (bare or namespaced, e.g., `coral:codex-proxy`) and injects delegation instructions. Timeout: 5 seconds (hook is ignored if exceeded).

## PostToolUseFailure Hook

On any tool failure, reminds Claude to check `.claude/coral/kb/` before debugging from scratch. Script: `hooks/kb-lookup-reminder.sh`. Matcher: `*` (all tools).

**Output**: `hookSpecificOutput.additionalContext` with KB file listing. Non-blocking — Claude receives the reminder as additional context.

**Fail-open**: If KB directory doesn't exist or has no `.md` files — silent exit 0.

## PreCompact Hook

Before context compaction, checks for unprocessed memos in `.claude/coral/memo/`. Script: `hooks/kb-promote-reminder.sh`.

**Output**: `systemMessage` shown to the user as a warning. PreCompact has no decision control — cannot inject context into Claude or block compaction.

**Fail-open**: If memo directory doesn't exist or has no files — silent exit 0.

## PreToolUse Hook (Memo Reminder)

Script: `hooks/kb-memo-reminder.sh`. Fires once per session (flag file keyed by `session_id`). Injects `additionalContext` reminding Claude to write memos when discovering non-obvious lessons.

**Throttled (15 min)**: Reads `session_id` from stdin JSON, creates `.claude/coral/tmp/memo-reminded-<session_id>` flag file. Subsequent calls within 15 minutes exit silently; after 15 minutes, `touch` refreshes the mtime and the reminder fires again.

## Stop Hook (KB Promotion)

Script: `hooks/kb-promote-reminder.sh`. Fires on every response completion, but **skill-scoped** via state file.

**State file pattern**: Skills (ralph, codex-ralph) create `.claude/coral/tmp/kb-active` on start via `!` command preprocessing. The Stop hook checks for this file — if absent, exits silently (normal conversation unaffected).

When state file exists and unprocessed memos found in `.claude/coral/memo/`:
1. Delete state file (unconditionally)
2. `decision: "block"` prevents Claude from stopping
3. `reason` instructs Claude to review memos for KB promotion

**Fail-open**: If state file absent, or memo directory empty — silent exit 0.

## Detection Script

`hooks/detect-codex-agent.sh` reads the SubagentStart event JSON from stdin, extracts `agent_name`, and outputs delegation instructions as `hookSpecificOutput` JSON. POSIX-portable - no external dependencies beyond `sed`, `grep`, `awk`.

### Execution Flow

```
1. SubagentStart event fires (matcher: "(^|:)codex-")
2. Event JSON received via stdin
   e.g.: {"agent_name": "codex-proxy", "task": "..."}
3. Extract agent_name via sed (POSIX-safe, no external dependencies)
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
the appropriate Codex MCP tool (`codex({ op: "create", ... })` or `codex({ op: "send", ... })`)
to forward ALL work to Codex CLI. Do NOT generate your own response in
place of calling Codex. Call the MCP tool immediately with the full task.
```

This message is appended to the agent's system prompt, forcing the agent to call the Codex MCP tool.

## Dependencies

No external dependencies. Uses only POSIX utilities: `sed`, `grep`, `awk`, `cat`, `printf`, `mktemp`.

## Notes

- Script must have execute permission (`chmod +x`)
- If the 5-second timeout is exceeded, the hook is ignored and the agent runs normally
- Invalid JSON output from the hook is ignored
- Agents without the `codex-` prefix (bare or namespaced) are filtered out at the matcher stage
