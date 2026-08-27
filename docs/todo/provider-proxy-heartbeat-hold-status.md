# TODO — project live provider-proxy heartbeat holds into operator status

**Status**: open. The lifecycle retains separate silence and answered-but-unusable holds. Any answer ends the
exact role-and-method silence window: `unclassified` preserves and advances answered-but-unusable evidence,
while an accepted echo or current-tenancy challenge resynchronization clears both holds. Silence may end in the
coordinator's bounded `heartbeat_hold_exhausted` stop-and-reap decision. Answered-but-unusable may only end in
`heartbeat_answer_unusable_hold_exhausted`, which reports release to the roles' autonomous deadline owner
without reaping. `heartbeat_protocol_incompatible` takes that release immediately without opening a hold. The
state and release are coordinator-local and no existing command reads them; this entry remains about the durable
read path.

## What exists

`ProviderProxySetLifecycle` keys each live set by its exact `ProviderProxySetIdentity` and keeps active
preservation episodes in the established slot. Lifecycle logs carry the set reference, role, method, reason,
and recovery transition. They are an event history, not a current-status read: `snapshot()` is test-only, and
`coral-cli backend status` has no projection of the lifecycle's active holds.

## What is missing

Principle 11 requires a refusal or hold to remain readable as current status under the identity an operator can
act on. Satisfying that requires a persisted owner, not another log field. The projection must be keyed by the
complete provider-proxy set identity and publish each active hold's disposition, role, method, incident reason,
attempts, elapsed span, scheduler lateness, and set-derived bound. It must remove the silence entry after any
answer, both entries after an accepted echo or current-tenancy resynchronization, and all entries after a terminal
lifecycle transition. It must also publish the non-reaping release decision,
its distinct reason, and `guardian-and-reaper` successor owner so an operator can tell a released answering set
from a reaped silent one.

The reader should be an existing command. The default candidate is `coral-cli backend status`, because it
already composes coordinator availability with durable local status; `backend provider-host inspect` is keyed
by a host rather than a proxy set and cannot represent more than one set without changing its subject.

## What a fix must decide

- Which durable store owns live set status across coordinator death and restart.
- How a new coordinator distinguishes a stale hold left by its predecessor from a currently represented set.
- Whether recovered episodes remain bounded history or disappear from the current projection.
- How `backend status` renders multiple held roles and non-reaping releases without losing the exact set
  identity needed for shutdown or support action.

## Start condition

Choose the durable owner and stale-record rule together. Do not add a CLI field backed only by the current
process's memory: the status command must remain useful when that process is the thing that is starved or gone.
