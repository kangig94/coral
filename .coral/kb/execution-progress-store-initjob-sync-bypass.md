# ProgressStore Async Status Writes Still Require Sync initJob Persistence
## Rule
If `ProgressStore.writeStatus()` is changed to cache-first async persistence for non-terminal phases, `initJob()` must not keep delegating to it. The initial `launching` or `queued` status is part of crash recovery provenance, so job creation needs its own synchronous status write while still sharing the same cache/live-count update logic and write-generation tracking.
## Why
The non-terminal async path is acceptable for phase churn because same-process reads come from `statusCache`, but job creation is different: if the process dies immediately after `initJob()`, recovery needs the initial `status.json` on disk. Reusing the async non-terminal path would make brand-new jobs invisible to restart/orphan recovery in exactly the window where persistence matters most.
## Pattern
Right:
```typescript
initJob(jobId, ...) {
  const record = buildInitialStatus(...);
  nextWriteGeneration(jobId);
  persistStatusSync(jobId, record);
  applyStatusRecord(jobId, record);
}
```

Wrong:
```typescript
initJob(jobId, ...) {
  const record = buildInitialStatus(...);
  writeStatus(jobId, record); // now async for launching/queued
}
```
