# Discuss Listing Needs A Summary Index
Promoted: 2026-03-15 | Updated: 2026-03-15
## Rule
When optimizing `/api/discuss`, do not stop at removing execution-session scans from `knownDiscussProjectRoots()`. The listing path also needs an authoritative persisted summary index; otherwise the endpoint still reloads every discuss snapshot from disk on each request.
## Why
`listDiscussSessions()` has two separate costs: project-root discovery and per-session summary loading. Fixing only the first cost leaves the endpoint O(number of discuss sessions) in disk reads because `DiscussSessionStore.listSummaries()` still resolves and loads every persisted session. This looks like progress in profiling while preserving the real scaling problem.
## Pattern
Right:
```ts
type DiscussDiscoverySession = {
  sessionId: string;
  topic: string;
  createdAt: string;
  status: string;
  updatedAt: string;
};

function listSummaries(projectRoot: string): DiscussSummaryDto[] {
  return readDiscovery(projectRoot).sessions.map(toSummaryDto);
}
```

Wrong:
```ts
function listSummaries(projectRoot: string): DiscussSummaryDto[] {
  return listRecoveryCandidates(projectRoot)
    .map((session) => load(session.sessionId))
    .filter(Boolean)
    .map((snapshot) => buildDiscussSummary(snapshot, 'persisted'));
}
```
