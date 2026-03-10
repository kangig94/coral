# Execution Wait Stream Needs Pool Provenance For Queued Jobs
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
If execution admission is split across multiple pools, `ExecutionService` must retain `jobId -> pool` provenance until the job leaves the launch lifecycle so `waitStream()` can compute queued metadata against the correct pool.
## Why
`requestLaunch(jobId, provider, 'discuss')` only fixes admission. `waitStream()` later rebuilds queued events from live queue state with `queuePosition()` and `getActiveJobIds()`. If it falls back to the default pool, queued discuss jobs report `queuePosition: 0` or the wrong `runningJobIds`, which makes queued launch monitoring incoherent even though admission itself succeeded.
## Pattern
Right:
```ts
jobPools.set(jobId, pool);

yield {
  type: 'queued',
  jobId,
  queuePosition: queuePosition(jobId, pool) ?? 0,
  runningJobIds: getActiveJobIds(pool),
};
```

Wrong:
```ts
requestLaunch(jobId, providerName, 'discuss');

yield {
  type: 'queued',
  jobId,
  queuePosition: queuePosition(jobId) ?? 0,
  runningJobIds: getActiveJobIds(),
};
```
