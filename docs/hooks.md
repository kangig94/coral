# Hooks

Hooks provide automatic context injection, agent routing, and error-aware KB reminders.

## Overview

Claude Code's hook system executes shell scripts on specific events. Coral uses four hooks:

1. **SessionStart** - Injects CLAUDE.md behavioral guidelines into every Claude session
2. **SubagentStart** - Injects delegation instructions into agents with a `codex-` prefix (with or without `coral:` namespace)
3. **PostToolUseFailure** - On any tool failure, reminds Claude to check `.claude/coral/kb/` before debugging
4. **TeammateIdle** - Blocks idle when discuss agents have pending actions

## Hook Configuration

Configuration: `hooks/hooks.json`. Scripts: `hooks/detect-codex-agent.sh`, `hooks/kb-lookup-reminder.sh`, `hooks/discuss-idle-guard.sh`.

## SessionStart Hook

Injects the plugin's CLAUDE.md content into Claude's context at the start of every session. This ensures Claude always receives the behavioral guidelines (Simplicity First, Surgical Changes, etc.) and KB system instructions.

> **Note**: Codex sessions receive CLAUDE.md through a separate mechanism - the MCP server prepends it to the prompt in `executeOneShot()`. See [Core Modules](./core-modules.md) for details.

## SubagentStart Hook

Matches agents with the `codex-` prefix (bare or namespaced, e.g., `coral:codex-proxy`) and injects delegation instructions. Timeout: 5 seconds (hook is ignored if exceeded).

## PostToolUseFailure Hook

On any tool failure, reminds Claude to check `.claude/coral/kb/` before debugging from scratch. Script: `hooks/kb-lookup-reminder.sh`. Matcher: `*` (all tools).

**Output**: `hookSpecificOutput.additionalContext` with KB file listing. Non-blocking — Claude receives the reminder as additional context.

**Fail-open**: If KB directory doesn't exist or has no `.md` files — silent exit 0.

> **Note**: Plugin hooks do not trigger `PostToolUseFailure`. To activate, register in `.claude/settings.json` or `.claude/settings.local.json`.

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
