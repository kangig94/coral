# Bash PreToolUse Rewrites — updatedInput Shape
Promoted: 2026-03-13 | Updated: 2026-03-16
## Rule
A `PreToolUse` hook that rewrites a Bash command must return `hookSpecificOutput.updatedInput` as a **flat tool_input object** (spread original, override `command`). The `updatedInput` value IS `tool_input` — do not nest `tool_input` inside it. Must include `hookEventName: "PreToolUse"`.
## Why
Wrapping as `updatedInput: { tool_input: { command } }` causes Claude Code to error (`undefined is not an object (evaluating 'H.includes')`) because it expects `updatedInput` to be the tool_input shape directly. Omitting `hookEventName` causes the `updatedInput` to be silently ignored.
## Pattern
Right — spread original tool_input, override command:
```js
const updatedInput = { ...input.tool_input, command: rewritten };
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    updatedInput,
  },
}));
```

Wrong — nested tool_input (causes runtime error):
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "updatedInput": {
      "tool_input": {
        "command": "rewritten command"
      }
    }
  }
}
```

Wrong — missing hookEventName (rewrite silently ignored):
```json
{
  "hookSpecificOutput": {
    "updatedInput": {
      "command": "rewritten command"
    }
  }
}
```
