# Discovery Repair Must Merge Valid Index Rows with Snapshot Scan Fallback
Promoted: 2026-03-11 | Updated: 2026-03-11
## Rule
When `discovery.json` is stale, do not discard it wholesale and rebuild listings only from `state.json`. Keep any discovery row whose `sessionDir` still points to a usable discuss session, scan the project discuss directory for additional snapshot-backed sessions, and repair the listing with a union of the valid discovery rows plus the scan results.
## Why
`discovery.json` can remain the only surviving index entry for a committed session when `state.json` is temporarily missing but `event-log.jsonl` can still recover the snapshot. A pure scan fallback would silently drop that session from listings and recovery, while a pure discovery read would miss newly committed sessions after a clobbered or stale rewrite.
## Pattern
```ts
const discovered = readDiscussDiscovery(projectRoot);
const scanned = scanPersistedDiscussSessions(projectRoot);

const usableDiscovered = (discovered?.sessions ?? []).filter((session) =>
  hasStateOrEventLog(session.sessionDir),
);

const merged = new Map(usableDiscovered.map((session) => [session.sessionId, session]));
for (const session of scanned) {
  if (!merged.has(session.sessionId)) merged.set(session.sessionId, session);
}

return [...merged.values()];
```

```ts
// Wrong: if state.json is deleted, this loses a session that discovery could still resolve.
return scanPersistedDiscussSessions(projectRoot);
```
