# Execution Job Index Requires Cold-Start Hydration
Promoted: 2026-03-15 | Updated: 2026-03-15
## Rule
Do not replace `readJobIds()` with an in-memory job set unless the new owner also defines cold-start hydration or a durable discovery source. Runtime indexing alone is insufficient because orphan recovery and shutdown sweeps need the full job inventory before any new writes occur.
## Why
In Coral, job enumeration is not just a list endpoint concern. Startup recovery uses it to find live jobs, scope them by backend namespace, and rewrite legacy records that are missing `backendNamespace`. A cache that only learns about jobs through `initJob()` misses all pre-existing jobs after restart and breaks recovery exactly when the persistent inventory matters most.
## Pattern
Right:
```ts
class ProgressStore {
  private readonly knownJobIds = new Set<string>();

  hydrateJobIndexFromDiskOnce() {
    for (const jobId of scanJobsDir()) this.knownJobIds.add(jobId);
  }

  listKnownJobs(): string[] {
    return [...this.knownJobIds];
  }
}
```

Wrong:
```ts
class ProgressStore {
  private readonly knownJobIds = new Set<string>();

  initJob(jobId, ...) {
    this.knownJobIds.add(jobId);
  }
  // restart => empty set => orphan recovery sees nothing
}
```
