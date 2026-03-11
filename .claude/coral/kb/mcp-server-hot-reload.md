# MCP Server Hot-Reload

## Rule
Rebuilding `bridge/coral-ax.cjs` (or `bridge/coral-backend.cjs`) via `npm run build` does NOT affect the running MCP server process — Claude Code starts MCP servers as long-running child processes that load the bundle once at startup. However, `/reload-plugins` (built-in CLI command) hot-reloads MCP servers without restarting the session. Do not kill MCP server processes directly — Claude Code will not respawn them.

For new sessions: a `SessionStart` hook with `matcher: "startup"` runs before MCP servers load, so freshly built bridge files are picked up automatically.

## Why
The plugin cache at `~/.claude/plugins/cache/coral/` is a symlink to the workspace, so `npm run build` updates the file on disk — but the running process still holds old code in memory. `/reload-plugins` restarts the MCP server processes cleanly within the same session.

## Pattern
```
# WRONG — kills tool availability permanently
kill <mcp-server-pid>

# RIGHT — rebuild then reload within session
npm run build
/reload-plugins
# Output: "Reloaded: 2 plugin(s) · 0 command(s) · 22 agent(s) · 15 hook(s) · 3 MCP server(s)"

# RIGHT — SessionStart hook ensures fresh build on new sessions
# (hook runs before MCP servers load, no /reload-plugins needed)
```
