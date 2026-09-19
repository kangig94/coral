> [!WARNING]
> **Temporary. Delete this file when PR #363 closes.**
>
> This lives in the repository only so reviewers of that branch can read it beside the diff. It is not
> documentation and nothing may cite it: `docs/todo/` holds work that outlives a branch, and
> `docs/design-rationale.md` holds reasoning that does. If something here is worth keeping, move it to
> one of those and say so in the PR — do not leave this file as the home for it.

# A drain ends without an operator

**Preplan**: `/home/kang/.coral/projects/kangig94-coral/plans/pre-drain-ends-without-an-operator.md`

Branch `fix/a-drain-ends-without-an-operator`, based on `origin/main` at `c6f3e32f`.
Refs kangig94/coral#357, Track A.

> **Citation style.** Symbol name and path, never line numbers — `.claude/rules/conventions.md`
> rejects a line number because it is stale the next time anything above it moves.

## Requirements Summary

A provider-proxy lifecycle fatal starts a shutdown that cannot finish, and the coordinator parks in
`waiting-for-operator` with IPC bound — forever, on a machine where **no operator exists**
(`.claude/rules/design-philosophy.md` §12). Two independent defects produce that:

1. **The fatal takes the wrong mode.** `onProviderProxyLifecycleFatal` (`src/coordinator/composition/index.ts`)
   shuts down with `'provider-proxy-lifecycle-fatal'`; `shutdownModeFromReason` (`src/coordinator/shutdown.ts`)
   returns handoff only for `'replaced' | 'sigterm'`, so the fatal takes **hard**. Hard mode's exclusive
   acts, from `buildHardShutdownConsequences`: `reapProviderProxySets(snapshot.liveProxySets, …)` → each
   set's `stopAndReap` → `commitContainment` → `commitProviderProxyGuardianContainment` (guardian-only);
   `terminateAllFn` → `LaunchCoordinator.terminateAll`; `markJobsAsErrorFn` → `runShutdownCrashTerminalization`.
   A dispatcher fatal means *this coordinator received corrupt, refused or unknown evidence* — so hard
   mode asks that void judgement to destroy every healthy set and every durable child, and to reap the
   bad set through the very guardian whose answer it could not interpret.
2. **Remainders hold authority.** `remainderRole` (then in `src/coordinator/shutdown-settlement.ts`, since deleted) maps
   `none → blocking`, and `authorityBlocked` in `SettlementLedger.settleInitially` / `retryDeclined`
   (`src/obligation/settlement.ts`) is *any declined role other than `delegable`* — so
   `successor-recovery` blocks too. `buildAuthorityReleaseBoundary.commit` is never reached; IPC stays
   bound; after three retries `acceptShutdownDisposition` (`src/coordinator/lifecycle.ts`) produces
   `waiting-for-operator`.

**The change, in one sentence:** at shutdown the coordinator releases what it holds and exits once the
runtime and filesystem calls it invokes return — it never destroys on its own judgement, never waits for
an unsettled asynchronous operation, and everything it leaves either has a durable outliving owner or is
named as lost, in the type, the exit code and one record. Returned discovery read/unlink failures cannot suppress
the exit request; an uninterruptible synchronous filesystem call remains outside any in-process deadline.

**Why releasing is safe.** After exit every obligation has an owner that does **not** require a successor
coordinator to arrive: a proxy set has its guardian's and reaper's armed enforcers (`consumeHolderObservation`
in `createArmedEnforcer` observes the holder at anchor + `orphanTimeoutMs − teardownReserveMs`, 23 000 ms
at the defaults in `src/provider-proxy/orphan-deadline.ts`; absent → `consumeAbsence` → `teardown` →
`reapRecordedContainment`); a durable child whose runtime publication completed has its runtime record from
`publishWrapperSpawned` and `runStartupRecovery`'s adoption path; a provider operation has its saga row through
`ProviderOperationReconciler` and `reapProviderOperationCarrier`. **Holding is the blocker**: the enforcer
renews while the holder is `alive`, and the bound socket makes `waitForSocketRelease` throw instead of
spawning a successor. Cleanup registration alone is not successor evidence: an observed child whose runtime
publication throws remains a named `process-exit` loss.

## Acceptance Criteria (testable, verifiable — register each as a Task during implementation)

- **AC1** — One typed `ShutdownReason` union flows through `LifecycleController.shutdown`,
  `LifecycleStartupContext.shutdown`, `RunShutdownSequenceContext.reason`, and `shutdownModeFromReason`.
  It also closes the public propagation holes at `CoordinatorServerController.shutdown`,
  `SimulationController.shutdown`, the IPC shutdown callback, and `IdleTimer.startWatching`'s callback.
  Passing a literal that is not a member fails the typecheck; shutdown retry invokes the stored ledger retry
  for the original reason and never synthesizes `'operator-recovery'`. The union admits one explicit
  test-teardown member on the **hard** arm, because every literal the suites pass today
  (`'test'`, `'test-cleanup'`, `'test cleanup'`, `'test-complete'`, `'test-mid-recovery'`,
  `'test-after-poller-live'`, `'teardown'`, `'done'`, `'abort-verified'`) takes hard mode, and mapping them onto a handoff member silently stops
  `terminateAllFn` and `markJobsAsErrorFn` in ~20 teardowns. **Corrected during implementation:** `'signal_abort'` and `'queue_shutdown'` belong to the separate
  provider semantic-operation shutdown API and never reach `shutdownModeFromReason`; `src/kb-daemon/daemon-main.ts`
  has an independent numeric stop API. Neither is in AC1's scope. The compiler-resolved inventory is
  **57 coordinator shutdown invocations across 21 files**, not the 13 the plan first stated.
  `tools/simulation`'s
  `reason: z.string().optional()` (`scenario-schema.ts`, consumed by `runner.ts`) is a Zod ingress that
  narrows to the union explicitly per §8 — not a cast, and not left as `string`. The simulation-only
  `'cycle'` and default `'simulation-shutdown'` inputs normalize to that hard test-teardown member;
  production `'idle'` is its own hard-arm member and the idle callback is typed accordingly.
- **AC2** — A `provider-proxy-lifecycle-fatal` shutdown runs in **handoff** mode: `reapProviderProxySets`
  receives `[]` for established sets, neither `settlePendingLaunchesFn` nor `terminateRegisteredChildrenFn` runs,
  `markJobsAsErrorFn` does not run.
- **AC3** — `UndischargedRemainder` has no `none` member; `remainderRole` and its `blocking` role no longer
  exist; `authorityBlocked` no longer exists. `SettlementObligation.hold` no longer exists; the
  authority-release boundary is the only hold producer. Every pass prepares and commits the
  authority-release boundary.
- **AC4** — `SettlementLedger.gate` returns `settled` only when nothing declined. A pass with declined
  `successor-recovery` entries returns `delegated` carrying them, never `settled`. Two mechanics make that
  reachable, and both are asserted: `acceptDelegatedRemainder` is invoked for **every** declined entry
  regardless of role — today it is fed only `role === 'delegable'`, and `retryCleanTransfer` commits with
  `acceptance: null`, so `gate`'s committed branch returns `settled()` on exactly the paths this AC
  forbids. And **no container stamps an owner its entries may contradict**: the disposition-level `owner`
  and `ProcessExitRemainder.owner` are removed, `deferredFailures` is renamed `undischarged`, because each
  entry now carries its own `remainder.owner`. Reusing `ProcessExitRemainder { owner: 'process-exit' }` as
  the carrier for `successor-recovery` entries is §11's overload defect moved from the entry to the box.
- **AC5** — Shutdown registers two ordered ledger obligations along the seam currently hidden inside
  `LaunchCoordinator.terminateAll`: pending/unpublished launch settlement first, durably published child
  termination second. Each task has its own label and remainder; a richer return from one ledger task is not
  accepted as a split. `terminateAll` is a **fixpoint loop**, not a sequential body — its `while` re-enters
  stage 1 whenever settling a pending launch registers a cleanup handle. The staged replacement chooses one
  design: **stage 1 owns and sets `shutdownRequested`, drains queued launches, then snapshots pending
  launches.** Every admitted launch registers in `pendingDurableLaunches` synchronously before its first
  `await`, so after that latch and snapshot stage 2 cannot create a new pending launch. An invariant test
  interleaves admission at that synchronous registration boundary and proves the snapshot is closed; there
  is no stage-2-to-stage-1 loop. The staged API also names **one** owner for the `shutdownRequested` /
  `drainQueuedLaunches` latch, and returns **two** disposition types rather than consuming one
  `dispositionAtDeadline()` twice; `childTerminationConfirmation` and `retainedChildActions` split with
  them. `terminateAll` itself is **deleted**, not wrapped: its only production reference is
  `composition/defaults.ts`'s `terminateAllFn` injection, and every remaining caller is a test.
  `terminateAllFn` is replaced by two injections named after the methods they wrap,
  `settlePendingLaunchesFn` and `terminateRegisteredChildrenFn`. The first obligation carries `process-exit`;
  the second derives its remainder at settlement from the retained children: `successor-recovery` with
  `startup-adoption` evidence listing every retained child when all are durably published, otherwise
  `process-exit` with each child's publication state named in the settlement detail.
- **AC6** — Child state has three semantic states: a pending wrapper identity is `process-exit`; an observed
  child whose runtime publication failed or is unproven is `process-exit` with the publication loss named;
  only a child promoted after `onRuntimeRecord` returns successfully is `successor-recovery` — per child; the
  obligation's remainder is `successor-recovery` only when every retained child is. The evidence
  is typed and claims **only what the promotion point establishes**: `appendRuntimeStarted` commits the
  `job.runtime.started` event and `writeDurableCliProvisionalProcessRuntimeMeta` in one transaction, so the
  evidence is the job id, `DurableCliRuntimeRecord.pid`, and the leader incarnation. It does **not** claim a
  durable-cli containment status row: that row is keyed by job id but written by `jobs/shell/launch.ts`'s
  containment path and by the adoption path itself (`running-adoption.ts`), never at promotion. The
  successor named is `runStartupRecovery` → `pollAdoptedRuntime` → `adoptRunningJob` →
  `pollAdoptedContainment` → `finalizeDeadAdoptedJob`. Publication classification and pending release are
  exception-safe across **both** callbacks: a throwing `onRuntimeRecord` leaves `observed-unpublished`,
  still attempts `publishProcessIdentity(provisionalSubject)`, and releases the pending launch; once
  `onRuntimeRecord` succeeds, state is latched `durably-published` before `publishProcessIdentity`, and a
  retained or throwing identity publication still releases the pending launch in a `finally` path. Thus
  every callback outcome leaves the child in exactly one staged obligation — today either throw can leave
  it in both `cleanupHandles` and `pendingDurableLaunches`.
- **AC7** — Exhaustion publishes `shutdown-remainder.v1/<instanceId>.json` in the run directory at mode `0o600`, one
  entry per undischarged obligation keyed by the ledger's own `label`, through a **synchronous inline**
  `runtime.storage.writeAtomicSync` call after explicitly creating the version directory. The requirement is
  **ordering**: the write is the statement before `removeBackendInfoIfOwnerFn`. It is not a durability race,
  so `finalizeStoppedLifecycle` stays synchronous and no process is spawned to perform it.
- **AC8** — `shutdown-abandonment-status.v1.json` and
  `createShutdownObligationAbandonmentReceiptParser` are byte-for-byte unchanged; an older reader of the
  abandonment family still parses every record this build writes to it.
- **AC9** — The remainder record's entries are the ledger's structured dispositions:
  `{ label, remainder, settlement: { cause, detail } }`. `remainder` is either `{ owner: 'process-exit' }`
  or `{ owner: 'successor-recovery', evidence: SuccessorRecoveryEvidence }` (`startup-adoption`, carrying
  the list of durably published child processes, `startup-store-recovery`, or `startup-liveness-recovery`);
  no free-form `via` string remains. The record also carries `instanceId`, `recordedAt`, `reason`, and `mode`.
  **Corrected before release:** `exitCode` was removed from the record because every record already implies
  the lifecycle's constant exit contribution of 1; older pre-release records that carry it still decode
  through the record schema's `.passthrough()`. Tolerance is **per entry, not only per field**: `.passthrough()` on the entry
  object does not save a reader whose `entries: z.array(closedUnion)` rejects the whole file for one
  unknown `SuccessorRecoveryEvidence` kind. Entries decode individually; an undecodable entry is skipped,
  counted, and the count is reported by the programmatic reader, per §10's own "skipped and reported by
  key" precedent. Records decode individually too: an undecodable record is counted by the reader and carried
  forward verbatim by the writer, which refuses only when the envelope itself is unreadable. Successor boot
  retains at most the latest 32 instance records (one record keeps all of its entries), so recurring fatal
  exits have bounded later read cost without putting the scan and unlink work on the predecessor's exit path.
  **Pioneer correction:** the implemented vocabulary has two owners. A durably published child's wrapper
  finalizer has custody as its enforcer, while the remainder remains `successor-recovery` because startup
  re-derives adoption from durable truth. `LifecycleShutdownDisposition` has only `held` plus its two terminal
  arms, and `GateResolution` has only `held` and `terminal`: a boundary refusal produces `held`, while
  successful commit or final exhaustion produces `terminal`, where remainder acceptance is attempted. The
  durable address is the per-instance `shutdown-remainder.v1/<instanceId>.json`, not a shared file. The
  no-daemon arm of `backend status` renders the newest record only while recent and offers no next step.
- **AC10** — The shutdown ledger contributes `0` only for `settled` and `1` for every other disposition
  through `recordExitCode`; the process exit code remains the maximum of all contributors. A prior repeated
  signal or startup contribution is therefore never lowered by a later settled ledger.
- **AC11** — Finalization order is boundary prepare/commit attempts → `gate` (which owns the bounded
  boundary exhaustion, see AC18) → `setLifecycle('stopped')` → write the remainder record when it carries
  losses → attempt the
  typed `removeBackendInfoIfOwnerFn` withdrawal → request exit in a `finally`-equivalent path. A returned
  read/unlink refusal is logged, contributes exit code `1`, and produces the carrying-losses lifecycle
  terminal; it cannot skip the exit request. After a returned refusal, the same instance record is written
  again with the withdrawal loss before exit is requested.
  Nothing after the boundary retries. `finalizeStoppedLifecycle` and
  `acceptShutdownDisposition` remain **synchronous** — they are consumed as
  `state.shutdownRetry().then(acceptShutdownDisposition)` and as a plain return from `attempt`, so
  anything requiring an `await` cannot be placed here.
- **AC12** — A `false` return or a throw from the remainder write is consumed explicitly per
  `.claude/rules/decision-union-results.md` as a typed `refused`, logged, and does not delay discovery
  withdrawal or exit; the exit code is already non-zero: the record is written only for a shutdown carrying
  losses, and a refused write changes neither the disposition nor the exit code. `removeBackendInfoIfOwner`
  likewise returns a typed
  `removed | unchanged | refused` result: non-`ENOENT` discovery reads and unlinks become `refused`, and
  finalization logs them, records a nonzero contribution, writes the record with that named loss, and still
  requests exit. The record is best-effort diagnostic visibility: it
  may be lost, and losing it changes nothing about who owns the obligations it names.
- **AC13** — `createBootstrapProbeExitGate` passes an abort signal with a `SIGTERM_GRACE_MS` deadline to the
  initial `terminateProcessIncarnationProbes` call and never re-requests cleanup on `leaseSettlement`.
  Both a probe child that never closes and a childless lease whose filesystem probe never settles therefore
  produce a logged hold and cannot prevent `process.exit` after the grace; a rejected cleanup likewise cannot
  prevent `process.exit`.
- **AC14** — `waiting-for-operator` and `owner.kind: 'lifecycle-shutdown-hold'` do not exist in
  `LifecycleShutdownRecovery`; `automaticRetry.status` admits `scheduled` only. On its own that is
  cosmetic — `automaticRetry.status` is read by two test files and nothing in production. The load-bearing
  half is the counter reconciliation described by AC18. A test asserts exhaustion is *reached*, not merely
  reachable, even when `initiateControlClose` never settles.
- **AC15** — `retireFatal` (`src/coordinator/services/provider-proxy-recovery-policy.ts`) aborts only the
  source that produced the fatal, and its `disposeCachedEvidence` is **source-scoped**: today it is called
  with no argument, which routes every cached `evidence` through `disposeLateEvidence` — for this hold,
  `#releaseLateReattachmentEvidence` → `releaseProviderProxySetContainmentProofFence` — so a redemption
  fatal releases the fence the surviving absence source's decision depends on and erases the evidence this
  rule exists to act on. `submit`'s `if (retired) …` guard becomes per-source for the same reason, while
  late evidence from a *retired* source is still disposed. Redemption and absence have independent
  controllers; the window owns a separate aggregate cancel operation for clearing, deadline, and external
  cancellation, and that operation accounts for the **third** use of `window.attemptAbort` — the
  absence-reap phase re-points it at a fresh `reapAbort`. `ControlReattachmentWindow` latches
  `retiredSources`; a later attempt starts only unretired sources.

  The reducer rule is written around the branches that actually hang. `reduceControlReattachment` tests
  reap-required absence **first**, so absence-decides-by-reap already needs no peer and is not the gap.
  With redemption retired, the two cases that never decide are (a) absence evidence that does *not* require
  reap and (b) absence `unavailable` — both fall through to `if (redemption === undefined) return`. Both
  must reach a terminal or a scheduled retry. The mirror case (unavailable redemption after absence
  retires) is also covered. The motivating fatal is raised **by the redemption source** — both `role-control`
  `provider_proxy_control_redemption_contract_violation` branches — so a test built as "fatal redemption
  plus reap-required absence" passes before the change and proves nothing.

  Re-arming is **once, from the reducer's terminal**, after the last unretired source settles — not from the
  `fatal` sink. Two live sources each reaching `#scheduleReattachmentHoldRetry` arm two timers, and it
  assigns `slot.retryTimer` without clearing a pending one, so one timer leaks past `#clearControlReattachment`
  and two overlapping `#runReattachmentHoldAttempt` calls each take a containment-proof fence.
  `#scheduleReattachmentHoldRetry` clears any pending `slot.retryTimer` first regardless.
  Source retirement itself is a reducer input: after recording `retiredSources` and disposing only that
  source, `retireFatal` immediately invokes `reduceControlReattachment`. This covers survivor-first /
  fatal-last as well as fatal-first / survivor-last; reducer tests exercise both arrival orders for every
  named redemption/absence pair.

- **AC16** — `SettlementLedger.gate` remains the sole disposition constructor and `runShutdownSequence`'s
  sole return — `tests/invariants/shutdown-teardown-containment.test.ts` keeps its substance (**corrected in
  review:** it did not pass byte-unchanged; it took mechanical renames for AC4/AC5 — `deferredFailures` →
  `undischarged`, the dropped disposition `owner`, and the `terminateRegisteredChildren` seam — with the
  per-handle try/catch invariant carried forward intact).
- **AC17** — A test-only backend entrypoint, built from production coordinator/bootstrap modules but never
  copied into the plugin, exposes the exact composition fatal callback to a parent-owned trigger pipe,
  injects a never-settling lifecycle-reactor disposal, and supplies a programmatic shutdown budget.
  Against that **real** coordinator process and **real** Unix socket, when its runtime and filesystem calls
  return, the process exits with a non-zero code
  rather than a signal, the owned discovery record is removed, the socket stops accepting connections, and
  the next mutating command spawns a fresh coordinator. `probeSocketReleased` is a module-private function
  in `src/transport/ipc/ensure.ts` and is not assertable from a test as written — the test builds its own
  three-valued connect probe (`released` on `ECONNREFUSED`, `unlinked` on `ENOENT`; see Commit 5 for why an
  orderly drain yields `unlinked`) rather than exporting the function. `tests/integration/coordinator/helpers.ts` supplies
  `spawnCoordinator`, `waitForDiscoveryRecord`, `readDiscoveryRecordForHome`, `coordinatorFilesForHome`
  and `waitForProcessExit`; it supplies **no** socket assertion, so that one is new.
- **AC18** — A `LifecycleShutdownDisposition` distinguishes a fully discharged finalization from one
  carrying named losses. Today `acceptShutdownDisposition` maps **both** `settled` and `delegated` to
  `finalizeStoppedLifecycle()` → `{ disposition: 'finalized' }`, and the difference survives only as
  `held` / `waiting-for-operator`, which AC14 deletes. Without this, every shutdown — clean, or with eleven
  named `process-exit` losses — returns the same success-shaped value to `coordinator.shutdown()`,
  `waitForShutdown()` and the IPC shutdown route, and AC10 restores the difference only in an exit code no
  in-process caller reads. §11: a hold may not be returned through a type whose success means "done".
  `isLifecycleShutdownTerminal` is the single predicate for `finalized` and `finalized-with-losses`.
  Lifecycle continuation, coordinator shutdown/wait cleanup and store closure, simulation-root cleanup,
  and abandonment all use it; a terminal with losses stops retries, performs cleanup, and cannot offer an
  abandonment action.

  Boundary exhaustion has **one** home inside `gate`. `SettlementLedger` owns
  `boundaryTransferAttemptsStarted`, keyed by the boundary. A named `attemptBoundaryTransfer` caller
  increments it immediately before each prepare/commit cycle; the initial gate cycle counts as attempt 1,
  one `retryBoundaryTransfer` drives attempts 2 and 3, and the third declined prepare or
  commit becomes a structured boundary `process-exit` loss and `finalized-with-losses` rather than another
  hold. `buildAuthorityReleaseBoundary.hold.retryAfter` is bounded by racing its in-flight settlement wake
  against `time.sleep(SHUTDOWN_POLL_MS)`; it never exposes raw `Promise.all(inFlight)` as the prerequisite
  for the next lifecycle invocation. Therefore a never-settling close reaches exhaustion on lifecycle
  attempt 3.

  Obligation entries run exactly once. `retryDeclined` is deleted or isolated from shutdown; after the
  initial pass, retries operate only on acceptance and boundary prepare/commit. A refused, throwing, or
  identity-mismatched `acceptProcessExitRemainder` becomes a named `process-exit-remainder-acceptance`
  loss and uses the finalizer's nonzero fallback exit path; it is not retried, not reported as settled, and
  does not rerun obligations. Tests cover preparation failure, verified-acceptance refusal, the
  never-settling close, and the real production continuation rather than manually invoking a retry closure.

- **AC19** — The branch does not leave a destructive solicitation behind the state it deletes.
  `lifecycleRefusalExit` (`src/cli/errors.ts`) currently tells its reader — the LLM driving the session, per
  §12 — to run `coral-cli backend shutdown-recovery abandon <subject>`, and asserts *"A drain that does not
  clear on its own will not clear by retrying either."* After this branch that sentence is false: the drain
  ends by itself inside the budget whenever the runtime/filesystem calls return. Both branches report the
  bounded asynchronous wait and when to retry, and name no
  abandon command; the function's constraint comment (*"A held shutdown does not end on its own…"*) is
  rewritten or deleted rather than edited to stay true, and `docs/cli-errors.md`'s exit-`75` row loses the
  same remediation. `ShutdownHoldExit`'s `durable-operator-abandonment` and
  `required-cleanup-capability-confirmation-or-durable-operator-abandonment` members are retired (and
  `defaultHold` itself was deleted outright under AC3's later correction, since the boundary is the only
  hold producer); no current-build shutdown producer or serialized remainder detail offers an
  imperative destructive command. This includes both shutdown paragraphs in `docs/cli-errors.md` and
  `childTerminationConfirmation`'s `Run coral-cli abort jobs …` detail, but does not remove commands or
  guidance for separate still-live provider-set/abort states.

  The compatibility decision is fixed: retain the CLI command, schemas, and IPC method so a new CLI can
  operate an older daemon that legitimately offered the action. Remove every current-build solicitation and
  action producer; a new coordinator always returns `not-held`/`not-offered`. The capability survives as an
  owner-only mixed-version override, never as an LLM-facing next step.

## Execution Order (dependency graph, batches, file mapping — written after review loop, see step 4e)

### Dependency Graph

```
AC1 ─┬─→ AC2 ──→ AC3 ──→ AC4 ─┬─→ AC18 ──→ AC14 ──→ AC16
     │                        │
     │                        ├─→ AC10 ─┬─→ AC11 ──→ AC12
     │                        │         │
     │                        └─→ AC7 ──┴─→ AC8, AC9
     │
     └─→ AC15 (needs only the typed reason; independent of the ledger)

AC5 ──→ AC6                   (child staging; independent of the ledger)
AC13                          (probe gate; independent of everything)
AC19                          (surface; needs AC3+AC14 to know which holds survive)
AC17                          (proof; needs every implementation AC)
```

`AC1 → AC2` because the handoff arm is a member of the union AC1 introduces. `AC3 → AC4` because
deleting `blocking` is what forces `gate` to stop returning `settled` on a declined pass. `AC4 → AC18`
because the carrying-losses terminal is a disposition AC4 makes constructible. `AC10 → AC11 → AC12`
is the exit-code → ordering → refusal chain, each reading the one before. `AC7 → AC8, AC9` because the
record's address decides both the compatibility claim and the reader's tolerance.

### Batches

| Batch | ACs | Dependencies | Parallel | Commit |
|-------|-----|--------------|----------|--------|
| 1 | AC1, AC5, AC13 | — | 3 | 1, 2 |
| 2 | AC2, AC6, AC15 | AC1, AC5 | 3 | 1, 2, 3 |
| 3 | AC3 | AC2 | 1 | 1 |
| 4 | AC4 | AC3 | 1 | 1 |
| 5 | AC7, AC10, AC18 | AC4 | 3 | 1, 2 |
| 6 | AC8, AC9, AC11, AC14 | AC7, AC10, AC18 | 4 | 1, 2 |
| 7 | AC12, AC16, AC19 | AC11, AC14 | 3 | 1, 2, 4 |
| 8 | AC17 | all | 1 | 5 |

Batch membership is the dependency order; **commit membership is the merge order**, and they are not the
same axis. Batches 1–7 spread across commits 1–4 because a commit is a reviewable unit and a batch is a
"can be worked at once" unit. The binding constraint from the preplan still holds and is not negotiable:
**AC3 and AC4 ship in Commit 1 together** — relaxing the predicate without widening the disposition hides
declined successor remainders under a success type.

### File Mapping

| AC | Files |
|----|-------|
| AC1 | `src/coordinator/shutdown.ts`, `src/coordinator/lifecycle.ts`, `src/coordinator/index.ts`, `src/kb-daemon/daemon-main.ts`, `tools/simulation/core/backend.ts`, `tools/simulation/scenario-schema.ts` |
| AC2 | `src/coordinator/shutdown.ts` |
| AC3 | `src/coordinator/shutdown-settlement.ts`, `src/obligation/settlement.ts` |
| AC4 | `src/obligation/settlement.ts` |
| AC5 | `src/coordinator/live/admission.ts`, `src/coordinator/shutdown.ts`, `src/coordinator/composition/defaults.ts`, `src/coordinator/composition/types.ts` |
| AC6 | `src/coordinator/live/durable-transport.ts` |
| AC7 | `src/coordinator/shutdown-remainder.ts` |
| AC8 | `src/obligation/shutdown-abandonment.ts` |
| AC9 | `src/coordinator/shutdown-remainder.ts` |
| AC10 | `src/coordinator/bootstrap.ts` |
| AC11 | `src/coordinator/lifecycle.ts` |
| AC12 | `src/coordinator/lifecycle.ts` |
| AC13 | `src/coordinator/bootstrap.ts` |
| AC14 | `src/coordinator/lifecycle.ts` |
| AC15 | `src/coordinator/services/provider-proxy-recovery-policy.ts`, `src/coordinator/services/provider-proxy-set/index.ts` |
| AC16 | `tests/invariants/shutdown-teardown-containment.test.ts` |
| AC17 | `tests/integration/coordinator/fixtures/fatal-drain-backend.ts`, `tests/integration/coordinator/helpers.ts`, `src/transport/ipc/ensure.ts` |
| AC18 | `src/obligation/settlement.ts`, `src/coordinator/lifecycle.ts` |
| AC19 | `src/cli/errors.ts`, `docs/cli-errors.md`, `docs/architecture.md` |

**Same-file conflicts, sequenced rather than parallel.** `src/obligation/settlement.ts` carries AC3, AC4
and AC18 — AC3 and AC4 are in different batches already, and AC18 follows AC4. `src/coordinator/lifecycle.ts`
carries AC1, AC11, AC12, AC14 and AC18, which land in batches 1, 5, 6 and 7 — no two share a batch.
`src/coordinator/bootstrap.ts` carries AC10 and AC13; **AC13 is in batch 1 and AC10 in batch 5**, so they
do not collide. `src/coordinator/shutdown-remainder.ts` carries AC7 and AC9, which are in batches 5 and
6.

### Merge order

1. **Commit 1** — semantic foundation: typed reason, handoff mode, structured ledger entries, boundary
   exhaustion, the owner inventory. Verify with typecheck plus the settlement and lifecycle unit suites
   before any record or child work.
2. **Commit 2** — bounded finalization: staged child publication and its two obligations, the inline
   remainder record, max-aggregated exit contribution, bounded probe cleanup. Shares Commit 1's structured
   entry and lands together so no finalizer emits a partial record.
3. **Commit 3** — source-local recovery: independent source controllers, retirement as a reducer input.
   Can be developed beside Commit 2 after Commit 1, but merges after it so the fatal path already has a
   bounded terminal shutdown.
4. **Commit 4** — the surface and the docs: `lifecycleRefusalExit`, `ShutdownHoldExit`,
   `docs/cli-errors.md`'s exit-75 remediation, `docs/architecture.md`'s hard-mode sentence. Its own commit
   because it is the only part that changes what a reader is told to *do*, and it needs Commits 1–2 to have
   settled which holds remain reachable.
5. **Commit 5** — process proof: the test-only backend fixture depends on every implementation commit and
   is the branch's exit gate.

## Mathematical Specification (if applicable)

N/A — no numerical or algorithmic derivation is involved.

## Implementation Phases (with file:line references)

### Commit 1 — the typed reason, the mode, the predicate, the disposition

**These must land together.** Relaxing `authorityBlocked` alone makes `gate` return `settled()` whenever
`acceptance === null`, hiding declined successor remainders under a "done" type — a §11 defect introduced
by the fix.

- Define `ShutdownReason` in `src/coordinator/shutdown.ts` and propagate it through
  `LifecycleController.shutdown`, `LifecycleStartupContext.shutdown`, `shutdown`,
  `RunShutdownSequenceContext.reason`, `shutdownModeFromReason`, `CoordinatorServerController.shutdown`,
  `SimulationController.shutdown`, the IPC shutdown callback, and `IdleTimer.startWatching`. Normalize
  simulation `'cycle'` / `'simulation-shutdown'` at their ingress and type the production `'idle'` path.
  Today every adjacent contract is `string`, so changing only `shutdownModeFromReason` does not close the
  type hole. Delete the synthetic
  `shutdown('operator-recovery')` calls in `requestShutdownRetry`; an operator retry calls the stored
  ledger retry, which already retains the original reason and mode. The union rejects both `'fatal'` test
  fixtures and `'operator-recovery'`. *(AC1)*
- Add `'provider-proxy-lifecycle-fatal'` to the handoff arm. *(AC2)*
- `UndischargedRemainder` in `src/coordinator/shutdown-settlement.ts` loses `none` and free-form `via`;
  `successor-recovery` instead carries `SuccessorRecoveryEvidence`: `startup-adoption` with the retained
  durably published processes, `startup-store-recovery`, or `startup-liveness-recovery`. `remainderRole` is
  deleted together with its `blocking` role; `boundaryRemainder` is `process-exit` because process death is the final release when the
  explicit boundary cannot confirm. *(AC3, AC9)*
- `SettlementLedger.settleInitially` loses `authorityBlocked`; obligation execution is a one-shot phase.
  Remove `retryDeclined` from the shutdown transition: later invocations retry only acceptance and boundary
  prepare/commit, never the obligations. Acceptance refusal/mismatch is materialized as its own
  `process-exit` loss rather than routing back through obligation execution. *(AC3, AC18)*
- Replace `ShutdownDeferredFailure { label, error }` with an evidence-bearing ledger entry
  `{ label, remainder, settlement }`. Change the generic `failure` callback to receive the obligation's
  remainder, and use `options.boundaryRemainder` when materializing a prepare/commit failure. Neither
  `declinedFailure` nor lifecycle finalization is allowed to reconstruct owner or settlement from an
  `Error`. `SettlementDisposition.delegated` carries these entries; `settled` is reserved for a fully
  discharged ledger, and `gate` remains the only disposition constructor. Feed `acceptDelegatedRemainder`
  every declined entry rather than only the `delegable` ones, and drop the disposition-level `owner` — the
  entries carry their own. Otherwise `gate`'s `resolution.acceptance === null ? settled() : delegated(…)`
  makes AC4 unreachable on the two paths that matter: a successor-only decline, and `retryCleanTransfer`,
  which commits with `acceptance: null` by construction. *(AC4, AC9, AC16)*
- `acceptShutdownDisposition` and `LifecycleShutdownRecovery` in `src/coordinator/lifecycle.ts`:
  `waiting-for-operator` and `owner.kind: 'lifecycle-shutdown-hold'` are deleted; `automaticRetry` keeps
  `scheduled`. The only remaining `held` is a boundary failure (`retryBoundaryTransfer`), whose `hold` names `authority-release-settlement` with a bounded `retryAfter`.
  `SettlementLedger.boundaryTransferAttemptsStarted` counts the initial transfer as 1 and the two retry
  closures as 2 and 3 through `attemptBoundaryTransfer`; attempt 3 converts a failed boundary into a named
  loss instead of another hold. The bounded exhaustion lives inside `gate` and has a named caller.
  `LifecycleShutdownDisposition` gains the variant
  AC18 requires, so `settled` and `delegated` no longer collapse into one `{ disposition: 'finalized' }`.
  Add `isLifecycleShutdownTerminal` and replace exact-`finalized` checks in the lifecycle continuation,
  `src/coordinator/index.ts`, `tools/simulation/core/backend.ts`, and abandonment.
  *(AC14, AC16, AC18)*

Assign every current `owner: 'none'` site before deleting the variant. Conservative `process-exit` means
"completion was not proved and this process is naming the loss"; it does not claim that exit performs the
unfinished cleanup.

| Obligation | Owner after this commit | Evidence or named loss |
|---|---|---|
| Authority-release boundary | `process-exit` | Explicit close was unconfirmed; process death releases local authority |
| Recovery coordinator teardown | `process-exit` | In-memory recovery teardown has no successor-readable receipt |
| KB child shutdown | `process-exit` | No durable KB-child adoption record exists — but `startKbDaemonParentWatchdog` (`src/kb-daemon/daemon-main.ts`) makes the daemon self-exit on observed parent absence, so the named loss is the coordinator's confirmation, not the child |
| Provider-operation mutation drain | `process-exit` | The aggregate includes admission state not proved by a saga row |
| Provider-host hard shutdown | `process-exit` | The aggregate is not wholly represented by successor-readable set evidence |
| Hard-mode child termination | derived at settlement | `successor-recovery` with `startup-adoption` evidence when every retained child is durably published, otherwise `process-exit` |
| App-server handoff quiesce | `process-exit` | Unconfirmed in-flight app-server writes are named as lost |
| Provider-host handoff drain | `process-exit` | Closing hosts and representation-release holds are not all durable successor evidence |
| Process-incarnation probe shutdown | `process-exit` | Observation-only lease; exit is allowed after the bounded probe grace |
| Lifecycle-reactor disposal | `process-exit` | Local reactor disposal has no successor |
| Store-epoch sweep cancellation | `process-exit` | Local sweep cancellation has no successor |
| Store-services availability check | `successor-recovery` | Typed `startup-store-recovery` evidence replaces the free-form string |
| Crashed-job terminalization | `successor-recovery` | Typed `startup-liveness-recovery` evidence replaces the free-form string |

The hard-mode aggregate child row is replaced by the two child obligations in Commit 2. The
ownership-inventory invariant enumerates this table and fails on either `none` or an untyped successor.

### Commit 2 — the owners, the record, the exit

- **Child publication state.** In `publishWrapperSpawned` (`src/coordinator/live/durable-transport.ts`),
  cleanup registration happens before the optional, fallible `onRuntimeRecord` callback. Represent that
  ordering explicitly: `pending-wrapper-identity` → `observed-unpublished` → `durably-published`.
  Promotion to `durably-published` occurs only after the callback returns successfully, and its evidence is
  the job id, `DurableCliRuntimeRecord.pid` and the leader incarnation — the three things
  `appendRuntimeStarted` commits atomically with the provisional runtime meta. The durable-cli containment
  status row is not part of that evidence; it is keyed by job id but written by `jobs/shell/launch.ts` and
  by the adoption path, not here. A thrown or absent callback leaves an `observed-unpublished` process under
  `process-exit`; cleanup retention is never treated as durable proof. Latch the state established by
  `onRuntimeRecord`, attempt `publishProcessIdentity`, and place `releasePendingLaunch` in a `finally` path
  covering both callbacks. A retained or throwing identity publication after successful runtime publication
  remains `durably-published`; either failure path leaves exactly one staged owner.
- **Two ledger tasks.** Split `LaunchCoordinator.terminateAll` into an ordered staged API: pending plus
  observed-unpublished settlement first, durably-published child termination second.
  `buildHardShutdownConsequences` registers each stage as its own obligation. The first carries
  `process-exit`; the second derives its remainder at settlement — typed `startup-adoption` successor evidence
  listing every retained child when all are durably published, otherwise `process-exit`. Stage 1 alone owns and
  sets `shutdownRequested`, drains the queued launches, and snapshots pending launches. Because every
  admitted durable launch registers pending synchronously after admission and before its first `await`, the
  latch closes admission before the snapshot and stage 2 cannot create a new pending launch. Pin that proof
  with an invariant test at the registration boundary. `dispositionAtDeadline()` becomes two disposition
  types, not one consumed twice; `childTerminationConfirmation` and `retainedChildActions` split with them.
  Delete `terminateAll` — its only production reference is `composition/defaults.ts`'s `terminateAllFn`
  injection, and every other caller is a test. *(AC5, AC6)*
- **The remainder record.** New `shutdown-remainder.v1/<instanceId>.json` in the same `runDir` as the abandonment
  family, bounded append-and-replace-by-instance shape and tolerant reader. Writing replaces the same
  instance; the successor boot path later retains the newest 32 instance records as atomic groups. The serialized entries are the
  ledger's `{ label, remainder, settlement }` values directly. Shape precedent: `HANDOFF_CAPSULE_FILENAME`
  in `src/provider-proxy/handoff-capsule-discovery.ts` — a generation admitted by address, derived from
  `SUPPORTED_HANDOFF_CAPSULE_VERSIONS`. *(AC7, AC9)*
  - **Why a new address, not the existing family.** `readShutdownAbandonmentStatus`
    (`src/coordinator/shutdown-abandonment.ts`) parses through
    `createShutdownObligationAbandonmentReceiptParser` (`src/obligation/shutdown-abandonment.ts`), strict,
    with `disposition: z.literal('abandoned-unconfirmed')` and a closed subject enum. Nothing new can go
    in (§10). *(AC8)*
  - **Why keyed by `label`.** The abandonment subjects are an enum because they are *arguments to a
    command*. A remainder record is diagnostic, and a closed enum there needs extending for every
    obligation the ledger ever gains — which is exactly why the current enum lacks store-epoch sweep,
    ownership-checker, components, hooks, discuss-store and the connection/stream obligations. `label` is
    the identity the ledger already uses in `deferredFailures`.
  - **Why the run directory.** The store is finalized by the closing obligations before the boundary; at
    exit the run directory is the only writable durable address.
  - **Written inline, and why no helper.** One synchronous `runtime.storage.writeAtomicSync` at `0o600`, on
    the coordinator thread after creating the version directory.
    A `false` return or a throw is the typed `refused` of AC12.

    An earlier draft put this in a separate `coral-shutdown-remainder-writer.cjs` process to bound a
    filesystem stall. The measured stall class is `jbd2_log_wait_commit`: the explicit commit wait entered
    by `fdatasync` and directory sync inside `writeAtomicDurableSyncNode`. The non-durable atomic writer drops
    both calls. Its open and rename, and the following discovery read and unlink, remain journal-bound but
    join the running transaction and return without asking the kernel to wait for its commit. The helper is
    therefore unnecessary once the record delivers only the ordering AC7 requires.

    What the helper costs, against that: a **fifth** released executable that must join
    `scripts/build-server.mjs`'s `entryPoints`, `receiptInputs`/`receiptOutputs`, `bridgeFiles`,
    `package.json` `files` and a source-mode fallback; and `strictBundleManifestSchema`
    (`src/infra/bundle-manifest.ts`) is `.strict()` over four closed hash fields, so adding a fifth makes an
    older build's reader *reject* the manifest — §10's additive-only rule, violated by the fix. It also
    forces `finalizeStoppedLifecycle` and `acceptShutdownDisposition` async, which they are not and which
    AC11 forbids. And the kill mitigation is false at one of two sync points: `writeAtomicDurableSyncNode`
    is `fdatasync` → `close` → **`rename`** → `syncDirectoryDurable`, so a helper killed during the
    directory sync has already published, while a helper blocked in uninterruptible kernel wait does not
    die on `SIGKILL` at all — it is reparented, and on device recovery renames a pre-stall snapshot over
    whatever a *successor* coordinator has since written to the same append-and-replace-by-instance file.
    That is a lost update the single-writer abandonment family cannot have, and the atomic writer derives its
    temp name as `${path}.tmp`, so "a unique temporary path" is not even expressible through it.

    The requirement AC7 actually carries is **ordering**, not survival of a power cut. Across a power cut
    every obligation the record names — a proxy set, a durable child, a saga row — has been discharged by
    the same power cut, and the run directory's socket and discovery state are stale anyway. Ordering is
    free: the write is the statement before the withdrawal. The non-durable atomic writer omits the explicit
    journal commit waits; open, rename, read, and unlink remain journal-bound without requesting a commit.

    An uninterruptible withdrawal call is the real version of the stall problem and remains outside what an
    in-process deadline can solve. Ordinary returned discovery read/unlink errors are in scope: convert them
    to a typed `refused` outcome, log the stale address, record exit contribution `1`, return
    `finalized-with-losses`, and request exit from a `finally`-equivalent path. *(AC7, AC11, AC12)*

- **Exit code.** Bootstrap records the ledger's contribution (`0` for `settled`, `1` otherwise) through
  `recordExitCode`, then requests exit with the accumulated maximum. Precedent:
  `createCoordinatorShutdownSignalHandler` records `1` on a repeated signal. Remove the wording and tests
  that equate final code solely with the ledger; an earlier nonzero contributor remains nonzero. *(AC10)*
- **Order.** `finalizeStoppedLifecycle`: `setLifecycle('stopped')` → write the record → attempt the typed
  `removeBackendInfoIfOwnerFn` result → on refusal, add its named loss, record contribution `1`, and make one
  best-effort same-instance rewrite → in `finally`, `onStopped` / `acceptance.requestExit`. A withdrawal
  refusal changes the terminal and max exit contribution but cannot bypass the exit request. Say what you
  left before withdrawing the address others use to find you. *(AC11, AC12)*
- **Bound the exit gate.** `createBootstrapProbeExitGate.requestCleanup` awaits
  `terminateProcessIncarnationProbes()` with no signal. With no child attempts, that function awaits
  `leaseSettlement` directly, so a Linux filesystem probe can hang before a `hold` is returned. Give the
  initial call an abort controller armed for `SIGTERM_GRACE_MS`; on `hold`, log child and childless-lease
  subjects and call `process.exit` without observing `untilSettled`. Tests cover both a child that never
  closes and a childless lease whose probe never settles. **The probe is observation-only** —
  `ArmedEnforcerOptions` states the same rule for its own probes — so it holds nothing exit would betray.
  *(AC13)*

### Commit 3 — a fatal retires its source

`retireFatal` in `createProviderProxyRecoveryDispatcher` marks the whole turn retired, invokes every
registered aborter and disposes all cached evidence; the hold's `fatal` sink in
`#runReattachmentHoldAttempt` only nulls `attemptAbort` and re-arms nothing, so the slot parks.

- Key aborters by `sourceId`; `retireFatal` retains provenance and aborts one. Its
  `disposeCachedEvidence()` call takes the surviving source's scope: today the no-argument form walks
  `exactSources` **and** `reattachmentSources`, routes every cached `evidence` through
  `sinks.disposeLateEvidence`, and for this hold that is `#releaseLateReattachmentEvidence` →
  `releaseProviderProxySetContainmentProofFence`. A redemption fatal therefore releases the containment-proof
  fence the surviving absence source's decision depends on, and erases the evidence the new rule must read.
- Extend the local fatal sink to receive that provenance. `submit`'s `if (retired) { … return; }` guard
  becomes per-source; late evidence from a retired source is still disposed.
- For both reattachment seams — `control-reattachment` and `control-reattachment-hold`, which share
  `reduceControlReattachment` — retire the offending source without setting the turn's `retired` flag.
  Other recovery seams keep fail-stop. (**Corrected in review:** the plan first said hold-only; the rule
  is a property of the two-source reducer, not of the hold's name, and restricting it would leave the
  first attempt's redemption fatal parking the same slot with the same two sources.) Precedent:
  `foreign-capsule-retirement` already refuses fatality per seam. Retirement records the source and immediately calls
  `reduceControlReattachment`; it is an input transition, not state that waits for another producer event.
- In `#runReattachmentHoldAttempt`, create separate redemption and absence `AbortController`s — both
  `turn.start` calls currently pass one shared `abort.signal`. Store an aggregate attempt-cancel function
  on `ControlReattachmentWindow` for clearing, deadline, and external cancellation; a source aborter
  touches only its own controller. The aggregate must re-point at the **reap** controller during the
  absence-reap phase, which replaces `window.attemptAbort` with a fresh `reapAbort` — a third use of that
  single slot the earlier draft did not account for.
- `ControlReattachmentWindow` latches `retiredSources`; later attempts start only unretired sources. Teach
  `reduceControlReattachment` that a retired peer is terminal, **written around the branches that hang.**
  Reap-required absence is checked first and already decides with no peer, so it is not the gap. With
  redemption retired the two that never decide are (a) absence evidence that does not require reap and
  (b) absence `unavailable`; both fall through `if (redemption === undefined) return`. Each must reach a
  terminal or a scheduled retry. The mirror (unavailable redemption after absence retires) is covered too.
  The motivating fatal comes from the redemption source — both `role-control`
  `provider_proxy_control_redemption_contract_violation` branches — so a "fatal redemption plus
  reap-required absence" test passes today and proves nothing.
- Re-arm `#scheduleReattachmentHoldRetry` **once, from the reducer's terminal**, after the last unretired
  source settles — not from the `fatal` sink, which two live sources can each reach. It assigns
  `slot.retryTimer` with no clear, so two arms leak a timer past `#clearControlReattachment` and two
  overlapping attempts each take a fence; clear any pending `slot.retryTimer` first regardless. *(AC15)*

Settle, while here, which rule is real for the sink's absence branch: it handles
`evidence.kind !== 'reap-required'` by releasing the fence and retrying, but `containmentProofRequiresReap`
means the reducer can never deliver that case. Do not add a third rule on top of two that disagree.

The hold's own vocabulary names its four exits — `'control-reattachment-bound-live-claims'` in
`src/provider-proxy/operator-disposition-vocabulary.ts`: *"must preserve claims until redeemed control,
confirmed absence, explicit containment, or representation-only abandonment"*. A redemption fatal removes
exactly one of them; aborting the absence observer as well leaves a hold with no reachable exit.

**Honest value**: every fatal escalates to shutdown (`effects.fatal` always calls
`options.fatalSink.fatal`), and under handoff the drain does not wait on the set — so this buys one boot
of earliness inside a ≤30 s window. It is kept because a parked slot is a §11 defect whether or not
anything currently waits on it.

### Commit 4 — the surface stops soliciting

The branch removes the state, so it must remove the remedy that state existed for. `lifecycleRefusalExit`
(`src/cli/errors.ts`) prints *"End the held obligation with `coral-cli backend shutdown-recovery abandon
<subject>`"* and *"A drain that does not clear on its own will not clear by retrying either."* Its reader is
the LLM driving the session (§12), which will run what it is given, and the second sentence becomes false the
moment the drain ends inside the budget when runtime/filesystem calls return. Both branches instead report
the bounded asynchronous wait and when to retry.

The function's constraint comment — *"A held shutdown does not end on its own, and a hook retrying on exit 75
alone would retry forever — so both branches must name the operator exit that ends one"* — is deleted or
replaced, not edited to keep its description true; `.claude/rules/conventions.md` treats editing a comment to
survive the diff beneath it as the defect, not the repair. Both the exit-`75` row and the “503 vs
Unreachable” shutdown paragraph in `docs/cli-errors.md` lose the same remediation. Remove imperative
`coral-cli abort jobs …` text from `childTerminationConfirmation` before its detail can enter the remainder
record; this is scoped to shutdown serialization and does not remove commands for separate live states.

Retire `ShutdownHoldExit`'s `durable-operator-abandonment` and
`required-cleanup-capability-confirmation-or-durable-operator-abandonment` members and all current-build
shutdown action producers (`defaultHold` itself is deleted under AC3's correction, not narrowed). Retain the CLI command, schemas, and IPC route
for mixed-version operation against an older daemon; a current coordinator has no producer and answers
`not-held`/`not-offered`. *(AC19)*

### Commit 5 — the real-process proof

`tests/integration/coordinator/helpers.ts` supplies `spawnCoordinator`, `waitForDiscoveryRecord`,
`readDiscoveryRecordForHome`, `coordinatorFilesForHome` and `waitForProcessExit` — discovery and exit
assertions, **not** socket assertions; the socket probe is new. Add
`tests/integration/coordinator/fixtures/fatal-drain-backend.ts` and build it with esbuild into the test's
temporary fixture only; it is never copied to `clients/bridge`, package files, or a release artifact.
*(AC17)*

The fixture imports the production bootstrap/coordinator modules. A programmatic-only composition option
captures the exact `onProviderProxyLifecycleFatal` closure; there is no environment variable, argv flag, or
IPC route in the production bundle. The fixture listens on inherited fd 3 for one trigger byte and invokes
that closure with a deterministic corrupt-evidence error. It passes `disposeLifecycleReactor: () => new
Promise(() => {})` as the named unresolved `process-exit` obligation and a programmatic handoff budget small
enough for the test; the production default remains 30 seconds.

1. Spawn the fixture as a real coordinator process with fd 3 connected to the parent.
2. Wait for its real discovery record and prove the Unix socket accepts connections.
3. Write the trigger byte and observe the production fatal callback request
   `'provider-proxy-lifecycle-fatal'` shutdown.
4. Observe the lifecycle-reactor obligation exhaust and the structured remainder write complete or refuse.
5. Assert `waitForProcessExit` returns a non-zero **code**, not a signal.
6. Assert the socket no longer accepts connections and the owned discovery record was removed.
7. Issue a subsequent mutating command and prove the production backend bundle spawns a fresh coordinator.

**The socket has two non-serving exits, and the proof names which one it observed.** `process.exit` does
not unlink a Unix socket file: a process that dies with its listener open leaves a path that answers
`ECONNREFUSED`, and `bindSocketAtAddress` (`src/transport/ipc/server.ts`) clears that path through
`clearStaleSocket` — the next binder is the sole cleanup authority for it. **Corrected during review:** an
*orderly* drain does not die that way. It reaches `closeIpcServer` (`src/transport/ipc/server.ts`), and Node
unlinks a listening unix socket's path when `server.close()` completes (measured on Node v26.8.2, darwin),
so the drain AC17 exercises ends with `ENOENT`, not `ECONNREFUSED` — the earlier "not `ENOENT`" predicate
would have failed the branch's own proof on every clean drain, and the predicate before it passed by
collapsing the two exits. Per §11 the probe is three-valued (`accepting | released | unlinked` in
`tests/integration/coordinator/helpers.ts`); the fatal-drain test asserts `unlinked`, which a drain that
skipped `closeIpcServer` would fail. A mocked `closeIpcServerFn` proves only a call. `probeSocketReleased`
in `src/transport/ipc/ensure.ts` stays private; the test owns its own probe.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Relaxing the predicate without widening the disposition** hides declined successor remainders under `settled`. | The two land in **commit 1 together**; AC4 asserts a declined successor pass returns `delegated`. |
| **`hooks.onShutdown(mode)` now receives handoff for the fatal.** | Verified and **it is a real behaviour change, not a non-event**: `clearAllDiscuss` (`src/discuss/shell/live-registry.ts`) aborts every live session controller and clears `context.sessions` and `registry.contexts` in **both** modes; `mode === 'hard'` gates only `persistAbortEnd`. So under handoff the fatal aborts and clears every live discuss session with **no durable abort-end**, leaving them to the successor's `resumeLoop` — the same exposure every `sigterm` handoff already carries. A named regression test pins that branch. |
| **The boundary's residual hang surface.** | `stopHeartbeats` has two implementations — `set-authority.ts`'s three `.stop()` calls and `control-redemption.ts`'s `heartbeatAssembly.stop()` installed by a promoted reattachment — and both are synchronous (`clearInterval`), so it cannot hang. The surface that remains is the boundary's other capability, `initiateControlClose`. IPC/control close failures remain ledger settlements with retry bounds and, after exhaustion, a structured boundary `process-exit` entry. |
| **The diagnostic filesystem can enter an uninterruptible sync during the record write.** | Accepted and stated, not engineered around: `removeBackendInfoIfOwnerFn` one line later does `readFileSync` + `unlinkSync` in the same run directory, unbounded and undelegatable, so no treatment of the record write can deliver "exit cannot be stalled". A helper process was considered and rejected — see Commit 2, *Written inline, and why no helper*. Bounding an uninterruptible withdrawal is tracked separately. |
| **Discovery withdrawal returns a read or unlink error.** | Unlike an uninterruptible syscall, this is controllable: the typed refusal is logged, contributes exit code `1`, yields `finalized-with-losses`, and exit is requested from the finalizer's `finally` path. |
| **The handoff path inherits `docs/todo/coordinator-process-disposition.md`** — a successor may terminalize a carrier that is still alive. | Accepted: every `sigterm` handoff already inherits it, and hard mode's alternative is killing the carrier outright. Noted, not fixed here. |
| **A reproducible fatal recurs in each successor** (`#recoverExactCapsule` → `retireFatal` → `onProviderProxyLifecycleFatal`). | Bounded by the enforcers: successors die, the holder is observed absent, the set is reaped within one adoption window, the capsule becomes retirable. Under hard mode every iteration also reaped every healthy set; under handoff it costs the bad set only. |
| **Test reversal is large** — AC1 alone reaches **19 files** plus `tools/`, not three. | Enumerated in Verification Steps. Eleven distinct reason literals are in use and every one takes hard mode today, so the union's members must keep them on the hard arm; `tools/simulation`'s `reason: z.string().optional()` is typechecked (`tsconfig/typecheck.json` includes `tools/**`) and narrows explicitly per §8. The typed reason makes the misleading `reason: 'fatal'` harnesses fail loudly rather than stay green. |
| **The branch falsifies two shipped documents and a CLI constraint comment.** | `docs/architecture.md` states hard mode "is reached only by a `sigint` shutdown or an internal provider-proxy lifecycle fatal" — AC2 falsifies it. `docs/cli-errors.md`'s exit-`75` row and `lifecycleRefusalExit` both solicit `backend shutdown-recovery abandon` on the premise that a drain never clears by itself. Commit 4 owns all three. (AC19) |
| **`disposeLifecycleReactor` never runs in production** — with no incarnation probes registered, `requestExit` calls `process.exit` synchronously inside `finalizeStoppedLifecycle`, before `shutdown()`'s promise resolves to `src/coordinator/index.ts`. | Not this branch's defect, but it is what "post-boundary continuation" actually means: nothing after the boundary may retry, because nothing after the boundary reliably runs. |
| **No operator will notice a partial fix.** (§12) | AC17 is the only criterion that proves the claim end to end; a green unit suite with a mocked close proves nothing about a process that must die. |

## Verification Steps

Full gate, per `.claude/rules/conventions.md`:

```
npm run format:check && npm run lint && npm run typecheck:tests && npm run knip && npm run build
npm test
npm run test:integration
npm run test:store-reset:integration
npm run verify:store-reset-build
npm run test:e2e:build && npm run test:e2e:lifecycle
```

**Known rework — these assert today's behaviour and must reverse:**

- `tests/unit/coordinator/shutdown-budget.test.ts` — the pinned ledger tests, including
  `retains authority while a successor-recovery obligation remains declined`; every synthetic
  `owner: 'none'` fixture; the hard-mode harnesses built with `reason: 'fatal'`, which AC1 makes a
  typecheck failure.
- `tests/unit/jobs/reconcile/lifecycle-recovery.test.ts` and
  `tests/unit/jobs/reconcile/recovery-coordinator-shutdown.test.ts` — the
  "finalized or waiting-for-operator" terminals become the two terminal variants; remove branches accepting
  `automaticRetry.status === 'waiting-for-operator'`. These two files are the *only* readers of
  `automaticRetry.status` anywhere, which is why AC14 is cosmetic without its counter half.
- **Every `shutdown('<literal>')` call site** — 19 files across `tests/unit`, `tests/integration`,
  `tests/simulation` and `tools/simulation/adversarial.ts`, carrying `'test'`, `'test-cleanup'`,
  `'test cleanup'`, `'test-complete'`, `'test-mid-recovery'`, `'test-after-poller-live'`, `'teardown'`,
  `'done'`, `'abort-verified'`, `'signal_abort'`, `'queue_shutdown'` beside the production
  `'replaced'` / `'sigterm'` / `'sigint'`, plus production `'idle'` and simulation `'cycle'` /
  `'simulation-shutdown'`. Each must land on or normalize to a union member that preserves the mode it takes
  today. Type `CoordinatorServerController.shutdown`, `SimulationController.shutdown`, the IPC callback,
  and the idle callback; `tools/simulation/runner.ts`'s `step.reason` ingress narrows rather than casts.
- `tests/unit/coordinator/services/provider-proxy-recovery-policy.test.ts` — fatal-turn tests must
  distinguish whole-turn retirement from `control-reattachment-hold` source retirement. The new cases are
  the ones that **hang today**: fatal redemption plus absence evidence that does *not* require reap; fatal
  redemption plus absence `unavailable`; and the mirror, fatal absence plus unavailable redemption. A case
  built from fatal redemption plus reap-required absence passes before the change — the reducer tests that
  branch first — so it is not evidence. Add a case proving a redemption fatal leaves the absence source's
  cached evidence and its containment-proof fence intact. Run every named pair in both orders, especially
  survivor-first/fatal-last, and assert retirement itself reevaluates the reducer.
- `tests/unit/coordinator/services/provider-proxy-set/*` — prove only one retry timer is ever armed per
  hold slot with both sources live, and that a pending `slot.retryTimer` is cleared before re-arming.
- `tests/unit/coordinator/shutdown-abandonment.test.ts` — v1 assertions stay as compatibility tests;
  the new address is tested separately in `tests/unit/coordinator/shutdown-remainder.test.ts`.
- `tests/unit/coordinator/bootstrap.test.ts` and `tests/unit/infra/*process-incarnation*.test.ts` — add a
  childless lease whose filesystem probe never settles and prove the initial cleanup deadline reaches exit.
- `tests/unit/coordinator/live/durable-transport.test.ts` (or the nearest existing durable-launch suite) —
  throw from runtime publication after wrapper identity is observed and assert the child remains
  `process-exit`, never typed as successor evidence, and that it is counted by exactly one staged
  obligation rather than by both `cleanupHandles` and `pendingDurableLaunches`. Also make identity
  publication return `retained` and throw after successful runtime publication; both remain
  `durably-published`, release pending in `finally`, and have one owner.
- New remainder-record tests — a written record, a `false` return, and a throwing write; the last two are
  `refused`, are logged, and reach `removeBackendInfoIfOwnerFn` and exit anyway. Plus a reader test: one
  undecodable entry is skipped and counted, and the remaining entries still parse. Write more than 32
  instance records and assert whole-instance oldest-first eviction and same-instance replacement.
- New settlement tests — a successor-only declined pass returns `delegated` carrying the entries; the
  boundary-exhaustion path does not return `settled`; no container carries an owner contradicting its
  entries. Assert an obligation gets exactly one attempt; preparation failure and acceptance refusal do not
  rerun it. Drive the production lifecycle continuation with a never-settling control close and assert the
  initial transfer is attempt 1 and the third declined transfer becomes a named loss.
- New lifecycle test — a shutdown with named losses and a fully discharged shutdown return distinguishable
  `LifecycleShutdownDisposition` values. Assert both terminals stop automatic retry; the losses terminal
  closes store services, cleans a simulation root, and cannot offer abandonment. Inject non-`ENOENT`
  discovery read and unlink failures separately and prove each logs, contributes `1`, returns
  `finalized-with-losses`, and still requests exit. (AC11, AC12, AC18)
- `src/cli/errors.ts` tests and `docs/cli-errors.md` — no `shutdown-recovery abandon` remediation on the
  draining or `held-past-release-budget` branches; both relevant documentation occurrences name the bounded
  wait instead. Assert new-build producers never offer abandonment while the retained CLI/IPC route can
  still send the old request and a current coordinator answers `not-held`/`not-offered`. Assert serialized
  shutdown remainder details contain no imperative `abort jobs` command. (AC19)
- New real-process integration — build the test-only fatal entrypoint, trigger through fd 3, and assert every
  AC17 process/socket/discovery/fresh-spawn outcome.

**Invariants:**

- `tests/invariants/shutdown-teardown-containment.test.ts` — substance unchanged; renamed identifiers only (AC16, see the correction there).
- `tests/invariants/lifecycle-phase-monotonic.test.ts` — passes unchanged; already permits
  `draining → stopped`.
- `tests/invariants/provider-proxy-recovery-policy.test.ts` — **deliberate revision** for conditional
  producer starts and the source-local fatal rule.
- **New**: an ownership-inventory invariant proving no `owner: 'none'` remains and every
  `successor-recovery` remainder carries typed evidence rather than only a `via` string. The inventory is
  exhaustive over the 13 rows above: 11 production `owner: 'none'` sites (`boundaryRemainder` in
  `shutdown-settlement.ts` plus 10 in `shutdown.ts`) and the 2 `successor-recovery … via` sites.

**Documentation** (`.claude/CLAUDE.md` requires docs to move with ownership/behaviour changes; the earlier
Execution Order touched no `docs/`):

- `docs/architecture.md` — the sentence "Hard mode is real and does reap every live set, but it is reached
  only by a `sigint` shutdown or an internal provider-proxy lifecycle fatal" is falsified by AC2.
- `docs/cli-errors.md` — both the exit-`75` row and the “503 vs Unreachable” paragraph lose the
  `shutdown-recovery abandon` remediation (AC19).
