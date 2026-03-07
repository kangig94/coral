# Plugin Hook Registration — Install vs plugin-dir Mode

## Rule
For hooks to work in `--plugin-dir ./` development mode, `plugin.json` must explicitly declare `"hooks": "./hooks/hooks.json"`. Without this declaration, some hooks (e.g., SessionStart) may work by coincidence or not fire at all. Manually copying to the cache directory also does not register new hook events — a proper install is required.

## Why
Without the `"hooks"` field in `plugin.json`, hooks.json is ignored in `--plugin-dir` mode. You end up debugging code and hook logic while missing the root cause entirely.

## Pattern
```json
// WRONG: no hooks declaration in plugin.json — PreToolUse etc. not registered in --plugin-dir mode
{
  "skills": "./skills/",
  "mcpServers": "./.mcp.json"
}

// RIGHT: hooks field explicitly declared
{
  "skills": "./skills/",
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json"
}
```

For quick hook logic verification during development, you can register hooks directly in `.claude/settings.local.json`:
```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node ...", "timeout": 5 }] }]
  }
}
```
Note: this file is gitignored, so final registration must go through `plugin.json` + `hooks/hooks.json`.
