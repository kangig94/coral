# Discuss Wait Corruption Threshold Can Trip Before First Poll
Promoted: 2026-03-09 | Updated: 2026-03-09
## Rule
When `waitForCondition` treats unreadable state reads as consecutive corruption failures, remember that the initial read and the post-watch reread both count before the poll loop begins. Any test or fallback path that expects recovery after those two reads must publish a valid `state.json` before the first scheduled poll, or raise the read-error threshold for that scenario.
## Why
The no-watcher fallback path can fail with `state_corrupt` earlier than expected. If a test creates the watched directory and writes the state only after one full poll interval, the third unreadable read happens before the valid state exists, so the wait exits as corrupt instead of proving the polling fallback.
## Pattern
```ts
// Wrong: the valid state arrives after the first poll, so initial read +
// post-watch reread + first poll can already hit the corruption threshold.
setTimeout(() => {
  mkdirSync(missingDir, { recursive: true });
  writeStateAtomic(path, endedState);
}, INTERVAL + 5);
```

```ts
// Right: publish the directory and state before the first poll read.
setTimeout(() => {
  mkdirSync(missingDir, { recursive: true });
  writeStateAtomic(path, endedState);
}, 5);
```
