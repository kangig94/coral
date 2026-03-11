# Reef Discuss Targeted Refresh Needs a Post-Sync UI Signal
Promoted: 2026-03-11 | Updated: 2026-03-11
## Rule
When `coral-reef` treats upstream `discuss:updated` as a targeted refresh trigger, do not let the browser refetch discuss detail on that raw upstream event unless the local SQLite refresh has already committed. Consume the upstream event inside `connection-manager`, refresh the affected discuss row, and emit a separate browser-facing post-sync event only after the local write succeeds.
## Why
`SseClient` and `connection-manager` can broadcast upstream events immediately, while the targeted refresh path is asynchronous and often debounced. If the browser refetches reef-local `/api/discuss/...` on the raw upstream invalidation, it can read stale SQLite rows even though coral itself would already serve the committed `lastSeq`. The bug looks like flaky live refresh rather than a hard failure.
## Pattern
Right:
```ts
if (event === 'discuss:updated') {
  await syncDiscussSession(originId);
  broadcast('discuss:synced', { sessionId: reefId, lastSeq });
}
```

Wrong:
```ts
if (event === 'discuss:updated') {
  broadcast('discuss:updated', payload);
  void syncDiscussSession(originId);
}
// UI refetch can beat the local DB write.
```
