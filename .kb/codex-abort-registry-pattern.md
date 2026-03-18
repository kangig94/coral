# Session Registry: activeJobs Map and tryClaimTerminalWrite CAS

## Rule
The active execution registry (`activeJobs: Map<string, JobEntry>`) is keyed by coral session UUID (the `session` returned by exec/fork). Terminal state transitions are guarded by `tryClaimTerminalWrite(id, targetState)` so only one writer persists final status. Abort is UUID-based only: `abort({ session })` performs a direct `activeJobs.get(session)` lookup and aborts exactly one entry.

## Why
Without terminal CAS, completion and shutdown/error paths can race and write conflicting terminal states. Without UUID-keyed abort, cancellation depends on fuzzy matching (name/thread), which is nondeterministic and racy. UUID lookup is O(1) and deterministic from launch time.

## Pattern
```typescript
// CAS gate for terminal writes
export function tryClaimTerminalWrite(id: string, state: 'completed' | 'error'): boolean {
  const entry = activeJobs.get(id);
  if (!entry || entry.terminalState !== 'running') return false;
  entry.terminalState = 'terminalizing';
  return true;
}

// Abort by coral session UUID (direct lookup)
const entry = activeJobs.get(session);
if (!entry) return error('No active execution found');
entry.controller.abort();
```
