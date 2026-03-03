# MCP Server Does Not Hot-Reload After Build

## Rule
Rebuilding `bridge/coral-discuss.cjs` (or `coral-ax.cjs`) via `npm run build` does NOT affect the running MCP server process. Claude Code starts MCP servers as long-running child processes that load the bundle once at startup. Do not kill the MCP server process — Claude Code will not respawn it, and the tool becomes permanently unavailable for the session. The only way to reload changed MCP server code is to restart the Claude Code session entirely.

## Why
The plugin cache at `~/.claude/plugins/cache/coral/` is a symlink to the workspace, so `npm run build` does update the file on disk — it just isn't picked up by the running process. Killing the process makes the tool unavailable with `No such tool available` for the rest of the session.

## Pattern
```
# WRONG — kills tool availability
kill <mcp-server-pid>
npm run build  # file updated, but server is gone

# RIGHT — rebuild then restart session
npm run build
# Restart Claude Code session to pick up changes
```
