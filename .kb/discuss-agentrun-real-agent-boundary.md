# Discuss Agent Runs Must Stay Bound To Real Session Agents
Promoted: 2026-03-11 | Updated: 2026-03-11
## Rule
Persist `runtime.agentRuns` only for real discussion agents that already exist in `state.agents`. Helper identities such as `__evaluator__` or `__synthesis__` should recover via persisted `controlPhase` re-entry instead of durable `agentRuns`.
## Why
The persisted snapshot readers validate `runtime.agentRuns` against `state.agents`. If helper-only identities are written into durable runtime state, the snapshot contract widens silently and older readers reject the session on load.
## Pattern
```ts
// Right: real agents own durable runs, helper phases recover from controlPhase.
runtime.agentRuns.alpha = { provider: 'codex', executionSessionId: 'exec-1' };
runtime.controlPhase = 'evaluate_epoch';
```

```ts
// Wrong: helper-only identities become durable run owners.
runtime.agentRuns.__evaluator__ = { currentJobId: 'job-1' };
```
