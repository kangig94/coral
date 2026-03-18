# Vitest Fake Timers: Attach Rejection Handler Before Advancing Time

## Rule
When using `vi.useFakeTimers()`, always attach `expect(promise).rejects.toThrow(...)` as a stored assertion BEFORE calling `vi.advanceTimersByTimeAsync()`. Advancing time first fires the rejection before any `.catch` handler is attached, producing an unhandled rejection warning or test failure.

## Why
`vi.advanceTimersByTimeAsync()` synchronously fires pending timers which may immediately reject a promise. If `.rejects` is not yet attached, Node.js treats it as an unhandled rejection. Storing the assertion first (`const assertion = expect(promise).rejects.toThrow(...)`) registers the `.catch` handler immediately without awaiting it, so the rejection is caught when it fires.

## Pattern
```typescript
// WRONG — timer fires before rejection handler is attached
await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
await expect(promise).rejects.toThrow('inactivity'); // too late: unhandled rejection

// RIGHT — attach handler first, then advance time
const assertion = expect(promise).rejects.toThrow('killed after 10 minutes of inactivity');
await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
await assertion; // now resolves after the rejection is caught
```

## Context
`src/runner/__tests__/engine.test.ts` — idle timeout test in `spawnCli`. The idle timer rejects the promise after 10 minutes; advancing fake time caused an unhandled rejection when the assertion wasn't pre-registered.
