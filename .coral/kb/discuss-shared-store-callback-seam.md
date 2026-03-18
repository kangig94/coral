# Discuss Server Must Share One Store Instance Across Manager and API Paths
Promoted: 2026-03-11 | Updated: 2026-03-11
## Rule
If the backend relies on `DiscussSessionStore` callbacks or committed-store reads for discuss invalidation, `createBackendServer()` must pass the same cached store instance into `DiscussManagerRegistry.getOrCreate()`. Do not let the server API cache one store while the manager silently constructs another store for the same project root.
## Why
Two store objects pointed at the same filesystem look harmless because persistence still works, but callback-driven behavior drifts immediately. `discuss:updated` emissions, commit observers, and any future store-owned hooks only fire on the manager's store, while API detail reads may go through a different store object. That breaks the intended "commit once, emit once, read the same committed snapshot" seam.
## Pattern
```ts
// Wrong: manager gets its own implicit store instance.
const store = getDiscussStore(projectRoot);
return registry.getOrCreate(projectRoot, service);
```

```ts
// Right: server and manager share the same store authority path.
const store = getDiscussStore(projectRoot);
return registry.getOrCreate(projectRoot, service, store);
```
