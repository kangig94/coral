# Workflow Wait Artifact Path Must Flow Through the Terminal Event
## Rule
When the bridge needs workflow artifact data, do not reconstruct the `result.md` path locally and do not treat `event.result.content` as the workflow artifact text. The backend-side wait stream should attach the already-resolved `resultPath` to each terminal event, and the bridge should use that payload directly when shaping `wait()` responses: `result.path` is always present, and `result.content` is optional workflow artifact text loaded from `resultPath`.
## Why
Recomputing the path in the bridge couples the proxy to backend storage layout and creates a second source of truth for recovered jobs. Reusing `event.result.content` is also wrong for successful workflows: that field carries `finalOutput`, while the artifact file contains serialized step markdown. Passing `resultPath` through the terminal event keeps the boundary clean: the backend owns artifact location, the bridge owns response shaping, and workflow terminals from normal execution and orphan recovery expose one source of truth for both path-first `result.path` responses and optional embedded artifact reads.
## Pattern
```typescript
// Wrong: bridge rebuilds paths and reuses workflow finalOutput as artifact text
const { content: _ignoredContent, ...resultMeta } = event.result;
const result = {
  ...resultMeta,
  path: `/tmp/coral-jobs/${event.completedJobId}/result.md`,
  content: event.result.content,
};
```

```typescript
// Right: backend emits resultPath, bridge always returns path and only embeds readable workflow text
yield {
  type: 'terminal',
  completedJobId: jobId,
  sessionId,
  remainingJobIds,
  resultPath: jobResultPath(jobId),
  result,
};

const { content: _ignoredContent, ...resultMeta } = event.result;
const pathFirstResult = {
  ...resultMeta,
  path: event.resultPath,
};

let workflowText: string | undefined;
try {
  workflowText = readFileSync(event.resultPath, 'utf-8');
} catch {
  // path-only fallback
}

const result = workflowText === undefined
  ? pathFirstResult
  : { ...pathFirstResult, content: workflowText };
```
