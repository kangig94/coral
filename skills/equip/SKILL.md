---
name: equip
description: "One-touch install of MCP tools to enhance Claude's capabilities"
argument-hint: "[--list | [--update] cgc[@version] | kb[@version]]"
---

# Equip

Install and configure MCP tools for Claude Code.

## Execution

### No argument or `--list`

1. Bash(`node equip/install.mjs --list`)
2. Present catalog as a table (id, name, description)
3. Ask the user which package to install

### `<package>` (e.g., `cgc` or `kb`)

1. Bash(`node equip/install.mjs <package>`)
2. Parse JSON output (single line from stdout)
3. Route by `status`:

| status | Action |
|--------|--------|
| `already_installed` | Inform user, continue to Post-Install Routing |
| `already_up_to_date` | Inform user (version shown), done |
| `installed` | Show method used, continue to Post-Install Routing |
| `updated` | Show method and version, continue to Post-Install Routing |
| `error` | Show `message` and `suggestions`, stop |

### Post-Install Routing

1. If `mcp` field present → continue to MCP Registration
2. If `postInstall` field present → execute each action in order:
   - `backend_shutdown`: call `backend({ op: "shutdown" })`. Continue on success or connection-refused (not running).
   - `kb_reindex`: call `kb_reindex()`.
   - Inform user: "Enhanced KB mode activated."
3. If neither → inform user "Installed.", done

### MCP Registration

1. Read `~/.claude/settings.json` (create with `{}` if absent)
2. Ensure top-level `mcpServers` object exists
3. If `mcp.serverName` already in `mcpServers`: "Already registered", done
4. Add entry from script output:
   ```json
   {
     "mcpServers": {
       "<mcp.serverName>": {
         "command": "<mcp.command>",
         "args": ["<mcp.args>"]
       }
     }
   }
   ```
5. Inform user: "Installed. Start a new Claude Code session to activate the new MCP tools."

## Notes

- Binary installs go to `~/.claude/tools/`
- ARM platforms (Apple Silicon, Linux ARM64) fall back to `uv tool install` or `pipx install`
- To force reinstall, delete the binary from `~/.claude/tools/` and run again
