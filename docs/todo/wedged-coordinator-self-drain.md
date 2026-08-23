# TODO — every way Coral ends a process runs on that process's own event loop

**Status**: open. **Observed 2026-08-23** — see "The observation" below. Originally recorded on
`refactor/process-incarnation-token` because it was noticed while reasoning about macOS containment, not
because anything failed. Its own start condition asked for exactly this before either half is built.

## What exists now

`IdleTimer` (`src/coordinator/live/idle.ts`) polls every 60s and drains after `DEFAULT_IDLE_TIMEOUT_MS`
(six hours) of no inflight work. It is the coordinator's only unattended exit.

It runs on the coordinator's own event loop, through `TimePort.setInterval`. So does the shutdown budget, so
does every finalizer it contains, and so does a proxy set's orphan deadline inside its own roles.

## Two failure modes, and an earlier revision of this document merged them

Both end with a daemon that will not retire, which is why they were written as one. They need different
answers, so they are separated here.

**Synchronous starvation — the loop stops turning.** A blocking call or a runaway synchronous stretch, and
nothing else runs: not the idle interval, not a timer, not a request handler. `/health` becomes _unanswerable_
rather than red, and POSIX `listen` accepts into the backlog without the process reading anything, so a CLI
connects successfully and then waits forever for a reply that will never be written. The failure presents as a
hang, which is the hardest shape to attribute.

**Stuck inflight work — the loop turns fine.** A never-settling `await` does **not** stop the event loop, and
saying it did was the error. Timers keep firing, other requests keep being served, and
`/health` keeps answering — operational routes return at `src/transport/http/handler.ts`, before
`deps.admin.beginRequest()`, so they are not even counted. What actually happens is narrower and
quieter: `beginRequest()` ran for the stuck request and `endRequest()` never will, so `inflight` never returns
to zero and `IdleTimer.tryDrain` declines forever. The daemon is healthy by every signal it publishes and will
simply never retire.

## The gap that both share

**Every self-termination path Coral has is scheduled by, or accounted to, the process it is meant to end.**
Nothing outside the daemon has an opinion about whether it should still be running. Under starvation the
schedule never runs; under stuck inflight work it runs and is told there is work.

This is why the idle timeout is not the safety net it looks like. It is a _tidiness_ mechanism for a healthy
daemon with nothing to do — and it was read as a liveness backstop during the Darwin containment discussion,
which is the misreading worth recording.

## Why this is neither of its neighbours

[`kb-daemon-independent-containment.md`](./kb-daemon-independent-containment.md) is the same sentence about a
different process, and it has an answer available: the KB daemon has a parent that supervises it, and the gap
is what happens when that parent dies. Here the wedged process **is** the top of the tree. No in-tree party
remains, so no in-tree fix exists.

[`provider-operation-shutdown-quiescence.md`](./provider-operation-shutdown-quiescence.md) assumes shutdown
runs. This entry is about it not running at all.

## The shape of the fix

**The real answer is external**: a launchd job (macOS) or a systemd user unit (Linux) with a watchdog that
restarts a daemon that stops checking in. That is not a code change — it is a decision about whether Coral may
install a service on a machine. Coral installs as a Claude Code plugin from a git subdir and has no installer
that could register one, so this is a product question before it is an engineering one.

**The smaller intermediate, and it addresses only the first mode**: a liveness file the coordinator touches
from an interval it already owns, and which the CLI stats before connecting. A stale mtime lets `coral-cli`
say "the daemon is starved, kill it" instead of hanging on a socket that was accepted and never served. It
does not recover anything — it converts an unattributable hang into a diagnosis, which is most of the cost.
It works precisely because a starved loop stops touching the file; the detector must be the reader, never the
writer.

**The second mode needs something else entirely**, because the file would keep being touched. What it needs is
inflight _age_: the oldest outstanding request's start time, published on health and bounded by a deadline, so
"one request has been inflight for six hours" is a reportable fact rather than an invisible reason retirement
never happens. That is a smaller and more tractable change than the supervisor, and it should probably go
first.

## The observation, 2026-08-23

Recorded as observation only. No fix is proposed here, deliberately — the shape of the fix above was written
before this was seen, and should be reconsidered against it rather than assumed still to fit.

**The wedge is real, and its cause is neither candidate this entry named.** Not synchronous JS work, not an
await that cannot settle: the kernel stops scheduling the thread. Measured on a live coordinator:

```
State:   D (disk sleep)
SigPnd:  0000000000000100     ← SIGKILL(9) pending, undelivered
wchan:   jbd2_log_wait_commit ← blocked in the ext4 journal commit
```

One instance held that state for about three minutes. A process in uninterruptible sleep does not run its
event loop and does not receive `SIGKILL`; `kill(2)` returns success and the signal is queued until the
process leaves `D`. No discipline about what runs on the loop avoids this, because the loop is not what
stopped — a single `fsync` did, on a machine where `/`, `/tmp`, `~/.coral`, and the repository share one
ext4 filesystem and therefore one journal, so one process's `fsync` waits on the whole filesystem's ordered
dirty data.

Reproduced repeatedly under concurrent provider jobs plus a test suite. It was frequent enough on this host
that `discard` was removed from the mount and `vm.dirty_bytes` was capped at 256 MB to shorten each commit;
that reduced the frequency and did not remove it.

**The consequence is not the one this entry predicted either.** This document is about a wedged daemon that
never retires. What was observed is the opposite blast radius: the wedge kills work that was fine.

```
fault=control-channel-fault  reason=provider_authority_lost
subject=reaper  liveClaims=2  error=The control channel closed.
```

A coordinator frozen past a deadline loses provider authority, and the reaper then executes `stop-and-reap`
on the whole proxy set, terminating every live claim on it. The jobs themselves were healthy; they were
deliberately killed by a policy acting on the wedge.

**Corrected 2026-08-24: the deadline that fires is not the lease.** This entry first named
`PROXY_CONTROL_LEASE_MS`, 12,000 ms. The log says otherwise — what breaks first is the heartbeat RPC's own
budget:

```
heartbeat echo failed for <set>: control.heartbeat.v1 exceeded its 5000ms budget
Provider proxy set action=stop-and-reap reason=provider_authority_lost fault=heartbeat-failed liveClaims=7
```

`PROXY_CONTROL_RPC_TIMEOUT_MS` is 5,000 ms, and the 12,000 ms lease is the next line of defence rather than
the one that kills jobs. That matters for anyone tempted to raise a number: the lease's own floor is
`2 × rpc + heartbeat` through `providerProxyDeadlineTimingIsValid` (`src/provider-proxy/orphan-deadline.ts`),
so the rpc budget is what
sets it, not the reverse.

One reaped set carried `liveClaims=7` — seven jobs ended together because one heartbeat missed its budget.

**The strongest evidence is Coral measuring its own stall.** The same window records:

```
Provider proxy lifecycle containment-attempt-deadline woke 3203ms after its requested time.
Provider proxy lifecycle containment-retry woke 1ms after its requested time.
```

A timer that asked to fire and woke three seconds late is the event loop not turning, observed from inside the
process rather than inferred from a `D` state outside it. The retry that woke 1 ms late immediately afterwards
shows the stall had passed. Two such episodes appear 25 minutes apart, each followed by reaped sets.

The evidence that the cause is shared rather than per-proxy: **two different proxy instances lost their
control channels two milliseconds apart** (12:22:02.609 and .611, with `liveClaims` 1 and 2). Two independent
crashes do not coincide that closely.

What is inferred rather than measured: no single death was proven by overlapping a `D`-state timestamp with
that channel-close timestamp. The simultaneity establishes a common cause on the coordinator side, and the
freeze is the only mechanism observed, but the 1:1 attribution for a specific death is not proven.

**What this adds to the record, beyond satisfying the start condition.** Lease expiry cannot distinguish a
coordinator that died from one that stalled. What was observed is "no renewal arrived within 12,000 ms"; what
was concluded is that authority was lost. Those are not the same, and the third answer — the question could
not be answered — has no representation at that site. Raising the constant does not reach it: a three-minute
stall exceeds any lease value, and the timing constants are a solved inequality system
(`providerProxyDeadlineTimingIsValid` in `src/provider-proxy/orphan-deadline.ts`) in which 12,000 ms is 1,000 ms
above the floor set by `2 × PROXY_CONTROL_RPC_TIMEOUT_MS + PROXY_CONTROL_HEARTBEAT_MS`, so moving it alone breaks
`leaseMs + successorTail < adoptionWindow`.

## Start condition

**Met.** The observation above is the reachable cause this asked for. What remains before building anything is
to decide which half the observed cause actually argues for, since it is a third cause neither half was
designed against. The original text follows.

**An observation, or a reachable cause.** This has never been seen in the field. Before building either half,
establish that a wedge is reachable at all — the candidates are synchronous work on the loop and an await that
cannot settle. One concrete instance of the first already exists: `probeMacProcessIncarnation`
(`src/infra/node-process.ts`) runs two `execFileSync` calls per probe, so on macOS every process observation
forks `sysctl` and `ps` synchronously. That stalls, it does not wedge — but it is the shape, and it is the
place to look first.

If neither candidate survives that check, the intermediate is the whole answer and the external supervisor
should not be built.
