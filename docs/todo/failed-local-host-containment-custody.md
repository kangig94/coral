# Failed local host containment needs durable cleanup custody

**Status**: open. Filed 2026-11-15. Local turn settlement transfers exhausted observation to the host manager; failed containment still has no automatic successor beyond that manager's lifetime.

## Invariant

An unresolved provider turn and its retained lease must have an accepted owner until exact terminal evidence or confirmed containment discharges them. Failed containment must transfer to durable live-host cleanup custody with recovery and an automatic retry disposition. Unknown process identity cannot authorize a signal or release. Principle 12 excludes an operator-abandonment exit: no operator is present to make that decision, and an LLM running a printed remedy cannot supply the missing authority.

## Members

- `DefaultProviderHostManager.closeWithReclamationRetries` in `src/coordinator/live/provider-hosts/index.ts` bounds automatic containment attempts to three. `isRetryableReclamationFailure` stops immediately on `process_identity_unverified`.
- `DefaultProviderHostManager.closeProviderServerEntry` in `src/coordinator/live/provider-hosts/index.ts` retains a `reclamation-failed` closing record on failure and removes its pending close operation. `acceptTurnContainment` retains the exact settlement capability and managed lease; `listProviderHosts` includes the retained turn identity in the existing host-keyed failure message. These records are process-local status, not crash-durable custody.
- `DefaultProviderHostManager.retainProviderServerSpawnCleanup` in `src/coordinator/live/provider-hosts/index.ts` accepts failed acquisition cleanup, retries indefinitely, and permits accepted operator abandonment. It supplies neither a bounded automatic remainder disposition nor durable custody of a live turn and lease.
- `releaseCodexThread` in `src/providers/codex/thread-release.ts` retires connection-local thread ownership after refused or unanswered unsubscribe. Calling it is not evidence of turn cessation; local settlement must already have exact terminal evidence or confirmed containment before closing its capability.

The current containment-failure path is deliberately retained. Changing its retry policy, adding persistence, or introducing a new abandonment authority is outside the staged fix. This work is adjacent to [coordinator process disposition](./coordinator-process-disposition.md) and [local stream inactivity](./local-app-server-stream-has-no-inactivity-bound.md): the first concerns recovery completion, the second a stream that never emits an outcome. Neither supplies custody for a completed local job whose host cannot be contained. They can ship independently.

## To do

1. Define a durable cleanup record for the exact host containment identity, thread/turn obligation, and accepted cleanup owner. Preserve additive, unknown-key-tolerant records under principle 10, using a new address generation where an existing reader cannot safely consume them.
2. Publish and verify successor acceptance before the local owner releases custody. A transport closing or a cleanup promise settling must not stand in for containment absence.
3. Recover outstanding cleanup after coordinator loss, observe or contain only the recorded subject, and define the automatic disposition when a bounded attempt remains inconclusive. Specify what ends every hold and who accepts the remainder when each bound expires.
4. Keep the already-recorded job outcome independent of cleanup. Test crash cuts around publication, acceptance, containment confirmation, and retirement, plus identity-unobservable failures and shared-host siblings.
5. Evaluate alternatives before choosing the durable design:
   - Escalate through coordinator shutdown to an independently accepted custodian. This can end local ownership without indefinite retention, but broadens the blast radius to unrelated jobs and requires proof that the custodian accepted the exact remainder. Coordinator exit alone is insufficient.
   - Require proxy placement for Codex. This reuses the independent proxy containment owner, but removes local fallback and reduces availability when proxy acquisition cannot succeed.

Start with the durable record and successor acceptance contract, including a reachable automatic disposition for unobservable containment. A new retry loop alone does not close this entry.
