# Codex Preflight Cache Test Isolation
## Rule
When a provider adapter caches preflight state in a module-level variable, adapter tests must reload the module with `vi.resetModules()` between cases. Clearing mocks is not enough because the cached validated CLI survives across calls to `execute()` until the module itself is re-imported.
## Why
Without a module reset, one test can leave a populated preflight cache behind and make later tests pass even if they never exercised `preflight()` for that case. That hides ownership bugs exactly where the adapter is supposed to enforce the handoff from preflight to execute.
## Pattern
Right:
```typescript
beforeEach(() => {
  vi.clearAllMocks();
});

async function loadProvider() {
  vi.resetModules();
  return import('../adapter.js');
}
```

Wrong:
```typescript
beforeEach(() => {
  vi.clearAllMocks();
});

// Reuses the same imported adapter module with stale module-level cache.
await codexProvider.execute(request, runtime);
```
