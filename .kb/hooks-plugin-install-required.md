# Plugin Hook Registration — hooks.json Only, Not plugin.json

## Rule
Plugin hooks are registered via `hooks/hooks.json` in the plugin directory. Do NOT add a `"hooks"` field to `plugin.json` — this causes `PreToolUse hook error` on every tool call in installed plugin mode. The Claude Code plugin system discovers `hooks/hooks.json` automatically from the plugin directory structure.

For `--plugin-dir ./` development mode, hooks from `hooks/hooks.json` may not register for all events. Use `.claude/settings.local.json` to register hooks directly during development testing.

## Why
Adding `"hooks": "./hooks/hooks.json"` to `plugin.json` was attempted to fix `--plugin-dir` hook registration. It appeared to work in dev mode but caused `PreToolUse:Read hook error` (and similar) on every tool call when the plugin is installed normally. The `plugin.json` `hooks` field is not a supported plugin manifest key.

## Pattern
```json
// WRONG: hooks field in plugin.json — causes hook errors in installed mode
{
  "skills": "./skills/",
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json"
}

// RIGHT: hooks.json lives in hooks/ directory, discovered automatically
// plugin.json has NO hooks field
{
  "skills": "./skills/",
  "mcpServers": "./.mcp.json"
}
```

For dev-mode hook testing, use `.claude/settings.local.json` (gitignored):
```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Skill", "hooks": [{ "type": "command", "command": "node hooks/kb-promote-gate.mjs", "timeout": 5 }] }]
  }
}
```
