# Discuss Recovery Must Relaunch Missing Or Failed Jobs Immediately
Promoted: 2026-03-11 | Updated: 2026-03-11
## Rule
When discuss recovery finds a persisted `currentJobId` whose execution status is missing or already terminal, append `agent.job.finished` with `recovery_missing` or `recovery_failed`, reload the latest snapshot, and relaunch the turn from the persisted execution session inside the same recovery path. Do not return a hard failure after recording the stale job result.
## Why
If recovery stops after marking the stale job finished, the surrounding bid or speech path interprets that as an execution failure. Healthy agents get soft-expelled or the control phase stalls even though the persisted `executionSessionId` is enough to resume safely.
## Pattern
```ts
// Right: clear stale job binding, reload, and relaunch.
await recordJobFinished(sessionId, agent, purpose, jobId, attempt, 'recovery_missing');
const refreshed = loadSnapshot(sessionId);
return launchFromExecutionSession(refreshed.runtime.agentRuns[agent]);
```

```ts
// Wrong: record stale job, then surface failure to the bidding loop.
await recordJobFinished(sessionId, agent, purpose, jobId, attempt, 'recovery_missing');
return { ok: false, consumedAttempt: true };
```
