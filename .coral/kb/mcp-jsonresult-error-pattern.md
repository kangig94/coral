# jsonResult Is 1-arg Only — Use textResult for isError Responses

## Rule
`jsonResult(data)` in `src/shared/mcp-utils.ts` accepts exactly one argument and always returns `isError: false`. To return a JSON-structured body with `isError: true`, use `textResult(JSON.stringify(data, null, 2), true)`. Calling `jsonResult(data, true)` is a TypeScript compile error (`Expected 1 arguments, but got 2`).

## Why
`jsonResult` is a pure formatting shortcut: `return textResult(JSON.stringify(data, null, 2))`. It was never designed to carry error state. The `isError` flag belongs to `textResult`. When a handler needs to return a machine-readable JSON error with `isError: true`, developers often instinctively reach for `jsonResult(body, true)` — but this fails to compile. The inconsistency between "JSON error body" and "error flag" is the root cause.

## Pattern
```typescript
// WRONG — compile error: Expected 1 arguments, but got 2
return jsonResult({ error: 'no_required_agents', message: '...' }, true);

// RIGHT option A — return JSON error body without isError (use error key for machine parsing)
return jsonResult({ error: 'no_required_agents', message: 'At least one agent must have participation: required' });

// RIGHT option B — use textResult when isError: true matters to the caller
return textResult(JSON.stringify({ error: 'no_required_agents', message: '...' }, null, 2), true);
```

Note: In this codebase, the discuss server conventionally uses option A (jsonResult with error key, no isError flag) for domain errors, consistent with how the existing `resolveWinner` error path is surfaced. The MCP client distinguishes errors by checking the `error` key, not `isError`.
