# Discuss Startup Recovery Needs Durable Project-Root Enumeration
Promoted: 2026-03-11 | Updated: 2026-03-14
## Rule
If discuss recovery is scoped per project root, assign explicit startup ownership for enumerating project roots and invoking that recovery (attach-only) before the backend starts idle shutdown checks. The enumeration must come from a durable home-scoped registry. Per-project `discovery.json` alone is not enough. `recoverPersistedSessions()` must only attach sessions to memory — it must NOT call `continueLoop`. Execution resumes only when the user re-engages via `discuss_participate`.
## Why
Without a startup coordinator, persisted discuss sessions remain inert after restart until some later request happens to touch the matching project root. Without a durable global root source, discuss-only roots are invisible. If `recoverPersistedSessions` calls `continueLoop`, it blocks `listen()` and `writeBackendInfo()` — if any session has `controlPhase: 'synthesize'` and providers aren't registered yet, the loop spins at 100% CPU and the backend never starts.
## Pattern
Right:
```ts
registerBuiltInProviders();        // must come before recovery
await recoverOrphanedJobs();
await listen(server, host);        // recovery runs AFTER listen()
writeBackendInfo(...);
for (const projectRoot of readDiscussProjectRoots()) {
  const manager = discussRegistry.getOrCreate(projectRoot, ...);
  await manager.recoverPersistedSessions(ctx); // attach only; no continueLoop
}
idleTimer.startWatching(isIdle, shutdown);
```

Wrong:
```ts
// Before listen() — blocks startup if continueLoop hangs
for (const projectRoot of readDiscussProjectRoots()) {
  await manager.recoverPersistedSessions(ctx); // called continueLoop internally
}
await listen(server, host);  // never reached if recovery hangs
```
