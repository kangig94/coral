# Job Registry: activeJobs Map and tryClaimTerminalWrite CAS

## Rule
The active job registry (`activeJobs: Map<string, JobEntry>`) is keyed by UUID job_id. Terminal state transitions (running → completed/error) are guarded by an in-memory compare-and-set via `tryClaimTerminalWrite(jobId, targetState)` — only the first caller to claim the terminal state writes to disk. Abort by `job_id` does a direct `activeJobs.get(jobId)` lookup; abort by `session` scans all entries for matching `.session` field (best-effort, may miss jobs still initializing). Abort by session name may match multiple entries — all are aborted.

## Why
Without `tryClaimTerminalWrite`: a job could be written as "completed" by the executor callback and simultaneously as "error" by the shutdown handler — resulting in corrupted `status.json`. Without job_id-based abort: aborting by session name has a race where the session name may not be known yet for in-flight new sessions. Job_id is known from exec response time, making deterministic cancellation possible.

## Pattern
```typescript
// tryClaimTerminalWrite: in-memory CAS (server-handlers.ts)
export function tryClaimTerminalWrite(jobId: string, state: 'completed' | 'error'): boolean {
  const entry = activeJobs.get(jobId);
  if (!entry || entry.terminalState !== undefined) return false;
  entry.terminalState = state;
  return true;
}

// Abort by job_id (direct lookup — O(1)):
const entry = activeJobs.get(job_id);
entry?.controller.abort();

// Abort by session (scan — O(n), best-effort):
for (const [jobId, entry] of activeJobs) {
  if (entry.session === session || entry.session_name === session) {
    entry.controller.abort();
    matched.push(jobId);
  }
}
```
