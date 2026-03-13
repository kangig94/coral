# Bash PreToolUse Rewrites Must Use `updatedInput`
Promoted: 2026-03-13 | Updated: 2026-03-13
## Rule
A `PreToolUse` hook that rewrites a Bash command must read the pending command from `input.tool_input.command` and return the mutation through `hookSpecificOutput.updatedInput.tool_input.command`. Writing only generic `hookSpecificOutput` text does not change the tool invocation.
## Why
Coral hook scripts often emit `hookSpecificOutput.additionalContext`, which is valid for reminders and annotations but not for command mutation. Reusing that pattern for a CLI rewrite silently produces a no-op hook: the hook runs, but Claude still executes the original Bash command.
## Pattern
Right:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "updatedInput": {
      "tool_input": {
        "command": "CORAL_PLUGIN_ROOT=\"$CLAUDE_PLUGIN_ROOT\" node \"$CLAUDE_PLUGIN_ROOT/bridge/coral-cli.cjs\" backend status"
      }
    }
  }
}
```

Wrong:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "Use node bridge/coral-cli.cjs instead"
  }
}
```
