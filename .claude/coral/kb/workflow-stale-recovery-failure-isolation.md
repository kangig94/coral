# Workflow Stale Recovery Failure Isolation
## Rule
When adding stale-atom recovery to `waitForAllAtoms`, model stale-triggered aborts as expected control-flow, not ordinary atom failures. Track sessions currently being recovered and exclude their transient `status: error` observations from `firstFailure`/sibling-abort escalation until recovery succeeds or definitively fails.
## Why
Without explicit isolation, stale recovery can self-trigger global failure logic: the intentional abort used to unstick a stale atom is observed as a terminal error and incorrectly trips sibling abort before resume completes. This creates false negatives where recovery-capable workflows fail immediately.
## Pattern
Right:
```text
expectedStaleAbortSessions.add(staleSession)
requestAbort(staleSession)
resume(staleSession)
if status.error for staleSession while in expected set: ignore for firstFailure
on successful resume: swap tracking to new session and clear expected set
on resume failure/retry exhaustion: throw explicit recovery error
```
Wrong:
```text
Treat every status.error as fatal in the shared loop,
including errors intentionally introduced by stale recovery aborts.
```
