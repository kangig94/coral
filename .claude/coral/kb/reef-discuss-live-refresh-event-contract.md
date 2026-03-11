# Reef Discuss Live Refresh Must Follow Real Upstream Event Names
Promoted: 2026-03-11 | Updated: 2026-03-11
## Rule
`coral-reef` discuss pages must refresh from actual upstream SSE/WS event names, not from synthetic names that no producer emits. If the upstream backend only emits `job:*` and `session:updated`, either subscribe to those events as invalidation hints or add a real discuss event on the producer side before teaching the UI to wait for one.
## Why
The discuss viewer can look "live-enabled" while never actually refreshing on discuss mutations. This drift is especially easy to miss because the initial page load works and reconnect events still trigger refetches, so the bug only appears during normal in-session updates.
## Pattern
Right:
```ts
// Producer emits a real event...
writeSseEvent(res, 'session:updated', payload);

// ...and reef listens to the same event name.
if (event === 'session:updated' || event === 'ready' || event === 'connected') {
  void loadTranscript();
}
```

Wrong:
```ts
// No producer emits this.
if (event === 'discuss:event') {
  void loadTranscript();
}
```
