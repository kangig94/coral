# TODO — observation cost sits outside every deadline that bounds containment

**Status**: open, unobserved in the field. The arithmetic below is derived from constants, not from a
reproduction, and the entry price for starting is a measured case rather than a bigger multiplication.

## What exists

Containment teardown is budgeted. `PROXY_TEARDOWN_RESERVE_MS` (`src/provider-proxy/orphan-deadline.ts:25`)
sums to 13,000ms, of which `PROXY_PROCESS_CONTROL_BUDGET_MS` allots `2 × CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS`
= 1,000ms to process control. Every step of the _signalling_ sweep honours that: `signalRecordedSet`
(`src/infra/process-containment.ts:284-293`) calls `assertSignalCallWithinBounds` immediately before and after
each `environment.process.kill`, and its comment states the model correctly — the bound is per call, not per
sweep, and `exitDeadline` bounds the whole.

The observation is not in that model. Two facts put it outside every window that exists:

1. **`waitForAbsence` observes before it checks the clock.** `src/infra/process-containment.ts:337-352` runs
   `observeRecordedSet(...)` as the first statement of each loop turn and only then computes `remainingMs`
   against `waitDeadline`. A sweep that overshoots the deadline overshoots it in full; the check that would
   have stopped it runs after it returns.
2. **`observeRecordedSet` does not short-circuit.** `src/infra/process-containment.ts:225-234` iterates every
   recorded root, catching each failure into `firstFailure` and continuing, and throws only after the loop
   completes. One unobservable root does not end the sweep — the remaining roots are still probed.

What each probe costs depends on the platform, and this is the part that changed recently.
`observeProcessIdentity` (`:155`) calls `readIncarnation` per root. On Linux that is a `/proc` read. On Darwin
`probeMacProcessIncarnation` (`src/infra/node-process.ts`) issues **two** synchronous `execFileSync` calls —
`sysctl` for the boot session id, then `ps` — and the boot session id is deliberately uncached, so both are
paid on every observation of every root. Each is now bounded by `PROCESS_INCARNATION_PROBE_TIMEOUT_MS` (2,000ms),
which is what makes the cost finite and therefore statable at all; before that bound it was unbounded.

`MAX_PROXY_RECORDED_PROVIDER_ROOTS` is 128 (`src/provider-proxy/enforcement.ts:31`). So the worst-case Darwin
observation sweep is (1 containment + 128 roots) × 2 subprocesses × 2,000ms ≈ **516 seconds**, against a
13-second reserve, and `waitForAbsence` re-observes every `ABSENCE_POLL_MS` (25ms) until absence or deadline.

And a synchronous subprocess is not merely slow: it blocks the event loop, so no `AbortSignal`, no monotonic
clock check, and no budgeted shutdown step can interrupt it. `assertContainmentAuthorized` at the top of each
loop turn cannot fire while the sweep is inside `execFileSync`.

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
- The three signal-authority entries generally. Nothing here changes who may be signalled or on what evidence.
- `probeCoordinator`'s disposition, closed 2026-08-18: it no longer probes incarnation at all, so the
  coordinator discovery path is out of this entry's reach.

## Required shape

The honest fix is an observation that a deadline can interrupt, which means asynchronous — `readIncarnation`
behind a port that accepts an `AbortSignal`, so `waitForAbsence` can check its budget between roots and the
existing per-call model extends to observation unchanged. That is a larger change than it sounds: the probe is
synchronous at every call site, including `observeContainment`, and `ProcessContainmentEnvironment` is
synchronous throughout.

Two smaller things are worth doing first and neither needs that:

- **Batch the Darwin sweep.** Read the boot session id once per sweep rather than once per root, halving the
  subprocess count. `readMacBootSessionId`'s comment (`src/infra/node-process.ts:155-162`) already weighed
  this and declined: it notes that what remains after the health response stopped being the hot caller is
  "probes of _other_ pids, where the `ps` call has to happen anyway and saving one of two forks buys little."
  That reasoning is sound per probe and was never applied to a sweep — at 129 targets re-observed every 25ms,
  one of two forks is half of the figure above. The disagreement is about magnitude, not about the argument,
  and a sweep-scoped read leaves the module-level cache it rejected still rejected.
- **Short-circuit the observation.** `waitForAbsence` needs to know whether _all_ targets are absent; the
  first non-absent answer settles that. `observeRecordedSet` continues because it also collects a
  `firstFailure` to throw, so the two purposes have to be separated before the loop can stop early.

## What would have to be true to start

A measured case. The 516-second figure is a product of constants, and every term is a worst case that has
never been observed together: a full 128-root set, on Darwin, with `sysctl` or `ps` wedged rather than merely
slow. A reproduction that shows a teardown missing its deadline because of observation cost — even at two or
three roots — would establish the shape is real and give the fix a failing test to close. Without one this is
arithmetic, and this index already records two entries that were wrong about their own cause.
