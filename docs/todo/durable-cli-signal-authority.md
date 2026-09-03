# TODO — finish durable-CLI signal authority

**Status**: open. Durable launch and recovery-action termination now carry recorded process identities, but
the recovered-job abort registries still signal bare pids, and a refused durable-transport termination still
has no durable operator status.

## What is already closed

`gracefulKillByPid` in `src/infra/process-supervision.ts` requires the incarnation recorded with the pid. It
returns `signal-refused` before SIGTERM when that identity is missing, the running platform cannot use its
incarnation as signal authority, the fresh identity cannot be read, or the fresh identity does not match.
Before SIGKILL it reads the identity again and also requires a fresh `alive` observation.

`spawnDurableJobTransport` in `src/coordinator/live/durable-transport.ts` reads the incarnation through the
runtime process port immediately after durable launch, while the returned pid still names that launch. The
same identity is reported for persistence and supplied to every abort, idle-timeout, and coordinator-cleanup
termination request. A missing launch identity is not replaced with a pid-only record and does not authorize
a later signal.

`registerRunningRecovery` in `src/coordinator/services/recovery/actions.ts` supplies the incarnation from
`durable_cli_process.v1` to `gracefulKillByPid`. When termination cannot be authorized, recovery retains its
ownership and durable retryable disposition until adoption succeeds or absence is established.

## Remaining paths

Signals aimed at a pid that came out of a durable record, with no check that the pid still names the process
the record was written for. Note the two columns are different things and the difference matters:

| Module (what the invariant names)              | Signal paths inside it                                             |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| `src/coordinator/services/recovery/service.ts` | one direct `kill`, in the abort handler for an **adopted** job       |
| `src/jobs/reconcile/registry.ts`               | one direct `kill`, in the abort handler for a live job               |

`tests/invariants/signal-authority.test.ts` is a **module**-level scan, and a helper-delivered signal is
attributed to the helper's file rather than the caller's. That is why closing `recovery/actions.ts` removed no
ALLOWLIST entry: the behavior needed its own review and test. Treat the ALLOWLIST as a checklist of modules
and this table as the checklist of behaviours; neither is a substitute for the other.

The `recovery/service.ts` row is the sharpest. Adoption exists precisely because the record outlived the
process that wrote it, so its pid has already survived one process boundary before anyone signals it.

## Why this is a defect and not a nit

The identity **is recorded**. `durable_cli_process.v1` (`src/jobs/runtime-meta.ts`) carries an
`incarnation` beside the pid, and `observeProcessIdentity` already exists to compare one. The remaining sites
simply do not ask. That is a different situation from
[`darwin-signal-authority.md`](./darwin-signal-authority.md), where the evidence is too weak to use — here it
is sitting in the same record as the number being signalled.

The window is not narrow, either. An abort that can arrive at any time, and — for `service.ts` specifically —
a pid that already outlived one process boundary before adoption, are exactly the shapes where a child exits,
its pid is recycled, and the signal lands on a stranger.

## What is already true, and must not be re-derived

`durable_cli_process.v1` did **not** need a generation move when the incarnation replaced
`processStartedAtSeconds`, and this was checked rather than assumed:
`decodeDurableCliProcessRuntimeMeta` in v0.10.8 returns `null` on any decode failure, so a rolled-back build
reads the new shape as "no recorded identity" and answers `unknown`. That is Principle 10's second mechanism
working as intended. Do not "fix" it by renaming the key — the saga record needed that
(see the commit that moved `provider_operation_saga`) because _its_ shipped reader was strict.

## The shape of the fix

Each remaining abort path must supply the recorded incarnation to the signal boundary and preserve ownership
when the returned disposition refuses. Refusal cannot flow through an abort result whose success means the
process obligation was discharged.

The durable transport also needs durable refusal status keyed by the target identity. Its current warning is
useful diagnosis but is not operator-readable current state and does not name a supported retry or transfer
ownership.

## Cost on platforms without signal-authorizing incarnations

`incarnationMayAuthorizeSignal` currently authorizes only Linux. On every other platform,
`gracefulKillByPid` returns `platform-incarnation-cannot-authorize-signal` without sending SIGTERM or
scheduling SIGKILL. This is an intentional safety loss: abort, idle timeout, and coordinator cleanup cannot
kill a durable CLI process by pid because doing so could target a recycled pid.

The process therefore remains owned and may remain alive until it exits through another mechanism. An abort
can remain unsettled waiting for that exit, and repeated idle checks continue to refuse rather than converting
unknown identity into permission. Until the refusal is persisted as keyed status with an implemented exit,
the warning is the only visible report of that hold; this visibility gap remains open.

## Completion condition

This TODO is complete when the recovered-job abort paths no longer signal an unverified pid and every
`signal-refused` outcome that retains a durable process obligation is represented as durable status with a
reachable retry, decisive absence observation, operator action, or verified successor owner.
