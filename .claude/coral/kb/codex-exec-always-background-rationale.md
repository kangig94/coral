# Exec-Always-Background: Why a Single Async Path

## Rule
Codex `exec` always dispatches in background and returns instantly. There is no foreground mode. Callers use `exec → wait → Read` (3 steps) instead of blocking `exec` (1 step). This is the correct architecture despite the extra caller complexity.

## Why
MCP tool calls are synchronous — the client blocks until the server responds. Foreground Codex execution (minutes to 10+ minutes) risks two failures:

1. **Tool call timeout**: Claude Code or the MCP transport may timeout the tool call before Codex finishes. The response is lost.
2. **Dual-path complexity**: A `background: true/false` flag forces every caller to handle two response shapes — instant `{ session, session_dir, status }` vs blocking `{ response }`. Each agent and skill needs both code paths.

The exec-always-background design eliminates both:
- Timeout: `wait` has an explicit `timeout_seconds` (1–600). Caller controls how long to block. On timeout, caller can re-wait with cursors — no work is lost.
- Dual-path: One response shape, one caller pattern. All agents and skills follow exec → wait → Read.

## Pattern
```
// Tradeoff: 3 steps instead of 1, but one code path instead of two.
// Every caller follows the same pattern — no branching.
exec  → { session, session_dir }              // instant, never blocks
wait  → { status, completed_session }         // blocks up to timeout_seconds
Read  → result.md / status.json               // filesystem retrieval
```
