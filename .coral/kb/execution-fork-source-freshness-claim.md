# Fork Freshness Needs a Short-Lived Source Claim
Promoted: 2026-03-09 | Updated: 2026-03-09
## Rule
When `fork()` validates a source session before provider preflight, carry that preflight `version` into a short-lived `claimForJobAtomic()` on the source session before allocating the new fork session. Hold the source claim only until the new session is admitted, then release it immediately. That makes concurrent forks resolve as one winner and one `session_busy` loser without turning the source into a second long-lived owner of the fork job.
## Why
An `activeJobId` re-read after preflight only catches sources that are still busy at that exact instant. If another caller claims and releases the source during the preflight window, or if two forks race from the same preflight snapshot, both callers can otherwise proceed because the fork job runs on a fresh session. The temporary source claim converts the stale preflight snapshot into an atomic freshness check while keeping recovery and terminal ownership unchanged.
## Pattern
```typescript
// Right: serialize the fork window with a temporary source claim.
const sourceVersion = sourceSession.version;
await runProviderPreflight(provider);

const latestSourceSession = sessionManager.get(providerName, sourceSession.sessionId);
if (!latestSourceSession || latestSourceSession.activeJobId) {
  return rejectLaunch('session_busy', busyMessage);
}

const sourceClaimId = randomUUID();
await sessionManager.claimForJobAtomic(sourceSession.sessionId, sourceClaimId, sourceVersion);
try {
  const newSession = sessionManager.allocate(providerName, name, model, cwd);
  const admitted = await claimAndAdmitJob(newSession, providerName, projectRoot, busyMessage);
  return launchProviderJob(provider, newSession.sessionId, admitted.jobId, request, admitted.admission);
} finally {
  sessionManager.releaseJob(sourceSession.sessionId, sourceClaimId);
}
```

```typescript
// Wrong: re-read busy state but never convert the stale snapshot into a claim.
const sourceSession = sessionManager.get(providerName, input.sessionId);
await runProviderPreflight(provider);

const latestSourceSession = sessionManager.get(providerName, input.sessionId);
if (latestSourceSession?.activeJobId) {
  return rejectLaunch('session_busy', busyMessage);
}

const newSession = sessionManager.allocate(providerName, name, model, cwd);
// Two concurrent forks from the same source can both get here.
```
