# AbortRegistry Migration Needs Terminal-Phase Guards On Late Callbacks
## Rule
When execution state authority moves from an in-memory job registry to `ProgressStore`, provider callbacks must check persisted phase before changing launch or running state. Late `onEvent` or post-execute code may still run after a terminal write, so `launch.state` alone is not a safe gate for calling `markJobRunning()` or `markJobReady()`.
## Why
The old in-memory registry implicitly blocked post-terminal state changes because terminal handlers removed the job entry before later callbacks could read mutable launch state. After migrating to a minimal abort registry, persisted status remains readable after terminal writes, so a callback that only checks `launch.state !== 'ready'` can resurrect an `error` or `aborted` job back to `running` or `ready`.
## Pattern
Right:
```typescript
const status = progressStore.readStatus(jobId);
if (
  status
  && status.phase !== 'completed'
  && status.phase !== 'error'
  && status.phase !== 'aborted'
  && status.launch.state !== 'ready'
) {
  markJobRunning(jobId);
}
```

Wrong:
```typescript
const status = progressStore.readStatus(jobId);
if (status && status.launch.state !== 'ready') {
  markJobRunning(jobId);
}
```
