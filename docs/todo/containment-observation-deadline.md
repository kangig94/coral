# TODO — observation cost sits outside every deadline that bounds containment

**Status**: closed. The orphan population was observed in the field; the bounds remain derived from constants,
not from an instrumented coordinator exit.

## What existed before the fix

On 2026-08-30, three complete provider-proxy sets — guardian, reaper, and proxy — were alive on a developer
machine with no coordinator running and no live jobs: `coral-cli jobs` reported no jobs in a live phase. Each
guardian had been reparented to PPID 1. Their ages at observation were 8h42m, 8h28m, and 2h54m. Sending
SIGTERM to each guardian terminated its complete set.

That sighting establishes that the orphan population this entry reasons about occurs in practice and can
persist for hours. It does not measure observation cost against a deadline or confirm the constant arithmetic
below: nobody instrumented the teardown path, and the coordinator's exit was not observed.

Containment teardown is budgeted. `PROXY_TEARDOWN_RESERVE_MS` (`src/provider-proxy/orphan-deadline.ts`)
sums to 14,000ms, of which `PROXY_PROCESS_CONTROL_BUDGET_MS` allots `2 × CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS`
= 1,000ms to process control. Every step of the _signalling_ sweep honours that: `signalRecordedSet`
(`src/infra/process-containment.ts`) calls `assertSignalCallWithinBounds` immediately before and after
each `environment.process.kill`, and its comment states the model correctly — the bound is per call, not per
sweep, and `exitDeadline` bounds the whole.

The observation is not in that model. Two facts put it outside every window that exists:

1. **`waitForAbsence` observes before it checks the clock.** `src/infra/process-containment.ts` runs
   `observeRecordedSet(...)` before it computes `remainingMs` against `waitDeadline` — the abort check
   (`assertContainmentAuthorized`) comes first, but it does not consult the deadline. A sweep that overshoots the deadline overshoots it in full; the check that would
   have stopped it runs after it returns.
2. **`observeRecordedSet` does not short-circuit.** `src/infra/process-containment.ts` iterates every
   recorded root, catching each failure into `firstFailure` and continuing, and throws only after the loop
   completes. One unobservable root does not end the sweep — the remaining roots are still probed.

What each probe costs depends on the platform, and this is the part that changed recently.
`observeProcessIdentity` calls `readIncarnation` per root. On Linux that is a `/proc` read. On Darwin
`probeMacProcessIncarnation` (`src/infra/node-process.ts`) issues **two** synchronous `execFileSync` calls —
`sysctl` for the boot session id, then `ps` — and the boot session id is deliberately uncached, so both are
paid on every observation of every root. Each is now bounded by `PROCESS_INCARNATION_PROBE_TIMEOUT_MS` (2,000ms),
which is what makes the cost finite and therefore statable at all; before that bound it was unbounded.

`MAX_PROXY_RECORDED_PROVIDER_ROOTS` is 128 (`src/provider-proxy/enforcement.ts`). So the worst-case Darwin
observation sweep is (1 containment + 128 roots) × 2 subprocesses × 2,000ms ≈ **516 seconds**, against a
14-second reserve, and `waitForAbsence` re-observes every `ABSENCE_POLL_MS` (25ms) until absence or deadline.

And a synchronous subprocess is not merely slow: it blocks the event loop, so no `AbortSignal`, no monotonic
clock check, and no budgeted shutdown step can interrupt it. `assertContainmentAuthorized` at the top of each
loop turn cannot fire while the sweep is inside `execFileSync`.

**Updated 2026-09-03.** The `overload-tolerance-floor` plan added a second, different identity probe that does
not fix this entry but does change one of its inputs. `createAsyncRecordedProcessObserver`
(`src/infra/node-process.ts`), reached through `ProcessPort.observeRecordedProcessAsync`, answers the
guardian/reaper enforcer's own periodic holder-check (`observeControlHolder`,
`src/provider-proxy/holder-lifecycle.ts`) with non-blocking `execFileAsync` calls and `AbortSignal`-bounded file
reads, each capped by the same `PROCESS_INCARNATION_PROBE_TIMEOUT_MS` this entry already names. It leaves the
sweep this entry is about untouched: `observeRecordedSet`/`waitForAbsence` in `src/infra/process-containment.ts`
still call the synchronous `readIncarnation` above, unabridged and still checking the deadline only after
observing. What it changes is the reserve the 516-second figure above is measured against, not the figure
itself. `containmentExecutionDeadline` (`src/provider-proxy/orphan-deadline.ts`) now grants the dominant
absence-driven teardown path `PROXY_TEARDOWN_RESERVE_MS - PROXY_ENFORCER_MAX_WAKE_LATENCY_MS` =
14,000 - 1,000 = **13,000ms**, carving that 1,000ms out for the wake that consumes the new probe's already-settled
result. A local-signal (`giveUp`) teardown and the pre-publication provisional-phase clock bound still receive
the full 14,000ms; only the holder-observed-absence path lost it.

## What is already decided

- **The per-call model is right and stays.** `signalRecordedSet`'s comment is correct: bounding a sweep of
  fast syscalls per-sweep would abandon a reap that was progressing normally. Nothing here argues for
  changing it. The gap is that observation was never brought into any model at all.
- **The probe bound stays best-effort.** Node signals the child and continues waiting, so an uninterruptible
  child overruns regardless. `tests/invariants/sync-subprocess-timeout.test.ts` enforces that every direct
  synchronous subprocess under `src/` asks for a bound; it deliberately does not assert one is honoured.
- **Retaining on `unknown` stays.** The conservative direction is not in question. This entry is about the
  cost of reaching an answer, not about which answer authorizes what.

## Explicitly out of scope

- `darwin-signal-authority`. That entry is about whether a macOS incarnation may _authorize a signal_ — a
  resolution question. This one is about what the probe _costs_ to take. They touch the same function and
  answer different questions; fixing either leaves the other exactly as it was.
- `durable-cli-signal-authority` as well. Nothing here changes who may be signalled or on what evidence.
- `wedged-coordinator-self-drain`, which is the closest neighbour and needs saying because it already points
  at this function: it names `probeMacProcessIncarnation`'s two uncached synchronous calls as the place to
  look first for a coordinator that stops answering. Same evidence, different question — that entry asks what
  ends a process nothing else will end, this one asks whether a budgeted operation can hold its deadline while
  observing. They share one prerequisite, an interruptible incarnation probe, so whichever is built first
  gives the other its mechanism; neither closes the other, and both still owe their own reproduction.
- `probeCoordinator`'s disposition, closed 2026-08-18. Its _read_ half no longer derives an incarnation at
  all — it observes liveness — so nothing on that path forks a subprocess. The **write** half still does:
  `writeDiscoveryRecord` (`src/infra/backend-discovery.ts`) probes an incarnation when its caller supplies
  none, and lifecycle's `writeBackendInfoFn({…})` — the record written immediately before `kernel-ready`,
  `src/coordinator/lifecycle.ts` — supplies none, so a darwin boot pays two `execFileSync` calls
  between the listener opening and `kernel-ready`. That is one probe of one pid, not a sweep, and it is inside
  the CLI's `KERNEL_READY_DEADLINE_MS` rather than a teardown reserve — related, bounded, and not what this
  entry is about, but an earlier revision of this bullet claimed the whole discovery path was out of reach and
  that was wrong.

## Resolution and bound

Budgeted containment now uses the runtime's asynchronous identity-bound observer. The observer accepts the
caller's `AbortSignal`, so cancellation settles the observation without waiting for a synchronous subprocess.
The recorded-set sweep checks its monotonic deadline before each target and after every awaited probe. If a
probe crosses the deadline, the partial sweep is `unobservable`; it cannot become absence. Absence-only waits
also stop at the first present target because the remaining roots cannot change that verdict.

The maximum-root multiplier no longer controls deadline overshoot. A sweep can start one probe immediately
before its deadline, so the operation's modeled bound is its deadline plus one
`PROCESS_INCARNATION_PROBE_TIMEOUT_MS` interval. The Darwin probe shares one 2,000ms abort signal across its
`sysctl` and `ps` subprocesses; the earlier 516-second estimate incorrectly charged 2,000ms to each subprocess
instead of to their shared probe. The holder-absence path therefore has a modeled worst case of about 15
seconds (13,000ms plus 2,000ms), while paths granted the full 14,000ms reserve have a modeled worst case of
about 16 seconds. Those are end-to-end return bounds under the runtime timer model, not claims that every
target can be observed inside the reserve.
