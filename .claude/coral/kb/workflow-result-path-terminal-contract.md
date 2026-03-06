# Workflow Wait Path Must Flow Through the Terminal Event
## Rule
When the bridge needs the workflow `result.md` path, do not reconstruct it by importing backend persistence helpers into the bridge. The backend-side wait stream should attach the already-resolved `resultPath` to each terminal event, and the bridge should use that payload directly when shaping `wait()` responses.
## Why
Recomputing the path in the bridge couples the proxy to backend storage layout and creates a second source of truth for recovered jobs. Passing `resultPath` through the terminal event keeps the boundary clean: the backend owns artifact location, the bridge owns response shaping, and workflow terminals from normal execution and orphan recovery both expose the same readable path contract.
## Pattern
```typescript
// Wrong: bridge rebuilds backend artifact paths locally
const result = parsed.include_result
  ? event.result
  : { ...resultMeta, path: `/tmp/coral-jobs/${event.completedJobId}/result.md` };
```

```typescript
// Right: backend emits resultPath, bridge only shapes the payload
yield {
  type: 'terminal',
  completedJobId: jobId,
  sessionId,
  remainingJobIds,
  resultPath: jobResultPath(jobId),
  result,
};

const result = event.result.workflow !== undefined
  ? { ...resultMeta, path: event.resultPath }
  : parsed.include_result
    ? event.result
    : { ...resultMeta, path: event.resultPath };
```
