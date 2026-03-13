# Backend Namespace Isolation Needs Durable Runtime Ownership Filtering
Promoted: 2026-03-14 | Updated: 2026-03-14
## Rule
If backend discovery becomes installation-scoped but live execution records stay in shared global storage, persist the owning backend namespace in durable job status and make startup/shutdown recovery filter strictly by that namespace. Namespacing only `backend.json` and `backend.lock` is not enough, because recovery paths still operate over every live job visible in the shared store.
## Why
Without durable runtime ownership metadata, a second installation can start cleanly from its own namespaced discovery files and still mark another installation's live jobs as orphaned or failed. The bug hides behind apparently correct lock/info isolation because the cross-install corruption happens later, when recovery or shutdown sweeps the global job store.
## Pattern
Right:
```ts
type PersistedStatusRecord = {
  jobId: string;
  sessionId: string;
  projectRoot: string;
  backendNamespace: string;
  phase: JobPhase;
};

function listLiveJobs(progressStore: ProgressStore, namespace: string): PersistedStatusRecord[] {
  return readJobIds()
    .map((jobId) => progressStore.readStatus(jobId))
    .filter((status): status is PersistedStatusRecord =>
      status !== null
      && status.backendNamespace === namespace
      && (status.phase === 'queued' || status.phase === 'launching' || status.phase === 'running'));
}
```

Wrong:
```ts
// backend.json and backend.lock are namespaced, but recovery still sweeps every live job.
function listLiveJobs(progressStore: ProgressStore): PersistedStatusRecord[] {
  return readJobIds()
    .map((jobId) => progressStore.readStatus(jobId))
    .filter((status): status is PersistedStatusRecord =>
      status !== null
      && (status.phase === 'queued' || status.phase === 'launching' || status.phase === 'running'));
}
```
