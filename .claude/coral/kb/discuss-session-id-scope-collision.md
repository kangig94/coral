# Discuss Session IDs Are Project-Scoped, Not Global
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
Local discuss `sessionId` values are only unique within a `(projectRoot)` scope, not globally. `SessionStore.createSessionDir()` generates `<date>-<rand4>` IDs under each project's `.claude/coral/discuss/` directory. Any system that aggregates discuss sessions across multiple backends or projects must derive a collision-free composite key from `(connectionId, projectRoot, originSessionId)` rather than using the raw origin ID as the primary key.
## Why
Two different projects (or two remote backends) can independently generate the same `240310-0402-ab3f` session ID. If reef stores these with the raw ID as primary key, one overwrites the other. The API also can't route `GET /api/discuss/detail?sessionId=X` unambiguously without the project context.
## Pattern
```typescript
// Wrong: use raw origin ID as reef primary key
insertDiscuss.run(originSessionId, ...); // collision across projects

// Right: derive composite reef ID
function toDiscussReefId(connectionId: string, projectRoot: string, originId: string): string {
  return `${connectionId}:${projectKey(projectRoot)}:${originId}`;
}
insertDiscuss.run(toDiscussReefId(connId, projectRoot, originId), ...);
```
