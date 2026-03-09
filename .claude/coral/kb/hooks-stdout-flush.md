# Hook hookSpecificOutput: hookEventName required; do not exclude SessionStart

## Rule
1. `hookSpecificOutput` requires `hookEventName` field — without it, Claude Code raises HookError.
2. Do not rely on a stale local support matrix. Current Claude Code hook docs explicitly allow `SessionStart` hooks to return JSON with `hookSpecificOutput.additionalContext`, and multiple matching hooks append their `additionalContext` together.
3. `Stop` does not use `hookSpecificOutput` — use top-level `decision`, `reason`, and related stop fields instead.

## Why
- Missing `hookEventName`: Claude Code can't route the output, treats it as malformed JSON → HookError (silent, not visible to user or model).
- Excluding `SessionStart` from structured output pushes plans toward false constraints such as "plain stdout only" or unnecessary hook consolidation.
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

// RIGHT — SessionStart with hookSpecificOutput.additionalContext
console.log(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'text' },
}));

// RIGHT — Stop event with top-level fields
console.log(JSON.stringify({
  decision: 'block',
  reason: 'Review needed',
  systemMessage: 'Please review before stopping.',
}));
```
