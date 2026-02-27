# Claude Code: Agent Teams Fail Under tmux — Multiple Root Causes

## Rule
When Claude Code agent teams break in tmux environments, there are at least 4 independent failure modes. Diagnose by mode before applying a fix — a single workaround rarely covers all of them.

## Why
Treating this as a single bug wastes time. Each failure mode has a distinct symptom and fix. The combination of tmux send-keys timing, inbox polling, background subagent tool registration, and environment variable propagation produces intermittent, hard-to-reproduce breakage.

## Pattern

**Failure Mode 1 — tmux send-keys race condition** (issues #23513, #23415):
`tmux send-keys "$cmd" Enter` fires before the shell finishes initializing. Long commands (350+ chars) make it worse. Teammates sit idle at a prompt, never executing.
Fix: add `set-hook -g after-split-window "run-shell 'sleep 0.3'"` to `tmux.conf`, or use `--teammate-mode in-process`.

**Failure Mode 2 — Inbox polling not reinitializing** (issue #23415):
`TeammateMailbox.readMailbox()` polling starts during team creation but doesn't reinitialize on session resume. Teammates spawned correctly still never receive messages after restart.
Fix: restart the full session rather than resuming; or use in-process mode.

**Failure Mode 3 — Background subagents lose MCP tool access** (issue #13254):
`run_in_background: true` subagents consistently cannot see MCP tools. `run_in_background: false` works. Confirmed across versions 2.0.60–2.1.19+.
Fix: avoid `run_in_background: true` for agents that need MCP tools.

**Failure Mode 4 — Environment variable propagation** (issues #23999, #23676):
`CLAUDE_PLUGIN_ROOT`, `CLAUDE_CONFIG_DIR`, and other env vars are not propagated to tmux split-pane child processes.
Fix: set `default-command "bash --norc --noprofile"` in `tmux.conf`, or explicitly export env vars in shell init.

**Universal fallback**: `--teammate-mode in-process` bypasses all tmux-related issues.
