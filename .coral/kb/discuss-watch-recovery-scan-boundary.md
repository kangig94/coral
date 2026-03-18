# Discuss Watch Recovery Scan Boundary
Promoted: 2026-03-12 | Updated: 2026-03-12
## Rule
When verifying the `discuss_watch` recovery single-scan contract, measure the manager-owned `readSessionEvents()` hydration pass, not total `readDiscussEventLog()` calls across the whole recovery flow. `DiscussSessionStore.load()` already reads `events.jsonl` to rebuild the snapshot, so the actionable invariant is that `DiscussManager` performs one additional shared scan for abort detection, watch-history hydration, and recovery gating, and polling adds no more reads after attach.
## Why
An assertion against total event-log reads will fail even after the watch-cursor design is fixed, because store reconstruction and manager hydration currently sit on different layers. That produces a false negative in the regression test and obscures the real contract: removing duplicate manager-side scans on cold attach and resume.
## Pattern
Right:
```ts
const readSessionEventsSpy = vi.spyOn(manager as unknown as {
  readSessionEvents(sessionId: string): DiscussDomainEvent[];
}, 'readSessionEvents');

await manager.recoverPersistedSessions(ctx);
expect(readSessionEventsSpy).toHaveBeenCalledTimes(1);
manager.getWatchState(sessionId);
expect(readSessionEventsSpy).toHaveBeenCalledTimes(1);
```

Wrong:
```ts
const logSpy = vi.spyOn(eventLogModule, 'readDiscussEventLog');

await manager.recoverPersistedSessions(ctx);
expect(logSpy).toHaveBeenCalledTimes(1); // store.load() already consumed the log
```
