# Execution Refactors Must Follow Authority Boundaries
Promoted: 2026-03-15 | Updated: 2026-03-15
## Rule
When decomposing execution-layer managers or replacing disk scans with caches, split by authority boundary rather than by current file bulk. Runtime registries and per-instance caches only own attached local state; list and discovery endpoints need separate server-owned indexes that cover untouched shards, detached sessions, and persisted summaries. If a manager class is removed, replace it with an operation-level public surface that preserves the original behavioral contracts before exposing lower-level helpers.
## Why
These refactors often look like simple code motion, so it is easy to treat a local cache as if it were process-wide authority or to wire handlers directly to persistence/registry helpers. That loses real behavior in two directions at once: `/api/sessions` and `/api/discuss` silently become incomplete because they no longer see persisted state outside the active runtime objects, and discuss handlers drop multi-step semantics such as create-persist-attach-initial-bids-resume or commit-abort-detach ordering.
## Pattern
Right:
```ts
const sessionIndex = hydrateSessionIndex();
const discussOps = createDiscussOperations(ctx);

listSessions(namespace) {
  return sessionIndex.list(namespace);
}

discuss_start(args, ctx) {
  return discussOps.start(args, ctx); // composes create + persist + attach + initial bids + resume
}
```

Wrong:
```ts
listSessions() {
  return sessionManager.list(provider); // only one shard / one instance
}

discuss_start(args, ctx) {
  attachSession(ctx, snapshot);
  resumeLoop(ctx, sessionId); // skips create/persist/watch/bid semantics
}
```
