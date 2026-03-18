# Discuss Launch Recovery Needs Caller-Owned Execution Identifiers
Promoted: 2026-03-11 | Updated: 2026-03-11
## Rule
If discuss recovery must reason about an execution launch before the provider finishes, discuss needs caller-owned execution identifiers. Persist the discuss-side launch marker first, then call `ExecutionService.start()` or `resume()` with the same `sessionId` and `jobId`; do not wait for the execution layer to mint ids and hope the discuss log records them before a crash.
## Why
`ExecutionService` persists job/session state before control returns to `DiscussManager`. A crash in that window leaves a real execution job that discuss never recorded, so restart cannot tell whether it should reattach, fail, or relaunch. Caller-owned identifiers turn that blind gap into a reconciliable state.
## Pattern
Right:
```ts
const jobId = randomUUID();
const executionSessionId = randomUUID();
appendDiscussEvents([{ kind: 'agent.run.bound', executionSessionId }, { kind: 'agent.job.started', jobId }]);
await executionService.start(provider, { sessionId: executionSessionId, jobId, ...input }, ctx);
```

Wrong:
```ts
const launch = await executionService.start(provider, input, ctx);
appendDiscussEvents([{ kind: 'agent.job.started', jobId: launch.job }]);
```
