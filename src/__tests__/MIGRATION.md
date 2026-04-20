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
  - `CircularCauseRefDiagnostic` persistence remains caller-owned: the renderer returns structured `result.cycle` metadata and does not append an event itself.

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

## Phase 3 finalization (CG8 — execution deletion complete)

`src/execution/` is now deleted. Phase 3 closes the residue ledger by moving the last live implementations to their owning coordinator, transport, jobs, sessions, and store homes, and by retiring the remaining compat shims outright.

### Production-file disposition ledger (`src/execution/**`)

- `src/execution/backend-lock.ts` → **REWRITTEN** into `src/coordinator/lock.ts`.
- `src/execution/backend-core.ts` → **DELETED**; the exported backend-core surface now re-exports from `src/coordinator/coordinator.ts`.
- `src/execution/backend-core-types.ts` → **MOVED** to `src/coordinator/composition/backend-core-types.ts`.
- `src/execution/job-lifecycle-contracts.ts` → **MOVED** to `src/jobs/shell/contracts.ts`.
- `src/execution/job-lifecycle.ts` → **DELETED**; importers now target `src/jobs/shell/{launch,wait}.ts` directly.
- `src/execution/lifecycle.ts` → **DELETED**; lifecycle/control imports now target `src/coordinator/control.ts`.
- `src/execution/progress-store.ts` → **MOVED** to `src/jobs/job-store.ts` (the interim store-layer stopover has since been retired).
- `src/execution/recovery-registry.ts` → **MOVED** to `src/coordinator/composition/recovery-registry.ts`.
- `src/execution/server.ts` → **DELETED**; callers now use `src/coordinator/coordinator.ts` plus `src/coordinator/bootstrap.ts`.
- `src/execution/server-types.ts` → **DELETED**; lifecycle/server types now come from `src/coordinator/{control,coordinator}.ts`.
- `src/execution/service.ts` → **DELETED**; callers now use `src/coordinator/api.ts`.
- `src/execution/session-manager.ts` → **DELETED**; callers now use `src/sessions/shell/{store,resolve}.ts`.
- `src/execution/smoke-open-store.ts` → **ABSORBED** into `src/coordinator/bootstrap.ts` under the `--smoke-open-store` entrypoint.
- `src/execution/composition/backend-control.ts` → **MOVED** to `src/coordinator/composition/backend-control.ts`.
- `src/execution/composition/backend-defaults.ts` → **MOVED** to `src/coordinator/composition/backend-defaults.ts`.
- `src/execution/composition/backend-world.ts` → **MOVED** to `src/coordinator/composition/backend-world.ts`.
- `src/execution/composition/create-backend-core.ts` → **MOVED** to `src/coordinator/composition/create-backend-core.ts`.
- `src/execution/composition/execution-services.ts` → **MOVED** to `src/coordinator/composition/execution-services.ts`.
- `src/execution/composition/runtime-state.ts` → **MOVED** to `src/coordinator/composition/runtime-state.ts`.

### Test/helper disposition ledger (`src/execution/**`)

- `src/execution/__tests__/server-test-deps.ts` → **MOVED** to `src/coordinator/__tests__/server-test-deps.ts`.
- `src/execution/__tests__/workflow-session-cleanup.test.ts` → **DELETED**; workflow-session cleanup now lives inside `src/coordinator/api.ts`, with coordinator/service and workflow recovery coverage owning the behavior.

### GOD amendments recorded at phase exit

- `info.ts → discovery.ts`: the coordinator-owned daemon-discovery seam now lives at `src/coordinator/discovery.ts`; `src/infra/backend-info.ts` is retired.
- `bootstrap.ts` is the main-process entry: `scripts/build-server.mjs` and `scripts/verify-native-binding.sh` target `src/coordinator/bootstrap.ts`, and `src/coordinator/coordinator.ts` remains the testable composition root.

### `service.test.ts` split map (94-test execution baseline)

- Launch / queue admission / provider preflight cases → `src/jobs/shell/__tests__/launch.test.ts`.
- Abort semantics and terminal-state abort edge cases → `src/jobs/shell/__tests__/abort.test.ts`.
- Wait-stream / wait-once / replay cursor behavior → `src/jobs/shell/__tests__/wait.test.ts` plus `src/transport/http/__tests__/server.test.ts` for wire-level SSE assertions.
- Startup recovery, orphan adoption, ghost launch, wrapper-loss, and interrupted app-server recovery → `src/jobs/reconcile/__tests__/lifecycle-recovery.test.ts`.
- Cross-domain coordinator residue (resume/fork composition, workflow dispatch, provider-host composition, interrupted app-server finalization) → `src/coordinator/__tests__/service-composition.test.ts`.

## Final Polish (AC1-AC12)

Baseline before final-polish landing: `npm test` `1619 passed | 30 skipped | 3 todo`; integration suite `18/18` green.

Commit ledger:

- `82f0c782` — AC2 jobs replay-identity coverage and denormalized projection assertions.
- `7490d463` — AC9 projection-only session lookup and `projection_sessions.shard_dir` contract.
- `802f27a2` — AC5 leaf-import cleanup for coordinator/jobs boundaries.
- `2c39b59e` — AC1 + AC12 upcast-routing tightening and invariant expansion.
- `current cluster commit` — quality/coverage/doc closeout for cached read contexts, explicit upcasters, runtime rename, shutdown budgeting, and reducer/query proof additions.

Migration notes:

- Store schema bootstrap now uses a single canonical `src/store/migrations/001_initial.sql` at first-deploy `schema_version='1'`. Pre-merge schema changes edit `001` in place; `002+` versioning begins only after the first main merge.
- AC3 rename pass: `AppServerRuntimeRecord` normalized to `AppServerRuntime`; downstream imports now point at the renamed jobs view type.
- AC4 deletion pass: workflow-cleanup claims remain closed; no deleted workflow/checkpoint types were reintroduced during final polish.
- AC9 schema additions: `projection_sessions.shard_dir` is authoritative, seeded by `session.opened`, and no empty-string fallback remains in reducer paths.

## Deferred — post-rewrite-final-polish

- **Discuss follow-up agent concurrency (plan AC9)**: `src/discuss/shell/followup-flow.ts collectFollowUpAnswer` uses `Promise.all` (fail-fast). Switching to `Promise.allSettled` for agent-level independence requires full discuss agent lifecycle work: fault classification (permanent exit vs transient), `agents[*].banned` reducer integration across bid/speech/follow-up flows, replay-identity-preserving ban event, bid round invalidation semantics, and retry policy interaction. Current fail-fast behavior is safer until this lifecycle is designed. Track on future discuss-agent-lifecycle phase.
