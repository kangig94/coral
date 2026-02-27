# Async Preflight Breaks Unawaited Handler Side-Effect Tests

## Rule
When an async preflight (e.g., CLI detection, auth check) is inserted into an MCP tool handler, any test that calls the handler without `await` and then immediately checks side effects (like `activeBackgroundFiles.has(...)`) will silently fail. The fix is to `await` the handler call so execution reaches the side-effecting code before the assertion runs.

## Why
An async preflight introduces a microtask boundary at the top of the handler. With `void handler()`, JavaScript returns control to the test immediately after the first `await` inside the handler — before `launchBackground` or any subsequent side effects are called. The assertion fires on an empty/unchanged state.

## Pattern
```typescript
// WRONG: void call — preflight suspends at first await, launchBackground not called yet
void handleToolCall('codex', { op: 'exec', prompt: 'hello', background: true }, mgr);
expect(activeBackgroundFiles.has('/tmp/progress.jsonl')).toBe(true); // fails: false

// RIGHT: await the handler — preflight + launchBackground complete before assertion
await handleToolCall('codex', { op: 'exec', prompt: 'hello', background: true }, mgr);
expect(activeBackgroundFiles.has('/tmp/progress.jsonl')).toBe(true); // passes

// Note: for background handlers, handleToolCall still returns quickly (after launchBackground)
// because launchBackground itself is synchronous (it fires the background task and returns).
// So await here does NOT block until the background work finishes.
```
