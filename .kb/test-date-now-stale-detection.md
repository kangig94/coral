# Mock Date.now for Sub-Millisecond Stale Detection Tests

## Rule
When testing time-based stale detection with `staleTimeoutMs: 1` (or any sub-10ms threshold), mock `Date.now` to guarantee time advances between calls. Sync mock functions resolve within the same millisecond, so `Date.now()` often returns identical values across the setup and check phases, causing stale detection to never trigger.

## Why
Without mocking, the stale check `now - lastActive < staleTimeoutMs` evaluates as `0 < 1` → atom never appears stale → recovery never triggers → `waitForAtoms` loops forever consuming memory → OOM crash. The test appears to hang/OOM with no useful error.

## Pattern
```typescript
// RIGHT: mock Date.now to advance deterministically
let mockNow = 10_000;
vi.spyOn(Date, 'now').mockImplementation(() => {
  mockNow += 10;
  return mockNow;
});
try {
  // ... test with staleTimeoutMs: 1
} finally {
  vi.restoreAllMocks();
}

// WRONG: rely on real Date.now() with staleTimeoutMs: 1
// Real clock may not advance between sync mock calls
await waitForAtoms(atoms, svc, ctx, { staleTimeoutMs: 1 }); // potential infinite loop
```
