# Atomic Claim Rollback Must Clear ProgressStore State
Promoted: 2026-03-09 | Updated: 2026-03-09
## Rule
If the execution path initializes a job in `ProgressStore` before claiming the session atomically, rollback on claim failure must clear both the job directory on disk and the in-memory `ProgressStore` bookkeeping for that job. Deleting only the filesystem artifact leaves a cached live status behind and the service keeps counting a job that never successfully claimed its session.
## Why
`ProgressStore.initJob()` is not a pure filesystem helper. It writes `status.json`, seeds `progress.jsonl`, stores the status record in `statusCache`, and updates `liveCount`. After that point, a failed claim is not harmless cleanup. Without a real rollback primitive, later reads can observe a ghost live job that has no valid session ownership.
## Pattern
Right:
```typescript
progressStore.initJob(jobId, sessionId, provider, projectRoot, jobKind, initialPhase);

try {
  const claimed = await sessionManager.claimForJobAtomic(sessionId, jobId, expectedVersion);
  if (!claimed) throw new SessionClaimError();
} catch (error) {
  progressStore.rollbackJob(jobId);
  throw error;
}
```

Wrong:
```typescript
progressStore.initJob(jobId, sessionId, provider, projectRoot);

if (!(await sessionManager.claimForJobAtomic(sessionId, jobId, expectedVersion))) {
  rmSync(progressStore.jobDir(jobId), { recursive: true, force: true });
  return rejectLaunch('session_busy', message);
}
```
