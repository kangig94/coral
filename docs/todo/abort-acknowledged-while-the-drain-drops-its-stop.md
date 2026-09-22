# TODO — an abort is acknowledged while the drain drops its stop

**Status**: open. Filed 2026-09-22 from a design pass on #367's remaining findings. The design splits into a first stage and a remainder, below.

## The defect (on `main`)

**Window B.** Once `buildProviderOperationMutationDrainObligation` (`src/coordinator/shutdown.ts`) stops the provider-operation reconciler, and until the IPC listener closes, `ProviderOperationReconciler.#canMutate()` is false for an IPC request.

`jobs.abort` is still admitted there, through the catalog route `ipc.jobs.abort.drain-recovery`. The call chain is:
1. `AbortRegistry.abort` fires `controller.abort()`.
2. The `registerLaunchAbort` listener (`src/jobs/shell/launch.ts`) calls `operations.stop`.
3. `requestStop` returns silently.

As a result:
- no stop intent is written, no `operation.stop.v1` is sent, and nothing is logged;
- the caller reads `aborted`;
- in handoff mode the proxy set survives, and the job keeps running under the successor.

Two facts constrain the fix:
- Writing the stop anyway is impossible: `compareAndSwapProviderOperation` goes through `runSync`, which throws once admission stops accepting.
- HTTP is not affected: `/jobs/abort` is refused 503 before dispatch while draining.

The designed exit cannot help today. `issueWithSuccessorAfterLifecycleRefusal` re-issues only a request refused before any effect. And even a successor answers `Not found` for a job it adopted by saga attachment, because `createCoordinatorControl.abortJobs` (`src/coordinator/composition/job-control.ts`) consults only generation-local registries. A test against a real saga row with no local registry reproduces the `Not found`.

## Invariant

When a coordinator acknowledges an abort of a saga-owned job, the saga row carries that stop. When it cannot make that true, it answers before any effect and names the successor as owner. Any coordinator holding saga admission can abort any saga row it holds, whether or not it launched the job.

The decision lives in `ProviderOperationReconciler`, the one owner of both facts: whether a row needs a write, and whether it may write. Classification and action happen in one call with one admission check, so a refusal is always before any effect.

## First stage

- `requestStops(jobIds, cause): ProviderStopDecision` answers either:
  - `admission-closed`: nothing written for any job;
  - or per job `no-operation` / `recorded` / `unrecorded`.
- `abortJobs` stops the saga first and returns `AbortDecision = answered | successor-owned`.
- Transport answers `successor-owned` as the canonical lifecycle refusal: the IPC `lifecycleRefusalResult`, or HTTP 503. Shipped clients already re-issue that once to a successor.
- A `recorded` job that no local registry claims is reported aborted, which makes adopted jobs abortable.

The first stage changes no durable shape, and `AbortResult` stays unchanged on the wire. When it lands, rewrite this entry and its index row down to the remainder below.

## What remains after the first stage

1. **Fan-out aborts still drop.**
   - The failure drain in `src/workflow/wait.ts`, `src/workflow/stale-recovery.ts`, and `src/coordinator/services/workflow-recovery-descendants.ts` reaches the saga only through the launch listener, whose `requestStop` discards the decision with `void`.
   - Route them through the coordinator-wide abort, consuming `AbortDecision`.
   - Then delete the listener, `requestStop`, and `LaunchOrchestratorDeps.operations`.
2. **Classification is coarse.**
   - While admission is closed, any job with a row refuses the whole request, even when its row already carries the stop.
   - Split `#requestControlIntent` into a pure plan and an apply step, so only a stop that still needs a write is refused.
   - A row already carrying the stop answers `recorded`. `settlement-pending` answers `settling`, not "aborted".
3. **Mixed requests are refused whole.** A saga job named together with a held local job goes entirely to a successor that cannot start until the drain ends. Per-job routing needs a CLI that can re-issue a subset.
4. **Older successors.** A successor built before the first stage still answers `Not found` for a handed-off job.

## Rejected

| Alternative | Why rejected |
| --- | --- |
| Write the stop despite closed admission | Breaks the one gate #348 built. The drain obligation promises that no saga mutation follows it. |
| Turn the drop into an `AbortRegistry` hold | The local effect has already happened, so a re-issue is forbidden. A second abort would call `abandon()`. |
| Refuse every abort while draining | Removes the drain-recovery abandonment exits (#359, #363). Only the reconciler knows whether a job needs a saga write. |
| Export `canRecordStop(jobId)` | Splits classification from action, and the consumer re-classifies raw inputs (§11). |
| Refuse in transport before dispatch | Transport would read provider-operation state, and transport is carriage only. |
| A `job.abort-requested` Journal event | A second home for stop intent, and a new durable shape older builds must tolerate. |

## Related

[`provider-operation-shutdown-quiescence.md`](./provider-operation-shutdown-quiescence.md) predates #348. The design pass reported that #348 built the shared gate that entry asks for, and that its evidence no longer matches the tree. Its regression requirements were not checked against #348's tests. Verifying and rewriting it is separate from this entry.
