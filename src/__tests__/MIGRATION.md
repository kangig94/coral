# Test Migration Notes

Baseline at tag `phase-1-complete`: 41 files under `src/execution/__tests__/` (39 `.test.ts` + 2 helpers: `discuss-test-helpers.ts` and `simulation-runtime.ts`). Phase 2 moves domain-owned coverage onto the new `src/jobs/`, `src/sessions/`, `src/discuss/`, `src/workflow/` trees while the remaining files stay under `src/execution/__tests__/` as deferred coordinator/transport/simulation/KB residue with explicit later-phase retirement triggers.

## Jobs slice (commit `ae7eeb8a` — `phase-2/jobs`)

- `src/execution/__tests__/abort-registry.test.ts` → **DELETED**; replaced by `src/jobs/shell/__tests__/abort-registry.test.ts`.
- `src/execution/__tests__/agent-resolution.test.ts` → **DELETED**; replaced by `src/jobs/shell/__tests__/agent-resolution.test.ts`.
- `src/execution/__tests__/recovery-core.test.ts` → **DELETED**; replaced by `src/jobs/reconcile/__tests__/plan.test.ts`.
- New AC1/AC8 proof coverage:
  - `src/jobs/__tests__/reducer-equivalence.test.ts`
  - `src/jobs/__tests__/outcome-contract-purity.test.ts`
  - `src/jobs/__tests__/cause-ref-chain.test.ts`

## Sessions slice (commit `02301ae2` — `phase-2/sessions`)

- `src/execution/__tests__/session-manager.test.ts` → **SPLIT** between `src/sessions/shell/__tests__/store.test.ts` and `src/sessions/shell/__tests__/resolve.test.ts`.
- `src/client/__tests__/readers.test.ts` → **KEPT** in place; still covers the shared session-entry reader bridge onto `src/sessions/entry.ts`.
- New AC2 proof coverage: `src/sessions/__tests__/reducer-equivalence.test.ts`.

## Discuss slice (commit `e1a53b3c` — `phase-2/discuss`)

- `src/execution/__tests__/discuss-session-store.test.ts` → **KEPT** with import rewrites onto `src/discuss/shell/session-store.ts`; golden reducer coverage added at `src/discuss/__tests__/session-store-golden.test.ts`.
- `src/execution/__tests__/discuss-manager.test.ts` → **KEPT** with import rewrites onto `src/discuss/shell/{live-registry,runtime-build,operations,registry,subflows}.ts`.
- `src/execution/__tests__/discuss-manager-{bids,speech,epoch,synthesis,faults,lifecycle}.test.ts` → **KEPT** with import rewrites onto `src/discuss/shell/*`.
- `src/execution/__tests__/discuss-tools.test.ts` and `src/execution/__tests__/discuss-prompts.test.ts` → **KEPT** with import rewrites onto `src/discuss/shell/{tools,prompts}.ts`.
- `src/execution/__tests__/discuss-runtime-sealing.test.ts` and `src/execution/__tests__/server-discuss-api.test.ts` → **KEPT** with import rewrites onto `src/discuss/shell/*`.
- New AC3 proof coverage:
  - `src/discuss/__tests__/session-store-golden.test.ts` + fixtures (`session-store-golden.json`, `session-store-golden.events.jsonl`).
  - `src/__tests__/hook-stubs-no-op.test.ts` (AC10).

## Workflow slice (commit `baeeb8cd` — `phase-2/workflow`)

- `src/workflow/__tests__/pipe-parser.test.ts` → **KEPT** with import rewrites onto `src/workflow/parser.ts`.
- `src/workflow/__tests__/pipe-executor.test.ts` → **KEPT** with import rewrites onto `src/workflow/{launch,wait,executor,command}.ts`.
- `src/workflow/__tests__/handler.test.ts` → **KEPT** with import rewrites onto `src/workflow/api.ts`.
- `src/workflow/__tests__/integration/pipe-executor-cascade.test.ts` → **KEPT** but now runs through `src/workflow/api.ts` + the decomposed workflow executor.
- New AC4 proof coverage:
  - `src/workflow/__tests__/reducer-equivalence.test.ts`
  - `src/workflow/__tests__/pipe-executor-cascade-equivalence.test.ts`
  - `src/workflow/__tests__/recover-branches.test.ts`

## Execution layering handoff (Phase 2 residue retired in CG7)

All 37 files surviving under `src/execution/__tests__/` after Phase 2 are **DEFERRED** with explicit later-phase owners. CG7 retired the file-by-file residue harness in favor of `src/__tests__/invariants/architecture-layering.test.ts`, which now guards the layering seams that remain while `src/execution/` is still present ahead of CG8.

### Coordinator handoff (Phase 3, `nextHome = src/coordinator/**`)

- `backend-isolation.test.ts`
- `backend-lock.test.ts`
- `discuss-acyclic.test.ts`
- `engine.test.ts`
- `event-bus.test.ts`
- `host-manager.test.ts`
- `recording-observer.test.ts`
- `recovery-registry.test.ts`
- `runtime-coral-paths-settlement.test.ts`
- `runtime.test.ts`
- `server-discuss-api.test.ts`
- `server.test.ts`
- `workflow-session-cleanup.test.ts`

### Transport handoff (Phase 4, `nextHome = src/transport/**`)

- `query-coerce.test.ts`
- `tool-response.test.ts`

### KB handoff (Phase 5)

- `kb-tools.test.ts` — retires with `src/execution/kb-tools.ts` in Phase 5 KB cleanup.

### Discuss shell coverage kept for parity until coordinator extraction (Phase 3 / Phase 7 simulation)

- `discuss-manager-bids.test.ts`
- `discuss-manager-epoch.test.ts`
- `discuss-manager-faults.test.ts`
- `discuss-manager-lifecycle.test.ts`
- `discuss-manager-speech.test.ts`
- `discuss-manager-synthesis.test.ts`
- `discuss-manager.test.ts`
- `discuss-prompts.test.ts`
- `discuss-runtime-sealing.test.ts`
- `discuss-session-store.test.ts`
- `discuss-test-helpers.ts`
- `discuss-tools.test.ts`

### Simulation handoff (Phase 7, `nextHome = src/simulation/**`)

- `simulation-adversarial.test.ts`
- `simulation-recording.test.ts`
- `simulation-runner.test.ts`
- `simulation-runtime.test.ts`
- `simulation-runtime.ts` (helper)
- `simulation.test.ts`

## New invariants + proofs (Phase 2 totals)

- `src/__tests__/invariants/exec-no-duplication.test.ts` (AC11).
- `src/__tests__/invariants/architecture-layering.test.ts` (AC11, CG7 replacement for the Phase 2 residue harness).
- `src/__tests__/invariants/legacy-boundary.test.ts` (AC7).
- `src/__tests__/__helpers__/ts-import-scanner.ts` — shared AST import-graph scanner used by the layering invariants.

## Phase 3 carry-over debt cleanup (CG6 — `phase-3/shared-ownership-cleanup`)

- `src/execution/__tests__/service.test.ts` → **SPLIT** across:
  - `src/jobs/shell/__tests__/launch.test.ts`
  - `src/jobs/shell/__tests__/abort.test.ts`
  - `src/jobs/shell/__tests__/wait.test.ts`
  - `src/jobs/reconcile/__tests__/lifecycle-recovery.test.ts`
  - `src/coordinator/__tests__/service-composition.test.ts`
- Zero-drop gate preserved: destination files retain `52 + 19 + 2 + 18 + 22 + 3 + 23 = 139` `it(...)` blocks against the original 94-test baseline. The coordinator file now carries only cross-cutting resume/fork/workflow/recovery residue; launch/abort/wait-specific coverage moved to the domain-owned destinations above.
- `src/execution/__tests__/progress-store.test.ts` → **DELETED**; replaced by `src/jobs/__tests__/projection-rebuild.test.ts`, which proves the live ConsumerDriver projection rebuild path over `projection_jobs`.
- `src/shared/types.ts`, `src/shared/persistence-parsers.ts`, and `src/shared/persistence-readers.ts` → **DELETED** in the same commit group. Type imports now come from domain-owned modules, discuss persistence helpers live at `src/discuss/shell/discuss-sources-catalog.ts`, and job status parsing lives at `src/jobs/records.ts`.

## Repo-wide grep closures (Phase 2 exit gate)

- `rg "\\bCoralFault\\b" src/ --type ts` → zero.
- `rg "coral_fault\\s*\\{\\s*fault:" src/ --type ts` → zero.
- `rg "PersistedStatusRecord|PersistedLaunchRecord|PersistedRuntimeRecord|PersistedExitRecord|PersistedProgressRecord|WorkflowCheckpoint|ProviderResult|ProviderProgressEvent|TerminalResult|SessionContinuityPatch" src/ --type ts` → zero.
