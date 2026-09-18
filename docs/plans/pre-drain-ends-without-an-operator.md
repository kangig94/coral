> [!WARNING]
> **Temporary. Delete this file when PR #363 closes.**
>
> This lives in the repository only so reviewers of that branch can read it beside the diff. It is not
> documentation and nothing may cite it: `docs/todo/` holds work that outlives a branch, and
> `docs/design-rationale.md` holds reasoning that does. If something here is worth keeping, move it to
> one of those and say so in the PR — do not leave this file as the home for it.

# Pre-plan: drain-ends-without-an-operator

Branch `fix/a-drain-ends-without-an-operator`, based on `origin/main` at `7ae7050d`.
Refs kangig94/coral#357. Track A.

Design decisions settled by pioneer (`fable`), traced against the tree at `7ae7050d`.

## Problem Statement

- **Current state.** `onProviderProxyLifecycleFatal` shuts down with `'provider-proxy-lifecycle-fatal'`;
  `shutdownModeFromReason` returns handoff only for `'replaced' | 'sigterm'`, so the fatal takes **hard**
  mode. Hard mode's exclusive acts, from `buildHardShutdownConsequences`:
  `reapProviderProxySets(snapshot.liveProxySets, …)` → each set's `stopAndReap` → `commitContainment` →
  `commitProviderProxyGuardianContainment` (guardian-only); `terminateAllFn` → `LaunchCoordinator.terminateAll`;
  `markJobsAsErrorFn` → `runShutdownCrashTerminalization`. So a dispatcher fatal — which by `fatalError`'s
  own wording means *this coordinator received corrupt, refused or unknown evidence* — asks that same void
  judgement to destroy every healthy set and every durable child, and to reap the bad set through the very
  guardian whose answer it could not interpret. When the drain then cannot confirm, `owner: 'none'` **and**
  `successor-recovery` remainders both block (`authorityBlocked` is `role !== 'delegable'`),
  `buildAuthorityReleaseBoundary.commit` is never reached, and after three retries the lifecycle parks in
  `waiting-for-operator` with IPC bound forever.
- **Desired state.** At shutdown the coordinator **releases what it holds and exits.** It never destroys
  on its own judgement, never waits for what it cannot end, and everything it leaves is owned by a
  durable successor or named as lost — in the type, the exit code, and one record.

## Success Criteria

- [ ] A provider-proxy lifecycle fatal runs a **handoff** shutdown: no live set is reaped, no durable
      child is killed, no job is marked error on the strength of the judgement the fatal declared void.
- [ ] No remainder holds authority. Every pass prepares and commits the authority-release boundary.
- [ ] `settled` is returned only when nothing declined; `delegated` carries every remainder, both
      `process-exit` and `successor-recovery`. Relaxing the predicate without this introduces a §11
      defect — a hold returned through a success type.
- [ ] Child termination is two obligations along the seam `terminateAll` already has: pending launch
      settlement (`process-exit`, loss named) and recorded child termination, whose remainder is derived at
      settlement from the retained children — `successor-recovery` with `startup-adoption` evidence listing
      every retained child when all are durably published (adopted by `runStartupRecovery` →
      `pollAdoptedRuntime` → `adoptRunningJob` → `pollAdoptedContainment` → `finalizeDeadAdoptedJob`, keyed
      by `DurableCliRuntimeRecord.pid`), otherwise `process-exit`.
- [ ] Exhaustion writes `shutdown-remainder.v1.json` in the run directory — one entry per undischarged
      obligation, keyed by the ledger's own `label` — **before** the discovery record is withdrawn.
- [ ] Exit code is `0` iff the ledger returned `settled`, otherwise `1` through `recordExitCode`.
- [ ] Order is: boundary commit → `gate` → `setLifecycle('stopped')` → write the remainder record →
      `removeBackendInfoIfOwnerFn` → exit. Nothing after the boundary retries.
- [ ] A refused record write is consumed explicitly, logged, and never delays exit.
- [ ] `createBootstrapProbeExitGate` exits after the termination grace it already waits, and no longer
      re-requests cleanup on `leaseSettlement`.
- [ ] `waiting-for-operator` and `owner.kind: 'lifecycle-shutdown-hold'` no longer exist;
      `automaticRetry` keeps `scheduled` only.
- [ ] `shutdownModeFromReason` takes a typed `ShutdownReason` union, not a `string`.
- [ ] A fatal retires the one source that produced it; the hold re-arms and later attempts start only
      unretired sources.
- [ ] `SettlementLedger.gate` remains the sole disposition constructor and `runShutdownSequence`'s sole
      return.
- [ ] Proven against a real coordinator process and a real Unix socket: a non-zero exit code rather than
      a signal, the owned discovery record removed, the socket observed `unlinked` by the test's own probe,
      and the next mutating command spawning a fresh coordinator.

## Scope

- **Included.** `src/coordinator/shutdown.ts` (`shutdownModeFromReason` and its typed reason, boundary
  remainder); `src/obligation/settlement.ts` (`authorityBlocked` predicate, `SettlementDisposition`
  widening); `src/coordinator/shutdown-settlement.ts` (`remainderRole`, `UndischargedRemainder`);
  `src/coordinator/lifecycle.ts` (`acceptShutdownDisposition`, `LifecycleShutdownRecovery`, finalization
  order); `src/coordinator/live/admission.ts` (`TerminateAllDisposition` split) and
  `LaunchCoordinator.terminateAll`; `src/coordinator/bootstrap.ts` (`acceptProcessExitRemainder` exit
  code, `createBootstrapProbeExitGate` bound); `src/coordinator/services/provider-proxy-recovery-policy.ts`
  and `src/coordinator/services/provider-proxy-set/index.ts` (source-keyed fatal retirement, latched
  `retiredSources`, re-armed `#scheduleReattachmentHoldRetry`); a new run-dir record family and reader.
- **Excluded.** Tracks B and C of #357 — the typed hold projection through health, `backend status`
  rendering precedence, provider-host drain admission, the CLI direct-dial seam (#359 landed part of it).
  Force-kill guidance for an *unanswerable* coordinator stays Track B. `abort`-side prevention, proven
  impossible and unnecessary.
- **Erased by pioneer, previously in scope.** The generation-bearing held-set wake surface,
  `Promise.race` over generations, the hold-attempt watchdog, `heldSets()` on
  `ProviderHostCleanupObligations`. After handoff mode and the predicate change **no waiter exists**:
  `createHeldDisposition` mints `retryAfter` only when a decline holds authority, and none will. The
  lifecycle's own `attemptToken`, mirrored into `window.attemptToken` and checked by
  `#isCurrentControlReattachment` with stale evidence released through `#releaseLateReattachmentEvidence`,
  is the only generation that matters — and it exports no promise, so "a waiter never sees its promise
  replaced" holds trivially.
- **Compatibility.** `shutdown-abandonment-status.v1.json` keeps its exact shape and reader — its parser
  `createShutdownObligationAbandonmentReceiptParser` is strict with `disposition: z.literal('abandoned-unconfirmed')`
  and a closed subject enum, so nothing new can go in. Exhaustion writes a **separate**
  `shutdown-remainder.v1.json` in the same `runDir`, same append-and-replace-by-instance shape,
  `writeAtomicDurableSync` at mode `0o600`, reader tolerant (`.passthrough()`), additive-only per §10.
  Entry shape: `{ label, owner: 'process-exit' | 'successor-recovery', via?, settlement: { cause, detail } }`,
  with `instanceId`, `recordedAt`, `reason`, and `mode` on the record. **Corrected before release:**
  `exitCode` was removed because the record exists only for losses and therefore already implies the
  lifecycle's exit contribution of 1; older pre-release records carrying it remain readable through
  `.passthrough()`. Keyed by obligation
  `label` — the identity the ledger already uses in `deferredFailures` — not by a subject enum: the
  abandonment subjects are an enum because they are *arguments to a command*, while a remainder record is
  diagnostic, and a closed enum there would need extending for every obligation the ledger ever gains.
  The shape precedent is `HANDOFF_CAPSULE_FILENAME` in `src/provider-proxy/handoff-capsule-discovery.ts`
  — a generation admitted by address, derived from `SUPPORTED_HANDOFF_CAPSULE_VERSIONS`. An older CLI
  never looks for the new file, so the mixed-window answer is "nothing".

## Assumptions

- **Coral has no operator.** The owner is the only operator anywhere; every other user installs the
  plugin and never types a `coral-cli` command, and the reader of CLI output is the LLM driving the
  session. This is the core UX constraint. A status value named `waiting-for-operator` is a hang.
- §11 admits three exits for a hold; Coral cannot use "an operator decision". The other two exist for
  every obligation here — **outside this process**.
- After exit, each obligation has an owner that does not require a successor coordinator to arrive:
  - **Each proxy set** — the guardian's and reaper's enforcers, armed at `recordContainment`.
    `consumeHolderObservation` in `createArmedEnforcer` observes the holder at `holderCheckAt` = anchor +
    `orphanTimeoutMs − teardownReserveMs` (23 000 ms at the defaults in
    `src/provider-proxy/orphan-deadline.ts`): alive → renew; absent → `consumeAbsence` → `teardown` →
    `reapRecordedContainment`. A successor coordinator, if one arrives, redeems through
    `discoverProviderHandoffCapsules` → `installDiscoveredCapsules` → `#recoverExactCapsule`, admitted at
    the control endpoint by `admitSuccessor` once the lease lapses.
  - **Each durable child** — `publishWrapperSpawned` writes the runtime record and containment status;
    `runStartupRecovery` registers held containment rows and adopts.
  - **Each provider operation** — its saga row, through `ProviderOperationReconciler` and
    `reapProviderOperationCarrier`.
- Holding authority **is** the blocker, not merely equivalent to `kill -9`: the enforcer renews on an
  `alive` holder, and the bound socket makes `waitForSocketRelease` throw instead of spawning a successor.
- **Conditional, not absolute:** "a successor already owns the work" requires a successor coordinator to
  open control after the lease lapses and before `holderCheckAt`, and nothing spawns one after a fatal
  except the next CLI command. When none arrives, **the enforcer's reap is the successor** — which is why
  handoff holds even with nobody watching.
- **Disproven, previously assumed here:** "the lifecycle's 60 s absence observation keeps running after a
  fatal." It does not — `#scheduleReattachmentHoldRetry` is armed only from the retry and evidence paths,
  and the hold's `fatal` sink re-arms nothing. The slot parks. How the reporter's set cleared at 19
  minutes is unexplained, consistent with the exact `0.10.10` tree being unproven.
- **Disproven:** "every obligation has durable evidence its successor reads." False for process-exit
  obligations — process death *is* the mechanism and the record is diagnostic visibility.
- **Disproven:** "empty `retainedProcesses`, pending identities, or cleanup failures" are three
  evidence-less populations. `cleanupHandles.set` has exactly one site, `publishWrapperSpawned`, which
  also sets `cleanupRetentions`; `consumeOutcome` deletes both together. **Only `retainedLaunches` —
  `awaiting-wrapper-identity`, a spawn in flight with no pid yet — is evidence-less.**
- **Disproven:** "no settlement means an immediate retry." `createHeldDisposition` substitutes
  `time.sleep(pollMs)` (`SHUTDOWN_POLL_MS`, 50 ms).
- **Disproven:** "the guardian is unreachable by definition in `reattaching` / `reattachment-hold`."
  `#beginControlReattachment` accepts incidents from any role and does not close the old controls.
- **Corrected, then corrected again in review:** `process.exit` does not unlink a Unix socket file, and
  `bindSocketAtAddress` answers `EADDRINUSE` with `clearStaleSocket` (connect → `ECONNREFUSED` →
  `unlinkSync`) — so a process that dies with its listener open leaves a refusing path the next binder
  clears. But an orderly drain reaches `closeIpcServer`, and Node unlinks the path when `server.close()`
  completes (measured, Node v26.8.2), so the drain this branch proves ends in `ENOENT`. The proof's probe
  is therefore three-valued and asserts `unlinked`; `ECONNREFUSED` is the forced-exit signature.
- **The truth about "continuation":** with no incarnation probes registered, `requestExit` calls
  `process.exit` synchronously inside `finalizeStoppedLifecycle`, before `shutdown()`'s promise resolves
  to `src/coordinator/index.ts` — whose `disposeLifecycleReactor` after `finalized` therefore never runs
  in production. Not this branch's defect; it is what "post-boundary continuation" actually means.

## Affected Systems

- Coordinator shutdown mode selection and the hard/handoff consequence builders.
- The obligation settlement ledger — shared machinery beyond shutdown.
- Coordinator lifecycle disposition types and finalization order.
- Launch admission and durable child termination.
- Bootstrap exit gate and exit-code recording.
- Provider-proxy recovery dispatcher and the reattachment hold.
- A new durable run-dir record family.
- Invariants: `shutdown-teardown-containment.test.ts` and `lifecycle-phase-monotonic.test.ts` both
  survive unchanged. `provider-proxy-recovery-policy.test.ts` needs deliberate revision for conditional
  producer starts and the source-local fatal rule.

## Constraints

- **The predicate change and the disposition change must land in one commit.** Relaxing `authorityBlocked`
  alone makes `gate` return `settled()` whenever `acceptance === null`, hiding declined successor
  remainders under a "done" type.
- Commits: **(1)** typed reason + mode row + ledger predicate + disposition type; **(2)** owners (child
  split, boundary remainder, bounded probe gate) + remainder record + exit code; **(3)** source-keyed
  fatal retirement and the re-armed hold; **(4)** the real-process proof.
- `.claude/rules/decision-union-results.md` applies in `src/coordinator/` — the record write's
  `recorded | refused` union must be consumed or explicitly `void`.
- Test rework, known: the two pinned ledger tests reverse — including `retains authority while a
  successor-recovery obligation remains declined`; the "finalized or waiting-for-operator" terminals in
  `tests/unit/jobs/reconcile/lifecycle-recovery.test.ts` and `recovery-coordinator-shutdown.test.ts`
  become "finalized"; the hard-mode harnesses in `tests/unit/coordinator/shutdown-budget.test.ts` build
  with `reason: 'fatal'`, a literal production never sends — the typed union refuses it, which is the
  point.
- **Untraced, carry into planning:** `hooks.onShutdown(mode)` receives handoff for the fatal and pioneer
  found no implementation under `src/coordinator/`; and the boundary's residual hang surface after
  `initiateControlClose` (three local `client.close()` calls, cannot hang) is `stopHeartbeats`, not
  traced, plus IPC close with in-flight connections — both already carry `retryAfter` through
  `authorityReleaseSettlements()`.

## Approach Direction

Pioneer's sentence for the branch: *at shutdown the coordinator releases what it holds and exits — it
never destroys on its own judgement, never waits for what it cannot end, and everything it leaves is
owned by a durable successor or named as lost, in the type, the exit code and one record.*

How the pieces collapse: decisions 1 and 2 are the two halves of "release, don't execute, don't wait".
Decision 1 erases the wake machinery. Decision 7 is decision 2 restated in the lifecycle's types. The
child split is one row-kind of the remainder record, and the exit code is that record's non-emptiness.

Owner's rulings on the three open sub-items:

- **The bootstrap exit gate is bounded inside commit (2).** The branch's whole claim is that the process
  exits, and this is the one place that can still stop it: `requestCleanup` awaits
  `terminateProcessIncarnationProbes()` with no signal, and the `hold` branch returns
  `untilSettled: leaseSettlement`, which resolves only through `releaseProcessIncarnationProbeLease`
  (`probeSettled && children.size === 0`) — on which the gate re-requests cleanup. Child termination is
  already bounded: `terminateProcessIncarnationProbeChild` sends SIGTERM and its `SIGTERM_GRACE_MS` retry
  timer settles every waiter with `close-unobserved`. **The probe is observation-only** — `ArmedEnforcerOptions`
  states the same rule for its own probes — so it holds nothing exit would betray, and the gate may exit
  after the grace it already waits.
- **`shutdownModeFromReason` takes a typed `ShutdownReason` union.** Tests pass `'fatal'`, production
  passes `'provider-proxy-lifecycle-fatal'`, and `'operator-recovery'` would map to hard if it ever ran
  outside the ledger's retry closure — `requestShutdownRetry` only works because `state.shutdownRetry`
  carries the original ledger. A string parameter is why a test harness can assert hard-mode behaviour
  production never reaches; the union closes all three and makes commit (1)'s one-row change checkable.
- **A fatal retires its source — kept as commit (3).** `retireFatal` keys aborters by `sourceId` and
  aborts one; the window latches `retiredSources`; the hold's sink re-arms
  `#scheduleReattachmentHoldRetry`, and the next attempt starts only unretired sources. Precedent:
  `foreign-capsule-retirement` already refuses fatality per seam. Pioneer rates it *"correct, not
  load-bearing"* — every fatal escalates to shutdown anyway and under handoff the drain does not wait on
  the set, so it buys one boot of earliness inside a ≤30 s window — but a parked slot is a §11 defect
  whether or not anything currently waits on it.

## Additional Context

- **Why handoff is inevitable rather than merely defensible.** The mode is not a property of *why* we
  exit but of *whether this coordinator may execute destruction on its own judgement*. A dispatcher fatal
  is the state in which that judgement is void. Handoff is mechanically "release and exit" — the only act
  that needs no judgement.
- **The reproducible-fatal successor loop.** A fatal reproducible from durable state (the same guardian
  answering out of contract) recurs in each successor's `#recoverExactCapsule` → `retireFatal` →
  `onProviderProxyLifecycleFatal`. The loop is bounded by the enforcers — successors die, the holder is
  observed absent, the set is reaped within one adoption window, the capsule becomes retirable. Under
  hard mode every iteration also reaps every healthy set on the way down; under handoff it costs the bad
  set and nothing else.
- **Under handoff the reported wedge is unreachable from this path.** `providerCleanupConfirmation`
  consults only `closingHosts` and `representationReleaseHolds`; a set in `reattaching`,
  `reattachment-hold`, `containing` or `containment-wait` is never a drain obligation. The drain confirms,
  the boundary commits, the process exits.
- **`delegated` exits 0 today** — a coordinator that left work behind reports success to anything reading
  its exit code. `recordExitCode`'s max semantics are the mechanism; the precedent is
  `createCoordinatorShutdownSignalHandler`, which records `1` on a repeated signal so that an eventual
  safe exit is still nonzero.
- **Reachable population after handoff is small.** Idle fires only with `launchCoordinator.active === 0`,
  so hard-mode pending launches exist only under `sigint` or an unnamed reason. The type must still be
  honest.
- **The abandonment IPC route and `requestShutdownRetry` survive** as the owner's override during a drain
  that now ends by itself in about a minute. They are never a "next step".
- **Known inherited gap.** The handoff path inherits `docs/todo/coordinator-process-disposition.md` (a
  successor may terminalize a carrier that is still alive) — exactly as every `sigterm` handoff already
  does, and hard mode's alternative is killing the carrier outright.
- **Constraint inherited by Track B.** Under this branch the daemon hold's only truthful next step is
  "wait; exits by itself at T". `operatorExit: gated`'s timed solicitation of `contain` is the same
  defect one domain over.
- **Rejected:** creating durable evidence for a pending launch. The evidence would be a process identity
  this process never observed; writing it is the hand-assembled-payload defect in a durable file. The
  honest disposition is process-exit with the loss named — §11's "explicit authority empowered to
  override the uncertainty" is the exit itself, and the record is what makes the override visible.
- **Correction owed to issue #357's comment.** Its decision-2 table names `reapRecordedContainment` as
  child termination's successor; that is the proxy-carrier path in `reapProviderOperationCarrier`. The
  child successor is startup adoption. The comment also states "the ledger therefore always reaches the
  authority-release boundary" as if only `none` blocked it — `successor-recovery` blocks today too.
