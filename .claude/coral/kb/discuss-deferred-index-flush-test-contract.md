# Deferred Index Writes Require Explicit Flush in Tests
Promoted: 2026-03-17 | Updated: 2026-03-17
## Rule
`DiscussSessionStore.append()` defers discovery/summary/project-roots index writes via dirty flags. Tests and helpers that call `append()` and then assert index state or rely on discovery for session lookup must call `store.flushDirtyIndexes()` before those assertions. Test helpers `persistSession()` and `appendPersistedEvents()` in `discuss-test-helpers.ts` flush automatically after appending.
## Why
Without explicit flush, indexes remain dirty after `append()`. Tests that read `discovery.json` or `summary-index.json` directly will find stale or missing data. Server API tests that resolve sessions via discovery will get `authority: 'persisted'` instead of `'live'`, or fail to find sessions entirely.
## Pattern
```typescript
// Right: flush before asserting index state
await store.append(sessionId, seq, events);
store.flushDirtyIndexes();
const discovery = readDiscussDiscovery(projectRoot);
expect(discovery?.sessions).toHaveLength(1);

// Right: listing methods auto-flush (no manual call needed)
await store.append(sessionId, seq, events);
const summaries = store.listSummaries(); // triggers flushDirtyIndexes() internally

// Wrong: asserting index state without flush
await store.append(sessionId, seq, events);
const discovery = readDiscussDiscovery(projectRoot); // may be null — indexes not yet written
```
