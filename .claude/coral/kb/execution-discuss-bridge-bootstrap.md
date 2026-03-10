# Discuss SSE Requires Explicit Bridge Registration Per Project Root
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
The execution server's `/events/stream` loop only emits discuss events from already-registered `DiscussBridge` instances, so every path that discovers a usable `projectRoot` must call `getDiscussBridge(projectRoot)` before expecting live discuss events for that root. Seed bridges from known session inventory when the stream opens, and register new roots again on `session:updated` or `job:created`; propagating `projectRoot` alone is not enough.
## Why
`startDiscussPoll()` only rescans bridges that already exist in the in-memory map. If bridge creation happens only on `job:created`, then persisted discuss events under an existing project root remain invisible to SSE clients until some unrelated new job is created for that root. This makes the end-to-end discuss pipeline look wired on paper while live delivery still fails.
## Pattern
Right:
```typescript
function seedDiscussBridgesForKnownRoots(): void {
  for (const root of listKnownProjectRoots()) {
    getDiscussBridge(root);
  }
}

async function handleEventStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  seedDiscussBridgesForKnownRoots();
  streamResponses.add(res);
  startDiscussPoll();
}

const onSessionUpdated = (payload: EventBusEvents['session:updated']) => {
  if (payload.projectRoot) getDiscussBridge(payload.projectRoot);
  writeSseEvent(res, 'session:updated', payload);
};
```

Wrong:
```typescript
async function handleEventStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  streamResponses.add(res);
  startDiscussPoll();
}

const onSessionUpdated = (payload: EventBusEvents['session:updated']) => {
  writeSseEvent(res, 'session:updated', payload);
};
```
