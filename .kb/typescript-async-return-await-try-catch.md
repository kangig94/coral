# Async Functions: return await Required Inside try/catch

## Rule
Inside an `async` function's `try/catch`, always write `return await somePromise()` — never `return somePromise()`. A bare `return` of a promise exits the `try` block immediately and delivers the unresolved promise to the caller; if that promise later rejects, the local `catch` never fires.

## Why
When you write `return promise` inside a try block, the async function suspends not at the `return` but at the point where the caller `await`s the outer function. The rejection occurs outside the local `try/catch`, so `catch` is bypassed and the rejection propagates to the caller as an unhandled rejection. This is especially dangerous in MCP handlers where the intent is to convert all executor errors into structured `isError` responses.

## Pattern

```typescript
// WRONG: catch never fires for async rejections
async function handleToolCall(...): Promise<McpResult> {
  try {
    return handleCodexOp(...); // returns a promise — catch is bypassed if it rejects
  } catch (err) {
    return textResult(`Error: ${err}`, true); // unreachable for async errors
  }
}

// CORRECT: catch fires for both sync throws and async rejections
async function handleToolCall(...): Promise<McpResult> {
  try {
    return await handleCodexOp(...); // await suspends here; rejection caught locally
  } catch (err) {
    return textResult(`Error: ${err}`, true);
  }
}
```

## Detection
This bug is invisible to tests unless the mocked dependency is configured to reject. A test suite that only mocks successful responses will never trigger the catch bypass. The red-attacker pattern of mocking executor functions to reject is what exposes this class of bug.
