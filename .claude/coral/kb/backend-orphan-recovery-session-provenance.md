# Backend Orphan Recovery Needs Session-Provenance Metadata
## Rule
If backend orphan recovery must clear `activeJobId` on persisted sessions, job status must persist enough provenance to find the correct project-scoped session shard. Storing only `sessionId` is insufficient when `SessionManager` namespaces session files by caller `projectRoot` (or an equivalent bucket key). Persist `projectRoot` directly unless the session layer gains an equally authoritative reverse lookup.
## Why
`recoverOrphanedJobs()` runs from `ProgressStore` state, not from an in-memory `SessionManager`. Without persisted session provenance, recovery can mark the job terminal but still fail to locate the session file that owns `activeJobId`, leaving the session permanently busy. This bug is easy to miss in single-project tests because the default shard happens to line up.
## Pattern
Right:
```typescript
type PersistedStatusRecord = {
  jobId: string;
  sessionId: string;
  projectRoot: string;
  phase: JobPhase;
  // ...
};

progressStore.initJob(jobId, sessionId, providerName, jobKind, initialPhase, ctx.projectRoot);

for (const status of listLiveJobs(progressStore)) {
  const sessions = new SessionManager(status.projectRoot);
  markJobAsError(progressStore, status, ORPHANED_JOB_NOTICE);
  sessions.releaseJob(status.sessionId, status.jobId);
}
```

Wrong:
```typescript
for (const status of listLiveJobs(progressStore)) {
  markJobAsError(progressStore, status, ORPHANED_JOB_NOTICE);
  defaultSessionManager.releaseJob(status.sessionId, status.jobId);
}
```
