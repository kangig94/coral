# Event-Driven Wait with changeSeq Pattern
## Rule
When replacing polling with event-driven notification on a shared in-memory store, use a monotonic sequence counter (`changeSeq`) to avoid missed-notification races. Callers snapshot the seq before reading state, then pass it to `waitForChange(sinceSeq)` — if seq has already advanced, return immediately instead of blocking.
## Why
A simple `waitForChange()` without a sequence has a race: if `notifyWaiters()` fires between the caller reading state and registering its waiter, the notification is lost and the caller blocks forever. This caused a 5s test timeout in `service.test.ts` workflow tests.
## Pattern
```typescript
// Wrong: race between read and wait registration
const status = store.readStatus(jobId);     // notify fires HERE
await store.waitForChange();                // waiter registered too late — blocks forever

// Right: snapshot seq before reading
const seq = store.getChangeSeq();           // snapshot
const status = store.readStatus(jobId);     // notify fires HERE, seq advances
await store.waitForChange(seq);             // seq !== sinceSeq → returns immediately
```
