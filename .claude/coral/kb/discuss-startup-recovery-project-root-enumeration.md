# Discuss Startup Recovery Needs Durable Project-Root Enumeration
Promoted: 2026-03-11 | Updated: 2026-03-11
## Rule
If discuss recovery is scoped per project root, assign explicit startup ownership for enumerating project roots and invoking that recovery before the backend starts idle shutdown checks, and make that enumeration come from a durable home-scoped registry or another explicit global source. Per-project `discovery.json` alone is not enough, because startup still needs a trustworthy way to discover which project roots may contain discuss data at all.
## Why
Without a startup coordinator, persisted discuss sessions remain inert after restart until some later request happens to touch the matching project root. Without a durable global root source, even a well-defined per-project recovery routine still misses discuss-only roots and pre-launch-crash sessions, because the current runtime only knows roots from live managers or persisted execution-session provenance. Both failures break restart guarantees for background bidding, follow-up, and synthesis work, and can let idle shutdown conclude that the backend is inactive even though durable discuss work still exists on disk.
## Pattern
Right:
```ts
await recoverOrphanedJobs();
for (const projectRoot of listKnownDiscussProjectRoots()) {
  const manager = discussRegistry.getOrCreate(projectRoot, getExecutionService({ projectRoot, pluginRoot }));
  await manager.recoverPersistedSessions();
}
idleTimer.startWatching(isIdle, shutdown);
```

Wrong:
```ts
await recoverOrphanedJobs();
idleTimer.startWatching(isIdle, shutdown);

function getDiscussManager(ctx: CallerContext) {
  return discussRegistry.getOrCreate(ctx.projectRoot, getExecutionService(ctx));
}
// Recovery only happens if a later request touches that project root,
// and discuss-only roots are invisible unless some other subsystem already knows them.
```
