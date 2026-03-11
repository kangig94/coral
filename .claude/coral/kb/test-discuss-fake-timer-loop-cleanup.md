# Discuss Tests Must Clear Live Loop Timers Before Flushing Fake Time
Promoted: 2026-03-11 | Updated: 2026-03-11
## Rule
In discuss tests that use `vi.useFakeTimers()`, do not flush pending timers while a live session still has a scheduled `resumeLoop()` callback. Abort or detach the live session first, or clear timers instead of running them during `afterEach`.
## Why
`manager.start()` schedules `resumeLoop()` with `setTimeout(0)`. If cleanup runs `runOnlyPendingTimersAsync()` before the session is torn down, Vitest executes the real background discuss loop during teardown. That loop can launch bids, speeches, follow-up turns, and more timers, which turns a simple tool test into a hanging process.
## Pattern
```ts
// Right: tear down the live session, then clear fake timers.
afterEach(() => {
  cleanupDiscussHarnesses();
  vi.clearAllTimers();
  vi.useRealTimers();
});
```

```ts
// Wrong: flushing timers while the live session is still attached.
afterEach(async () => {
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
});
```
