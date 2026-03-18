# Stale Recovery Tests Require Date.now Mock
Promoted: 2026-03-18 | Updated: 2026-03-18
## Rule
Any test exercising stale recovery in `waitForAtoms` must mock `Date.now` to guarantee time advances between `lastActivityAt` assignment and the stale check in `recoverStaleAtom`. Without the mock, real `Date.now()` may not advance 1ms between synchronous mock calls, causing stale detection to never trigger.

## Why
`recoverStaleAtom` checks `now - lastActive < staleTimeoutMs`. With `staleTimeoutMs: 1` (minimum for enabling stale detection), the sub-millisecond execution of mock code means the check may always be false, preventing recovery. The test then processes the aborted terminal as a real failure instead of an expected stale abort.

## Pattern
```typescript
// RIGHT: mock Date.now with guaranteed monotonic advance
let mockNow = 10_000;
vi.spyOn(Date, 'now').mockImplementation(() => {
  mockNow += 10;
  return mockNow;
});
try {
  // ... test code with staleTimeoutMs: 1, pollIntervalMs: 1 ...
} finally {
  vi.restoreAllMocks();
}

// WRONG: rely on real Date.now() with staleTimeoutMs: 1
// Flaky — recovery may never trigger
```
