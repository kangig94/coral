# Execution ProgressStore Shared Instance Cache
## Rule
Do not justify an in-memory `ProgressStore` cache with "the backend is single-process" unless the backend process also has a single authoritative `ProgressStore` instance. If both the server and execution services construct their own stores, cache-backed reads such as `/health`, shutdown liveness checks, and job-state writes will drift unless the store instance or cache state is shared explicitly.
## Why
Process count and authority count are different constraints. In Coral, `createBackendServer()` owns liveness and shutdown decisions while `ExecutionService` owns most job-state writes. If each side keeps its own cached `ProgressStore`, the server can keep seeing a job as live after the service has completed it, or miss queued/running work entirely, which corrupts `activeJobs`, idle shutdown, and orphan/error recovery semantics.
## Pattern
```typescript
// Wrong: single process, multiple authoritative stores
const progressStore = new ProgressStore(); // server
const createExecutionService = (ctx) => new ExecutionService(ctx); // service creates another store internally
```

```typescript
// Right: single authoritative store per backend process
const progressStore = new ProgressStore();
const createExecutionService = (ctx) => new ExecutionService(ctx, progressStore);
```

This applies equally to tests: if a test creates a ProgressStore and writes job state,
it must pass that same instance to `createBackendServer({ progressStore })`. Otherwise
the server's internal store caches its own view of job state, and the test's `readStatus()`
returns stale cached values (e.g. `running` instead of `error` after orphan recovery).
