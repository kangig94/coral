# TODO — the last filesystem calls before exit cannot be bounded from inside the process

**Status**: open. Recorded 2026-09-17 from PR #363 (`fix: a drain ends without an operator`), whose plan
called this "tracked separately" while nothing tracked it. Nothing has failed here; the entry exists because
the branch's own claim — the coordinator exits when its runtime and filesystem calls return — has this as
its one stated exception, and an exception with no home is an exception that gets forgotten.

## What is wrong

`finalizeStoppedLifecycle` (`src/coordinator/lifecycle.ts`) is synchronous by contract: it is consumed as
`.then(acceptShutdownDisposition)` and as a plain return, so nothing inside it can `await`. Its last act
before requesting exit is `removeBackendInfoIfOwner` (`src/infra/backend-discovery.ts`), which reads
`runDir/coordinator.json` with `readFileSync` and removes it with `unlinkSync`. Both are uninterruptible
kernel calls on the coordinator's own thread. A journal stall of the shape
[`wedged-coordinator-self-drain`](./wedged-coordinator-self-drain.md) observed on 2026-08-23 — a process held
in uninterruptible sleep on an ext4 commit — blocks them for as long as the device does, and no in-process
deadline, abort signal, or timer can reach a thread that is not running JavaScript.

The remainder record written one statement earlier shares the device and the thread. Delegating that write
to a helper process was designed and rejected ([`design-rationale`](../design-rationale.md) §12.5): the
withdrawal that follows is unguarded, not optional, and on the same journal, so guarding the write alone
buys nothing.

## Why it was left

Three answers were available and each was refused for a reason that still holds:

- **Do not withdraw.** The next binder is already the sole path-cleanup authority for the socket —
  `bindSocketAtAddress` (`src/transport/ipc/server.ts`) answers `EADDRINUSE` with `clearStaleSocket` — and
  `removeBackendInfoIfOwner` already treats a record carrying another writer's token as `unchanged`. But
  what a stale discovery record costs the next CLI has not been measured, and `backend status` and
  `backend shutdown` both read it before dialling.
- **Delegate to a process.** Rejected, above.
- **Make the finalizer asynchronous.** Its consumers forbid it, and an `await` between "stopped" and exit
  is where a post-boundary retry would creep back in.

The exposure is one read and one unlink after every obligation has already been released. Against a device
that has stopped answering, the process would have hung on its first `fdatasync` long before reaching here.

## What closing it requires

A decision, then possibly no code. The decision is whether the discovery record is withdrawn by its writer
or expired by its next reader — the socket already took the second answer. If the record follows, this entry
closes by deleting the withdrawal and teaching every reader of `coordinator.json` that a record whose
process is absent is stale rather than a verdict, which
[`missing-discovery-record-disposition`](./missing-discovery-record-disposition.md) is already partway
through for one of them. If withdrawal stays, it has to leave the exit path's critical section: the exit
request must not be sequenced after a call that cannot return, which means the withdrawal becomes something
requested and observed with a bound rather than performed inline.

**Interaction.** Same cause as `wedged-coordinator-self-drain`, and not the same fix: that entry asks who
outside the daemon may decide it should stop; this one asks only that the daemon's own last two calls not
be the ones that keep it alive after it has already said it stopped. Ship this after that entry has picked a
half, because an external watchdog changes what an unbounded call here costs.

## Shared blocker

The writer-withdrawal decision shares the question of who can end a wedged coordinator with
[`wedged-coordinator-self-drain.md`](./wedged-coordinator-self-drain.md),
[`ensure-waits-less-than-the-drain-it-waits-for.md`](./ensure-waits-less-than-the-drain-it-waits-for.md),
and [`explicit-drain-waits-behind-inflight-gate.md`](./explicit-drain-waits-behind-inflight-gate.md).
A reader-expiry answer also needs the single stale-record reader proposed in
[`missing-discovery-record-disposition.md`](./missing-discovery-record-disposition.md).
