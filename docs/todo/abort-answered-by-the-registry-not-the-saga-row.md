# TODO — an abort the saga row owns is still answered by the local registry

**Status**: open. Filed 2026-09-22 from the #367 drain-abort work. Three independent members; each can ship on its own.

## Invariant

When a coordinator acknowledges an abort of a saga-owned job, the saga row carries that stop. When it cannot make that true, it answers before any effect and names the successor as owner.

A direct `jobs.abort` already meets the refusal half. `ProviderOperationReconciler.requestStops` and `createCoordinatorControl.abortJobs` (`src/coordinator/composition/job-control.ts`) never acknowledge a stop they could not record, and once provider-operation mutation admission has closed they refuse before any effect so a successor records it. What they do not yet do everywhere is **answer from the row**: member 2 is reachable through a direct request, and members 1 and 3 are reachable elsewhere.

## Members

### 1. Fan-out aborts still acknowledge and drop

The failure drain in `src/workflow/wait.ts`, `src/workflow/stale-recovery.ts`, and `src/coordinator/services/workflow-recovery-descendants.ts` aborts through the per-project `ExecutionService.abort`. That reaches the saga only through the `registerLaunchAbort` listener (`src/jobs/shell/launch.ts`), which calls `requestStop`, and `requestStop` discards the decision with `void`.

Once admission has closed during a drain, a workflow's child stop is dropped while the workflow reports it aborted. The child keeps running under the successor until the successor's descendant recovery reaches it.

**To do:**
- Route these callers through the coordinator-wide abort and consume `AbortDecision`.
- Then delete the listener, `requestStop`, and `LaunchOrchestratorDeps.operations`.

### 2. A direct abort is labelled by the registry where the row disagrees

`#requestControlIntent` answers `wrote | already-carried | not-applicable`, and `not-applicable` defers to the local registries. Three phases take no stop while a launch `AbortRegistry` registration can still exist:
- `settlement-pending`, before the launch removes its registration: the job is already terminal;
- `prestart-cleanup-pending` with a `terminal-failed` directive: it terminalizes as failed;
- `executing` under `rekey-refusal-containment`: it is contained and terminalizes as failed.

A direct `jobs.abort` then prints `Aborted` while the row keeps its own outcome. None leaves a job running; the label is wrong.

Separately, while admission is closed, any job with a row refuses the whole request, even one whose row already carries the stop.

**To do:**
- Split `#requestControlIntent` into a pure plan and an apply step.
- Answer from the row's disposition: `recorded` when it already carries the stop, and a `settling` or failed disposition rather than `aborted`.
- Refuse only a stop that still needs a write.

### 3. Mixed requests are refused whole

A request naming a saga job together with a job that has no saga row and is owned only by the incumbent's local registry goes entirely to the successor, which answers `Not found` for that job. One example of such a job is one under an abort hold. Per-job routing needs a CLI that can re-issue a subset.

## Not owed

A successor built before the saga-first abort answers `Not found` for a handed-off job. No change here can reach it, and the case ages out with those builds.

## Rejected

| Alternative | Why rejected |
| --- | --- |
| Write the stop despite closed admission | The drain obligation promises that no saga mutation follows it, and `runSync` refuses the write. |
| Refuse every abort while draining | Removes the drain-recovery abandonment exits (#359, #363). |
| Refuse in transport before dispatch | Transport would read provider-operation state, and transport is carriage only. |
