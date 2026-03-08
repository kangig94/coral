# Hook hookSpecificOutput: hookEventName required + event support matrix

## Rule
1. `hookSpecificOutput` requires `hookEventName` field — without it, Claude Code raises HookError.
2. `hookSpecificOutput` is only supported on specific events. The validated schema per event:

| Event | hookSpecificOutput fields |
|---|---|
| `UserPromptSubmit` | `hookEventName` (required), `additionalContext` (required) |
| `PreToolUse` | `hookEventName`, `permissionDecision`, `permissionDecisionReason`, `updatedInput` |
| `PostToolUse` | `hookEventName`, `additionalContext` (optional) |
| `Stop` | **Not supported** — use top-level `decision`, `reason`, `systemMessage` instead |

## Why
- Missing `hookEventName`: Claude Code can't route the output, treats it as malformed JSON → HookError (silent, not visible to user or model).
- Using `hookSpecificOutput` on `Stop`: JSON validation fails against the schema. Stop hooks only accept top-level fields like `decision: "block"`, `reason`, `systemMessage`.

## Pattern
```js
// WRONG — missing hookEventName
console.log(JSON.stringify({
  hookSpecificOutput: { additionalContext: 'text' },
}));

// WRONG — hookSpecificOutput on Stop event
console.log(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'text' },
}));

// RIGHT — UserPromptSubmit/PostToolUse with hookEventName
console.log(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'text' },
}));

// RIGHT — Stop event with top-level fields
console.log(JSON.stringify({
  decision: 'block',
  reason: 'Review needed',
  systemMessage: 'Please review before stopping.',
}));
```
