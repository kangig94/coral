# Unhandled Rejection with Fake Timers in Vitest

## Rule
When testing async functions that reject via timer-driven paths using `vi.useFakeTimers()`, attach a no-op `.catch(() => {})` to the promise immediately after creation — before calling `vi.runAllTimersAsync()` or `vi.advanceTimersByTimeAsync()`. The `expect(promise).rejects.toThrow(...)` handler registers too late to prevent the "unhandled rejection" event.

## Why
Vitest treats unhandled rejections as test errors even when the rejection is intentional. The sequence `const p = asyncFn(); await vi.runAllTimersAsync(); await expect(p).rejects.toThrow()` creates a window where the promise rejects during timer flush but no handler is attached yet. Node.js fires `unhandledRejection` in that window.

## Pattern
```typescript
// WRONG — unhandled rejection during timer flush
const promise = acquireLock('challenger', '1.0.0');
await vi.runAllTimersAsync();
await expect(promise).rejects.toThrow('already running');

// RIGHT — no-op handler prevents false positive
const promise = acquireLock('challenger', '1.0.0');
void promise.catch(() => {}); // prevent unhandled rejection during timer flush
await vi.runAllTimersAsync();
await expect(promise).rejects.toThrow('already running');
```
