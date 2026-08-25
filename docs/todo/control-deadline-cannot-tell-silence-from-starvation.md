# TODO — a control-lease deadline consumed by local starvation reaps jobs that were still running

**Status**: open. Field-observed 2026-08-25 on this host, in a coordinator log shared by two projects.
The load half of this is already recorded in
[`unit-suite-concurrency-and-real-time-tests.md`](./unit-suite-concurrency-and-real-time-tests.md);
what is here is the **policy** half, which is a defect independently of what produces the load.

## What was observed

```
15:27:31.640 WARN  Provider proxy set action=stop-and-reap reason=provider_authority_lost
                   fault=heartbeat-failed subject=guardian liveClaims=1
                   error=Heartbeat echo was not accepted (control-lost).
15:28:12.128 WARN  Provider proxy lifecycle containment-attempt-deadline
                   woke 10488ms after its requested time.
```

A delegated job that had already applied every file change it was asked for died at its reporting step
and reported `The provider became unavailable`. In the same coordinator log: **20** reaps with
`fault=heartbeat-failed`, **8** of them with `liveClaims` of one or more, and **15** timers that woke
more than a second after their requested time, the worst by 10,488 ms.

## Why the verdict cannot be trusted at that moment

`control-lost` is not a peer's answer. `echoChallenge` (`src/provider-proxy/control-lease.ts`) returns
it from `isControlLive`, which is a comparison of the local monotonic clock against `controlLossAt()`.
The instrument is this process's own clock, and the comment above it says as much: the round-trip
comparison is the proof's instrument. That reasoning holds while the process is being scheduled. A
process whose timers wake ten seconds late cannot distinguish **"the peer stopped answering"** from
**"I was not scheduled to hear it"**, and both arrive as the same expired deadline.

The set is then stopped and reaped with a live claim on it. An unanswered question finalized work — the
clause principle 11 exists for, on a path that was written before the principle was.

## The evidence needed to discount it is already being measured

The second log line is the point. The runtime **knows** it woke 10,488 ms late — the containment
deadline reports its own lateness, and so do fourteen other timers in the same log. Nothing consults
that when deciding whether an expired control deadline means silence. A lease that could ask "was I
awake for the window I am judging?" would refuse the verdict rather than finalize on it.

## What is not established

**What starved the coordinator in the observed case is unknown**, and this entry does not claim it. The
job itself was running `cmake` and `ctest`; a local `vitest` run in another project on the same
filesystem was plausibly in flight in the same minute; neither was isolated. Do not use this entry as
evidence that C++ builds produce the stall — the neighbouring entry's measurement says the opposite
about `ninja -j`, and nothing here refutes or confirms it. Attributing the starvation needs a
per-process I/O sample taken at the moment, not a coordinator log.

That uncertainty does not weaken the finding. The defect is that a deadline which *can* be consumed by
local starvation is allowed to finalize claim-bearing work, whatever consumed it on any given day.

## The decision

Three shapes, and they are not equivalent:

- **Discount the sleep.** Feed the loop's observed lateness into the lease so a window the process slept
  through cannot expire. Cheapest, and it uses a signal already produced — but it makes the lease depend
  on a global health measurement, and a starved process measuring its own starvation is not free of the
  same problem.
- **Require a second observation before a claim-bearing reap.** An expired control deadline becomes
  `unknown` rather than `authority-lost`, and reaping a set with `liveClaims > 0` needs evidence about
  the process, not about the silence. Most faithful to principle 11, largest change.
- **Let the claim survive the set.** Reap the set and leave the job's claim to be settled by its own
  observation. Smallest blast radius, and the one most likely to leak a job that nothing ever settles —
  which is the failure mode [`preflight-cannot-defer.md`](./preflight-cannot-defer.md) already
  describes one hop away.

## Start condition

After the routing-status audit branch lands. This touches `src/provider-proxy/control-lease.ts` and the
proxy-set reap decision, neither of which that branch is in.

## Why deferring is not free

Eight claim-bearing reaps in one log is not a rare race. Every one of them is a delegated job that did
its work and lost the report, so the cost is paid twice: the work is invisible, and the operator is told
to retry something that already happened.
