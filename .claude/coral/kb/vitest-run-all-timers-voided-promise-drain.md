# vi.runAllTimersAsync Works With Voided setTimeout Only When Mocks Resolve Synchronously
Promoted: 2026-03-14 | Updated: 2026-03-14
## Rule
When testing a function that schedules work via `setTimeout(() => { void asyncFn() }, 0)`, calling `await vi.runAllTimersAsync()` drains the async work reliably ONLY when all mocked async operations resolve as microtasks (i.e., via `mockResolvedValue` / `Promise.resolve(value)`). The voided inner promise is not awaited by `runAllTimersAsync`; it resolves via the microtask queue in the single event-loop tick that `runAllTimersAsync` yields after firing the timer. If any mock introduces a real async delay (e.g., `setTimeout`, real `fs`, etc.), `runAllTimersAsync` returns before the work completes and assertions fail silently.
## Why
`resumeLoop()` in discuss-manager.ts is defined as `void this.continueLoop(...)` inside a `setTimeout(..., 0)`. Tests that call `resumeLoop()` then `await vi.runAllTimersAsync()` are depending on the inner `continueLoop` promise resolving within that single event-loop yield. This works today because all test stubs use `vi.fn().mockResolvedValue(...)` which produces immediately-resolving promises. A deferred stub (e.g., a `new Promise(resolve => setTimeout(resolve, 1))`) would silently slip past the drain.
## Pattern
```typescript
// Safe: all stubs use mockResolvedValue (microtask resolution)
const waitStreamOnce = vi.fn().mockResolvedValue({ content: 'ok', nonResumable: false });
vi.useFakeTimers();
manager.resumeLoop('session-1', ctx); // schedules void continueLoop(...) via setTimeout(0)
await vi.runAllTimersAsync();         // fires timer, yields 1 tick — continueLoop drains via microtasks
vi.useRealTimers();
// assertions on state are valid here

// Unsafe: deferred mock slips past the drain
const waitStreamOnce = vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(resolve, 1)));
// runAllTimersAsync returns BEFORE waitStreamOnce resolves — assertions see stale state
```
## Context
`src/execution/__tests__/discuss-manager-synthesis.test.ts`, `discuss-manager-speech.test.ts`, `discuss-manager-faults.test.ts` — all recovery tests that call `resumeLoop` explicitly after `recoverPersistedSessions` (attach-only).
