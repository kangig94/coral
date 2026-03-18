# Discuss Live State Needs A Process-Wide Owner
Promoted: 2026-03-15 | Updated: 2026-03-15
## Rule
If a stateful discuss manager is decomposed into exported operations and smaller modules, keep an explicit process-wide owner for per-project live discuss contexts. Server startup recovery, live-detail authority, and idle shutdown all need one iterable surface for attached sessions across requests; per-project live maps alone are not enough.
## Why
Removing the old manager façade can make the refactor look purely local, but the server still depends on process-wide continuity. Without a shared context registry, each request recreates partial live state, `/api/discuss` loses a stable notion of "live", and idle shutdown checks no longer know whether any attached discuss session exists.
## Pattern
Right:
```ts
const contextRegistry = createDiscussContextRegistry();

function getDiscussContext(projectRoot: string): DiscussContext {
  return contextRegistry.getOrCreate(projectRoot, service, store);
}

idleTimer.startWatching(() => !contextRegistry.hasLiveSessions(), shutdown);
```

Wrong:
```ts
function getDiscussContext(projectRoot: string): DiscussContext {
  return createDiscussContext(projectRoot, service, store); // rebuilt every call
}

idleTimer.startWatching(() => true, shutdown); // no global live-state view
```
