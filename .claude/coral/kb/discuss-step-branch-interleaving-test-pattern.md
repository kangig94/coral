# Testing _3_step Conditional Branches via Lock-Interleaved State Writes

## Rule
To reliably reach conditional branches inside `_3_step` (e.g. `bids_not_complete`, `speech_not_done`, `expected_speech_entry`), start the step call, hold the session lock from the test while writing a temporary state that satisfies the wait predicate, then write the post-wait target state before releasing the lock. This forces deterministic branch entry without modifying production code.

## Why
`_3_step` uses `waitForCondition` (file-watch polling) then re-acquires a write lock before acting on the result. Simply writing state after the step starts is racy — the step may re-read state before or after the test write. Holding the lock between the two test-side writes guarantees the step sees the exact transition the test intends.

## Pattern
```typescript
const stepPromise = handleToolCall('discuss_lead', { op: '_3_step', session: sid, ... }, store);
await sleep(20);  // let step enter waitForCondition

await store.withLock(sessionDir, async () => {
  const current = store.load(sessionDir);
  // Write state that satisfies the wait predicate (e.g. bidding + speech_step mismatch)
  store.save(sessionDir, { ...current, status: 'bidding', last_speech_step: current.step - 1 });
  await sleep(120);  // hold lock while waitForCondition unblocks and step tries to acquire
  // Write the state we actually want the step to observe inside the lock
  store.save(sessionDir, current);
});

const result = await stepPromise;
// result.data.error === 'speech_not_done' (or whichever branch was targeted)
```
The `sleep` inside the lock must exceed the step's internal poll interval to guarantee the predicate read happens before the lock is released.
