# TODO — what a six-reviewer sweep found outside the branch it was aimed at

**Status**: open, batched deliberately, and scheduled **after PR3** of the handoff-routing work. Written
2026-08-22 from six delegated reviewers (architect, integration-guardian, code-critic, test-critic,
doc-critic, ux-critic) pointed at `refactor/handoff-routing-disposition` and asked to sweep the repository
for the defect classes that branch had just closed in itself. Everything the branch introduced was fixed on
the branch. Everything below predates it.

Two findings were mechanical enough to take immediately and are **not** listed here: the simulation
`ProcessPort.exec` fake dropped `shell` while the real adapter forwards it, and `startup_not_ready` fell
through to HTTP 500 despite its own remediation saying to retry shortly — it is a readiness condition beside
`kb_initializing`, and 500 drove the CLI to the permanent internal exit rather than the retry code. Both now
have tests that fail when the fix is reverted.

The rest is here rather than in six entries because it is one observation with many instances: **a value
that decides something is written down once and then re-derived, widened, or discarded by the next reader.**
Splitting it per-file would lose that, and each instance is individually small.

## 1. A cast asserts a port the object does not implement — BLOCKING

`createCoordinatorServer` in `src/coordinator/index.ts` bridges `getExecutionService` into `resumeAll` with `getExecutionService(ctx) as never`,
mirrored at `createSimulationBackend` in `tools/simulation/core/backend.ts`. `ResumeAllOptions` requires a `WorkflowExecutionPort`
(`src/workflow/recover.ts`), which declares `recordContinuationLease` and `clearContinuationLease`
(`src/workflow/execution-contract.ts`). `ExecutionService` implements `RecoveryCapableService`,
`ProjectRequestPort` and `HandoffQuiescePort` — not that port — and supplies the two lease methods only inside a
nested `executionPort:` object literal, not as public members. `src/workflow/recover.ts` calls
`deps.executionSvc.recordContinuationLease(...)` directly on the expired/prior-replacement path.

Verified here: the class's `implements` clause, the absence of both methods as public members, the nested
literal that does have them, and the direct call. What is **not** established is how often that recovery path
is entered — the finding is a type gap with a matching call site, not an observed crash.

Fix: expose a compiler-checked `WorkflowExecutionPort` from coordinator composition — implement the two
methods on `ExecutionService`, or return a dedicated typed adapter — and delete both `as never`.

## 2. Branches the call graph cannot reach

Each was proved by walking every producer into the consumer, the same method that retired
`runHandoff`'s `reset-newer-invalid` arm and `handoffStartupToSelectedBuild`'s `run-current` branch. Several
of these fabricate an operator-facing error message for a state that cannot occur, which is worse than dead
code: it documents a failure mode that does not exist.

| Site | What cannot happen |
| --- | --- |
| `performInterruptedAppServerRecovery` and `performInterruptedDurableRecovery` in `src/coordinator/services/recovery/interrupted-performer.ts` | The "lost capability" throws; the service derives recovery/probe capability and passes the same object to the performer, and the planner only emits `probe` when probe capability is present |
| `materializePlannedOutcomeInCommit` in `src/coordinator/services/terminal-materializer.ts` | The missing failed-cause event error; `RuntimeIngestPlan` declares `immediateOutcome: null` only on `failed_cause`, whose `domainEvents` is a one-element tuple |
| `createProviderProxyAcquisitionSteps` in `src/coordinator/live/provider-proxy/acquisition-steps.ts` | Two out-of-order errors; the sole caller runs `createCapsules` → `spawnGuardian` → `establishControl` and returns on every failed cut |
| `createProviderProxyAuthorityHeartbeatAssembly` in `src/coordinator/live/provider-proxy/heartbeat.ts` | Duplicate-role and incomplete-role errors; both production constructors start each role once before `complete`, and neither loops. Unit tests preserve both impossible states |
| `createProviderProxyRecoveryDispatcher` in `src/coordinator/services/provider-proxy-recovery-policy.ts` | `provider_proxy_exact_capsule_reducer_incomplete`; `submit` retires every observation the reducer's catch-all would have to handle |
| `createCoordinatorJobRecoveryRetryPlan` in `src/coordinator/services/recovery/index.ts` | "retry policy lost its cleanup contract"; the scoped WeakMap has one writer whose factory always returns `boundary-required` |
| `ProviderProxySetLifecycle` in `src/coordinator/services/provider-proxy-set/index.ts` | The success callback cannot observe a missing acquisition slot; the slot is created before, and only the mutually exclusive failure callback deletes it |

The fixes are structural rather than deletions: carry the prior cut's typed output into the next, give exact
recovery a seam-specific union, start heartbeats from one session aggregate, return a one-use admission token
instead of an unconstrained string id. Deleting the branch without that just moves the impossibility into a
type nobody checks.

## 3. Places that admit two answers where the evidence has three

`.claude/rules/design-philosophy.md` principle 11. The tree already has
`tests/invariants/liveness-is-never-a-boolean.test.ts`, so the rule is enforced somewhere and these are what
it does not reach.

- `verifySignalTarget` in `src/coordinator/handoff.ts` — `unknown` collapses into `alive`, and the next line tells the operator
  the pid **is** alive.
- `observeProcessIdentity` in `src/infra/process-containment.ts` — both identity observers merge `unknown` with `alive` and
  emit "while it is alive". Signalling stays conservatively refused, so the refusal is right and the stated
  evidence is false.
- `removeDeadWriterLeases` in `src/store/generation-mutation-coordination.ts` — an unknown writer probe is appended to a collection
  named `live` and then reported as the holder blocking maintenance. Only `absent` may remove a lease.
- `buildRecoverySnapshot` in `src/coordinator/services/recovery/snapshot.ts` — a tri-state observation is exposed as
  `isPidAlive(): boolean`, so `unknown` becomes `true`, and that boolean decides wrapper-lost in
  `planJobRecovery` in `src/jobs/reconcile/plan.ts`. A later observer re-observes correctly, so nothing finalizes on it today
  — the planning contract lies rather than the outcome being wrong.
- `isCoordinatorAlive` in `clients/hooks/session-start.mjs` — every `kill(pid, 0)` exception becomes `false`, so `EPERM` reads as
  coordinator absence. A hook may not refuse, so the fix is a disposition it can report, not a hold.
- `resolveBackendInfoPath` in `clients/skills/statusline/coral-hud.mjs` — any signal-zero exception renders as "no backend", including
  the `EPERM` that proves one exists.

## 4. Contracts weaker than they read

- `createKbDaemonWriteRuntimeHost` in `src/kb-daemon/runtime-host.ts` — all five expansion methods cast `request.args` from `unknown` to
  their method-specific types. The wire guard validates `method` and `ctx` only, so `{method:'equipExpansion',
  args:{}}` crosses it and reaches the implementation falsely typed. Needs a method-discriminated union
  parsed per-method before dispatch.
- `createSimulationBackend` in `tools/simulation/core/backend.ts` — a plain string is cast to `CanonicalWorkDir`, whose brand requires
  an absolute normalized path, while scenario inputs accept any string. A relative path produces an invalid
  branded context and principal binding.
- `createRealRuntime` in `src/runtime/real.ts` and `SimulationRuntime` in `tools/simulation/runtime.ts` — both `ProcessPort` adapters are cast from a
  partial or empty object and completed by assignment, so a future required member would not fail either
  construction site. `satisfies` at one complete object literal is the shape that would.
- Dead fields, each written by every producer and read by nobody: `retryable` on
  `PrepareResult` in `src/provider-proxy/ledger.ts` (the sole reader re-derives it), the aborted-variant `reason` in
  `ClaudeTurnOutcome` in `src/providers/claude/session-kernel.ts` and `CodexKernelResult` in `src/providers/codex/thread-kernel.ts`, and unused
  `responseSchema` metadata. Removing a field nothing reads is mechanical; deciding whether the concept
  should instead be *used* is not, which is why they are here and not in the immediate batch.

## 5. Assertions that pass when their subject is absent

All the same shape: optional chaining makes a missing subject satisfy a negative assertion.
`readStatus(...)?.phase` compared with `not.toBe('error')` passes when the status was deleted rather than
rebound; `getSession(...)?.snapshot.state.status` "not bidding" passes when the session is gone. Sites:
`tests/unit/jobs/reconcile/lifecycle-recovery.test.ts` (`:3742`, `:4019`, `:4291`),
`tests/e2e/cli/main.test.ts` (`:177`, `:216`), `tests/unit/discuss/shell/discuss-manager.test.ts`,
`tests/integration/coordinator/service-composition.test.ts`, `tests/unit/jobs/provider-event.test.ts`,
`tests/unit/kb/curate.test.ts`, `tests/integration/coordinator/pre-pr-running-incumbent.test.ts`.

Each needs a positive witness rather than a stronger negative — assert the subject exists and names the
expected value. Two of them (`provider-event`, the ghost-launch row) may be redundant with a sibling that
already asserts the positive sequence, in which case deleting is the honest fix.

## Start condition

After PR3 of `backend-routing-disposition`. Item 1 is independent of that work and of the rest of this file;
nothing here blocks anything else. Item 2's instances are individually independent. Item 5 is test-only and
can be done in any order, but doing it first would tell whether items 2 and 3 have coverage that was passing
vacuously.
