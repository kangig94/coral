# Workflow Wait Artifact Path Must Flow Through the Terminal Event
## Rule
When the bridge needs workflow artifact data, do not reconstruct the `result.md` path locally and do not treat `event.result.content` as the workflow artifact text. The backend-side wait stream should attach the already-resolved `resultPath` to each terminal event, and the bridge should use that payload directly when shaping `wait()` responses: path mode returns `resultPath`, inline mode reads the file at `resultPath`.
## Why
Recomputing the path in the bridge couples the proxy to backend storage layout and creates a second source of truth for recovered jobs. Reusing `event.result.content` is also wrong for successful workflows: that field carries `finalOutput`, while the artifact file contains serialized step markdown. Passing `resultPath` through the terminal event keeps the boundary clean: the backend owns artifact location, the bridge owns response shaping, and workflow terminals from normal execution and orphan recovery expose one source of truth for both readable path mode and inline artifact reads.
## Pattern
```typescript
// Wrong: bridge rebuilds paths and reuses workflow finalOutput as artifact text
const result = parsed.inline
  ? { ...resultMeta, content: event.result.content }
  : { ...resultMeta, content: `/tmp/coral-jobs/${event.completedJobId}/result.md` };
```

```typescript
// Right: backend emits resultPath, bridge uses it for both path and inline workflow reads
yield {
  type: 'terminal',
  completedJobId: jobId,
  sessionId,
  remainingJobIds,
  resultPath: jobResultPath(jobId),
  result,
};

const isWorkflow = event.result.workflow !== undefined;
const { content: rawContent, ...resultMeta } = event.result;
const isWorkflow = event.result.workflow !== undefined;
const content = !parsed.inline
  ? event.resultPath
  : isWorkflow
    ? readFileSync(event.resultPath, 'utf-8')
    : rawContent;
const result = { ...resultMeta, content };
```
