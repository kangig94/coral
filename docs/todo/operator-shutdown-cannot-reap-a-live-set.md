# TODO — the operator's shutdown hands a wedged proxy set forward instead of ending it

**Status**: open. Found while writing the heartbeat hold's exits, where `coral-cli backend shutdown` was
named as one of them and turned out not to be.

## What is observed

Both routes into shutdown hard-code the same reason. `src/transport/http/handler.ts`'s `/admin/shutdown`
sets `const reason = 'replaced'`, and `src/transport/ipc/server.ts` does the same for the IPC path.
`shutdownModeFromReason` (`src/coordinator/shutdown.ts`) maps `replaced` and `sigterm` to `handoff`, and
`reapProviderProxySets` is reached only inside the `mode === 'hard'` branch. Handoff runs
`releaseHandoffAuthority` instead, which stops heartbeats and closes control **so the set survives for a
successor to redeem**.

Hard mode is real but no command reaches it: it comes from `sigint` or an internal lifecycle fatal.

## Why this is a defect

The command is the last exit named for several holds. An operator with a wedged provider-proxy set runs
`backend shutdown`, the coordinator hands off, the next coordinator redeems the same set, and the wedge
comes back — while the command's own output ("Backend shutdown initiated") is honest but says nothing about
the set. The operator has done the documented thing and the state is unchanged.

Preserving sets across a handoff is right for the case handoff exists for — a coordinator being replaced by
a newer build, whose provider work should not be killed for the upgrade. The defect is that one reason
serves both situations, so the operator cannot say which one this is.

## What a fix must not do

- It must not make `backend shutdown` reap by default. A routine restart that killed live provider work
  would be a worse failure than the one this entry describes, and handoff-preserves-work is load-bearing for
  upgrades.
- It must not reap on the operator's word alone. `stop-and-reap` on a claim-bearing set requires a
  containment-qualified terminal fault (`.claude/rules/validation.md`), and an operator asking is not an
  observation. Whatever route is added has to reach containment's dual-evidence path rather than around it.
- It must not infer the operator's intent from the state of the sets. "There is a wedged set, so they must
  have meant hard" is the same silence-reading this directory's neighbours exist to remove.

## Start condition

Decide what the operator is actually asking for, and give that its own reason rather than overloading
`replaced`. The likely shape is a second, explicit request — a flag on `backend shutdown`, or a separate
operation — that names the sets it will contain and reports what it observed about each, so the answer is a
decision the operator made with evidence rather than a mode they fell into. `docs/cli-errors.md` already
documents this command's exit codes in detail; a new route owes the same treatment, including what a refusal
means for whether it is safe to proceed.
