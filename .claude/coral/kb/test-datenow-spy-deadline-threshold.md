# Testing Deadline Expiry via Date.now Spy with Call-Count Threshold

## Rule
When code uses `Date.now()` for deadline comparisons but also calls `sleep()` (real `setTimeout`) internally, use `vi.spyOn(Date, 'now')` with a call-count threshold instead of `vi.useFakeTimers()`. Return real time for the first N calls (setup phase), then return `realNow() + timeout + buffer` to trip the deadline on the next check.

## Why
`vi.useFakeTimers()` freezes all timer behavior including `setTimeout` inside `sleep()`, which causes async polling loops to stall indefinitely. When the production code intermixes `Date.now()` deadline checks with `await sleep(INTERVAL)` polling, fake timers break the test. The spy approach leaves `setTimeout` real while controlling only the deadline comparison.

## Pattern
```typescript
// Code under test: uses Date.now() for deadline, sleep() for polling
// while (pending.size > 0) {
//   if (Date.now() >= drainDeadline) throw firstFailure;
//   await sleep(WAIT_POLL_INTERVAL_MS, signal);
// }

let callCount = 0;
const realNow = Date.now.bind(Date);
const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
  callCount += 1;
  // First ~N calls: real time (setup + deadline recording)
  // After threshold: return far-future to trip the deadline check
  if (callCount > 6) return realNow() + SIBLING_DRAIN_TIMEOUT_MS + 1_000;
  return realNow();
});

try {
  await expect(fn()).rejects.toThrow('expected error');
} finally {
  nowSpy.mockRestore(); // always restore — spy leaks across tests if not cleaned up
}
```

The threshold (e.g. `> 6`) must be calibrated to let `drainDeadline = Date.now() + timeout` execute with real time, then trigger expiry on the next iteration's deadline check. Too low trips before the deadline is set; too high causes the real timeout to fire first.

## Context
`src/workflow/__tests__/pipe-executor.test.ts` — `waitForAllAtoms` drain deadline test. `SIBLING_DRAIN_TIMEOUT_MS = 15_000` is too long to wait in CI; the spy cuts it to a single poll cycle.
