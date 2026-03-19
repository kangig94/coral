# waitForCondition Already Returns the Satisfying State

## Rule
When `waitForCondition` returns with `fulfilled: true`, its `.state` field is the `DiscussState` that triggered the predicate. Any `loadLocked` / `load` call immediately after a fulfilled wait is a redundant disk read + lock acquisition — the data is already in hand.

## Why
The discuss hot path (bid resolution, step bidding) had callers doing:
```ts
const waited = await waitForCondition(statePath, predicate, timeout);
if (!waited.fulfilled) return error;
const state = await store.loadLocked(sessionDir); // ← redundant: waited.state already has this
```
Each redundant `loadLocked` acquires the session mutex and reads `state.json` from disk. With 4 agents bidding concurrently, this adds 4 serialized lock acquisitions per step cycle.

## Pattern
```ts
// Wrong — re-reads state that waitForCondition already returned
const released = await waitForCondition(statePath, predicate, INFINITE_POLL);
if (!released.fulfilled) return error;
const state = await store.loadLocked(sessionDir); // redundant
return handle(state);

// Right — use the state from waitForCondition directly
const released = await waitForCondition(statePath, predicate, INFINITE_POLL);
if (!released.fulfilled || !released.state) return error;
return handle(released.state);
```

Note: when `WaitResult.fulfilled` is `boolean` (not narrowed to `true`), TypeScript won't narrow `.state` automatically — guard with `!released.state` check after the `!released.fulfilled` check. The lock is only needed when you need to **write**, not for a final read-only inspection.
