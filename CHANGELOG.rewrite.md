# Rewrite Changelog

## Phase 0 — Foundation (complete)

Tag: `phase-0-complete` @ rewrite branch.

Phase 0 lays down the skeleton of the new Journal + Corpus architecture on the `rewrite` branch. No behavior change — the marketplace-installed plugin at `~/.claude/plugins/cache/coral/coral/<version>/` continues to serve users from the pre-rewrite release.

**Delivered**:

- Legacy-isolation invariant + scanner exclusions (`src/__tests__/__helpers__/ts-import-scanner.ts`, `scripts/verify-simulation-sealing.mjs`). AC1 move set: 0 files — the per-file collision rule kept every pre-rewrite module in place.
- Full SQLite schema at `src/store/schema.sql` and `src/store/migrations/001_initial.sql` (content-identical at Phase 0). TypeScript row types in `src/store/schema.ts`. Idempotent migration runner at `src/store/migrations.ts` (zero `db.totalChanges` delta on rerun). Build-time asset copy into `dist/store/`.
- `CoralSetupError` class contract at `src/runtime/errors.ts`.
- `BuildFlavor` type + `resolveBuildFlavor(env)` pure resolver at `src/runtime/flavor.ts`. `npm run dev` now sets `CORAL_FLAVOR=dev`.
- Per-owner path factories: `src/store/paths.ts`, `src/kb/corpus/paths.ts`, `src/coordinator/discovery.ts` (renamed from `info.ts` in Phase 3 — see §Amendments; Darwin=104/Linux=108 socket fallback), `src/jobs/exports/paths.ts`, `src/infra/equipment-paths.ts`.
- `CoralPaths` type at `src/infra/coral-paths.ts` (utility-type ownership). `composeCoralPaths(flavor)` composition root at `src/coordinator/paths.ts` returning `Object.freeze({...})`.
- `Runtime` + `RuntimePaths` sole ownership migrated to `src/runtime/ports.ts`. `src/shared/runtime-ports.ts` reduced to type-only bridge. Runtime value helpers moved to `src/runtime/spawn.ts`. `Runtime.paths.coral` added as a lazy getter that throws `CoralSetupError('E_FLAVOR_NOT_SETTLED', ...)` before `setBuildFlavor` is called. `InMemoryPaths` extended to implement `coral`. `src/runtime/real.ts` created as Phase 1 placeholder.
- Skeleton barrels for `src/store`, `src/coordinator`, `src/jobs`, `src/sessions`, `src/providers/middleware`, `src/transport{,/ipc,/http}`, `src/runtime`, `src/workflow`, `src/simulation`, `src/testing`. `src/infra/index.ts` preserved as the canonical `./infra` public-export contract.
- Invariants scaffolding: `layer-boundary.test.ts`, `type-ownership.test.ts` (test.todo). Real invariants: `no-ambient-flavor-reads.test.ts`, `legacy-isolation.test.ts`, `runtime-coral-paths-settlement.test.ts`. Flavor path separation integration test at `src/__tests__/integration/flavor-path-separation.test.ts`.
- `better-sqlite3` added as a runtime dep. `discuss-acyclic.test.ts` subsystem classifier extended to cover new Phase 0 directories.

**Retirement ledger** (Phase 0 wrappers; retired by later phases or Phase 7 Cleanup): `src/shared/runtime-ports.ts`, `src/shared/request-context.ts`, `src/shared/types.ts`, `src/execution/runtime.ts`, `src/execution/*` (bulk), `src/infra/paths.ts`, `src/infra/backend-info.ts`, `src/workflow/*`, `src/client/{index,backend-lifecycle,backend-helpers,http-client,readers,discuss,backend-health}.ts`.

**Verification**: `npm run build` clean (prod + dev flavors). `sqlite3 :memory: < schema.sql` and `sqlite3 :memory: < migrations/001_initial.sql` both exit 0. `npm test` green (1645 tests pass, 2 skipped, 3 todo). Integration suite green (14 tests). All 16 acceptance criteria satisfied.

## Phase 1 — Journal Substrate (complete)

Tag: `phase-1-complete` @ rewrite branch.

Phase 1 builds the complete Journal truth spine on top of Phase 0's skeleton. Live plugin stays unaffected.

**Delivered**:

- `better-sqlite3`-backed Journal at `src/store/db.ts` — WAL mode, `foreign_keys=ON`, `busy_timeout`, prepared-statement cache.
- Transactional append at `src/store/append.ts` — `appendEvents()` runs inside `db.transaction(fn).immediate(...)`, assigns `seq` from SQLite ROWID, dispatches reducers and updates `projection_*` rows in the same transaction. 10k-event bulk append passes with monotonic `seq`; mid-batch reducer throw rolls back events and projections.
- Canonical decode→parseBody→reduce pipeline architecture §4.2 literal: append stores RAW input bytes (`Buffer.from(JSON.stringify(input.body), 'utf-8')`) with `body_version = input.bodyVersion`. Both append AND rebuild call `parseBody(type, row.body_version, decoded, schema)` before reducer dispatch. Prevents upcaster double-application regression.
- Pure replay rebuild at `src/store/rebuild.ts` — `rebuildProjections({cutoffSeq, reducers, db, upcasters, extraProjectionTables?})` resets Journal-owned projections (`projection_jobs/sessions/discuss/workflows` + optional test extras) and replays events. `projection_kb` never touched (Corpus authority).
- Envelope + upcaster mechanism at `src/store/envelope.ts` — Zod envelope schema rejects invalid inputs; `UpcasterRegistry` with `registerUpcaster` (conflict throws `CoralSetupError('upcaster_conflict')`) and `parseBody` (missing chain throws `upcaster_missing`). Upcaster round-trip test locks raw-bytes-on-write + upcast-on-read.
- Query primitives at `src/store/queries/events.ts` — `getEvent(stream, seq)` and `getEventsSince(afterSeq, filter?, limit?)` with streamKind/type/correlationId filters.
- Read-only public surface at `src/store/index.ts` — exports only `{ CoralStore, openStoreDatabase, applyMigrations, journalEventEnvelopeSchema, + type re-exports }`. `appendEvents`, `rebuildProjections`, `storePaths` NOT exposed publicly. Enforced by `src/store/__tests__/public-surface.test.ts`.
- Skeleton domain registries at `src/jobs/events.ts`, `src/sessions/events.ts`, `src/workflow/events.ts` + non-destructive Journal adapter at `src/discuss/store-registry.ts` wrapping the preserved `src/discuss/events.ts` live contract (envelope bridge: `type='discuss.<kind>'`, `body.legacySeq`).
- `ConsumerDriver` at `src/coordinator/consumer-driver.ts` — Journal-only Phase 1: `register` populates all 4 `equipment_cursors` columns with `equipped_at = ISO(runtime.time.now())`; authority mismatch throws `consumer_authority_mismatch`; `notify('corpus', ...)` throws `consumer_authority_unsupported`. Single-in-flight drain, coalesced pending notify, fault-isolated. `waitFreshUntil` with `settled` guard, waiter removed on resolve AND reject, late apply post-timeout does NOT re-resolve.
- `SimulationRuntime` canonical home at `src/simulation/runtime.ts` (L1-scoped in Phase 1). Deterministic doubles stay under `src/simulation/core/*`. `core/index.ts` kept as compat barrel re-exporting FROM new home. 1000-event determinism test asserts three runs produce byte-identical state.
- Native-binding scratch-dir smoke at `scripts/verify-native-binding.sh` + `src/execution/smoke-open-store.ts` — exercises the built bundle outside the repo tree; confirms `openStoreDatabase()` finds migration assets via bundle-aware resolution.
- **Atomic runtime cutover** (§1.6 single commit): `src/execution/runtime.ts` DELETED, `src/shared/runtime-ports.ts` DELETED, `Runtime*` compat aliases (`RuntimeTime`, `RuntimeStorage`, `RuntimeProcess`, `RuntimeIds`, `RuntimeEnv` — without `Port` suffix) removed from `src/runtime/ports.ts`. `createRealRuntime()` moved to `src/runtime/real.ts`. 77 TypeScript files updated. Verified by `scripts/verify-runtime-cutover.mjs` (AST resolver) + `scripts/__tests__/verify-runtime-cutover.fixture.mjs` self-test.
- Phase 0 debt cleared: `src/store/migrations.ts` routes file I/O through `Runtime.storage`; path factories accept `{baseDir}` option; `buildInMemoryCoralPaths` delegates to factories.

**Retirement ledger progression**:

- ✅ `src/shared/runtime-ports.ts` — DELETED (§1.6).
- ✅ `src/execution/runtime.ts` — DELETED (§1.6).
- ✅ `Runtime*` compat aliases in `src/runtime/ports.ts` — REMOVED (§1.6).
- ⏭ `src/infra/backend-info.ts` — retires in Phase 3 when backend discovery I/O moves to `src/coordinator/discovery.ts` (renamed from `info.ts` in Phase 3 — see §Amendments).
- ⏭ `src/client/backend-lifecycle.ts` — retires in Phase 3.

**Verification**: `npm run build` (prod + dev) clean; `npm run lint` clean; `npm test` green (1698 pass / 2 skipped / 3 todo across 113 files); integration suite green (14 tests); `node scripts/verify-runtime-cutover.mjs` exits 0; `node scripts/__tests__/verify-runtime-cutover.fixture.mjs` exits 0 (self-test passes); `bash scripts/verify-native-binding.sh` exits 0 with `ok` output. All 14 acceptance criteria satisfied.

## Phase 2 — Journal Domains + Legacy Elimination (complete)

Tag: `phase-2-complete` @ rewrite branch.

Phase 2 turns the Phase 1 Journal substrate into real domain ownership. Each of `src/jobs/`, `src/sessions/`, `src/discuss/`, `src/workflow/` now owns its events, projection reducer, shell, and `api.ts` facade. `CoralFault`, `WorkflowCheckpoint`, `SessionContinuityPatch`, and the `Persisted*Record` / `ProviderResult` / `ProviderProgressEvent` / `TerminalResult` families are gone from `src/**/*.ts`. Live plugin remains unaffected (rewrite branch only; no `build:release`).

**Delivered**:

- **§2.1 Phase 1 debt cleared** (commit `ba58f6c6`): `src/runtime/exec-builder.ts` exposes the shared `buildExecPromise` factory consumed by both runtimes — duplicate exec lifecycle bodies gone. `src/store/append.ts` requires `AppendContext.reducers: ComposedReducers`; `normalizeReducers`/`isComposedReducers` deleted. New invariant: `src/__tests__/invariants/exec-no-duplication.test.ts`.
- **§2.2 Jobs domain** (commit `ae7eeb8a` — AC1 + AC8): `src/jobs/` ships `outcome.ts` (pure 5-variant ADT + 3-variant `JobLifecycleFault` + `CauseRef`), `phase.ts`, `launch.ts`, `result.ts`, `wait.ts`, `events.ts`, `projections.ts`, `api.ts` (`jobsCommands` + `jobsQueries` + `jobsReconcile`), `shell/{launch,abort,wait,abort-registry,agent-resolution,instruction,legacy-ingest}.ts`, `reconcile/{plan,snapshot,actions,coordinator,cross-namespace-adoption,claim-protocol,ownership-checker,job-helpers,errors}.ts`, `exports/result-markdown.ts`, and `read/cause-ref-render.ts`. `src/shared/legacy-terminal-outcome-compat.ts` (discriminant renamed `coral_fault → legacy_fault`) is the sole provider→domain bridge for Phase 6 retirement. `src/jobs/shell/legacy-ingest.ts` is the single authorized Legacy→domain converter. `src/shared/coral-fault.ts` and `src/execution/{recovery-core,recovery-registry,abort-controller-registry,agent-resolution,instruction,progress-store,job-lifecycle}.ts` + `src/execution/lifecycle/*` deleted. `src/cli/format.ts` + `src/cli/follow.ts` rewired to the 5-variant `TerminalOutcome` exit-code table.
- **§2.3 Sessions domain** (commit `02301ae2` — AC2): `src/sessions/{entry,continuity,fault,events,projections,api,index}.ts` + `shell/{store,resolve}.ts`. `SessionContinuityPatch` purged repo-wide; `CauseRef` reused from `src/jobs/outcome.ts`. `src/execution/session-manager.ts` reduced to a 9-line re-export shim (retires Phase 3).
- **§2.4 Discuss domain + hook stubs** (commit `e1a53b3c` — AC3 + AC10): `src/discuss/events.ts` + `src/discuss/reducer.ts` preserved as the live persisted contract. New `store-registry.ts` (Journal adapter: `type='discuss.<kind>'`, `stream.kind='discuss'`, `body.legacySeq`), `projections.ts`, `reconcile.ts`, `api.ts` (`discussCommands` + `discussQueries` + `discussReconcile`). 13 files under `src/execution/discuss/` deleted; replaced by `src/discuss/shell/{bid-flow,speech-flow,followup-flow,synthesis-flow,session-store,live-registry,runtime-build,persistence,read-helpers,context,flow-shared,loop,operations,prompts,registry,subflows,tools}.ts`. Golden-master fixture captured via `SimulationRuntime + SequentialIds + VirtualTime` with normalized roots/timestamps/UUIDs/pids. `hooks/post-compact.mjs` + `hooks/pre-compact.mjs` reduced to no-op stubs via `hooks/lib/hook-utils.mjs` (no `src/` imports).
- **§2.5 Workflow domain** (commit `baeeb8cd` — AC4): `src/workflow/pipe-executor.ts` (1272 lines) decomposed per the named-function table into `{parser,ast,normalize,plan,command,events,projections,executor,launch,wait,recover,api,index}.ts`. Launch + retry intertwined in `launch.ts` per architecture §10.1a. `internal/{format.ts,shared.ts}` and `consumer.ts` support the pipe-executor decomposition. `WorkflowCheckpoint` deleted repo-wide; `workflow.drain.entered { firstFailureSlotId, drainDeadline }` event replaces the persisted checkpoint. Resume mechanism derives every former `WorkflowCheckpoint` field from `projection_workflows.plan` + `projection_jobs` with a 3-branch phase rule (`running`/`queued` → `waitForAtoms`, absent → re-launch). `src/workflow/{pipe-executor,pipe-parser,handler,types}.ts` deleted; `WorkflowCheckpoint` helpers (`writeCheckpoint`, `createCheckpointPersister`, `checkpointStepLaunch`, `checkpointStepCompletion`) deleted.
- **§2.6 Execution composition-only sweep** (commit `b8852b4b` — AC5 + AC6 + AC7): every surviving file under `src/execution/**` is pinned in `src/__tests__/invariants/execution-composition-only.test.ts` with a category, later-phase owner, downstream home, exact allowed facade imports/symbols, and forbidden semantic constructs. Projection drain wired at startup: `src/execution/lifecycle.ts` snapshots `cutoffSeq = MAX(seq)` and runs `rebuildProjections({db, cutoffSeq, reducers: composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry), upcasters})` before `jobsReconcile.runStartup → discussReconcile.runStartup → workflowCommands.resumeAll`. AST residue checker at `src/__tests__/__helpers__/execution-residue-ast.ts` extends `ts-import-scanner.ts` with named-import, facade-member-access, identifier, literal, callee, and object-construction capture. New invariants: `src/__tests__/invariants/execution-composition-only.test.ts`, `src/__tests__/invariants/legacy-boundary.test.ts`.
- **§2.7 MIGRATION + tag** (this commit): `src/__tests__/MIGRATION.md` finalized with per-file DELETED/SPLIT/KEPT/DEFERRED entries against the `phase-1-complete` baseline. `phase-2-complete` tag applied.

**Retirement ledger progression**:

- ✅ `src/shared/coral-fault.ts` — DELETED (§2.2).
- ✅ `src/execution/{recovery-core,abort-controller-registry,agent-resolution,instruction}.ts` — DELETED (§2.2).
- ✅ `src/execution/lifecycle/*` — DELETED (§2.2).
- ✅ `src/execution/discuss/*` (13 files) — DELETED (§2.4).
- ✅ `src/workflow/{pipe-executor,pipe-parser,handler,types}.ts` — DELETED (§2.5).
- ✅ `WorkflowCheckpoint`, `SessionContinuityPatch`, `CoralFault`, `Persisted*Record`, `ProviderResult`, `ProviderProgressEvent`, `TerminalResult` — PURGED repo-wide (§2.2–§2.6).
- ✅ `coral_fault` discriminant — RENAMED to `legacy_fault` on the compat module only (§2.2).
- ⏭ `src/execution/session-manager.ts` (9-line shim re-exporting from `src/sessions/shell/`) — retires in Phase 3 when the last importer moves off the shim.
- ⏭ `src/execution/job-lifecycle.ts` (3-line shim re-exporting from `src/jobs/shell/`) — retires in Phase 3 with the coordinator extraction.
- ⏭ `src/execution/recovery-registry.ts` (94 lines) — handoff to `src/coordinator/**` in Phase 3.
- ⏭ `src/execution/progress-store.ts` (712 lines) — retirement trigger "delete in Phase 4 once the last transport adapter reads Journal projections directly" (see §2.5 disposition).
- ⏭ `src/shared/legacy-terminal-outcome-compat.ts` — retires in Phase 6 when provider adapters emit domain `TerminalOutcome` directly.
- ⏭ `src/jobs/shell/legacy-ingest.ts` — retires in Phase 6.
- ⏭ `src/execution/{server,composition/**,event-bus,recording-observer,smoke-open-store,backend-core,backend-core-types,server-types,idle-timer,engine,host-manager,lifecycle{,/network,/shutdown-mode,/shutdown-sequence},service}.ts` — handoff to `src/coordinator/**` in Phase 3.
- ⏭ `src/execution/{tool-response,query-coerce,http-handler,backend-contracts}.ts` — handoff to `src/transport/**` in Phase 4.
- ⏭ `src/execution/kb-tools.ts` — Phase 5 KB handoff.
- ⏭ `src/execution/simulation/**` — handoff to `src/simulation/**` in Phase 7; `src/execution/simulation/schema.ts` and `src/execution/simulation/core/index.ts` remain the named `legacy-terminal-outcome-compat` consumers until Phase 7.

**Verification**: `npm run build` (prod + dev) clean; `npm run lint` clean; `npm test` green; integration suite green; `rg "\bCoralFault\b" src/ --type ts` → zero; `rg "coral_fault\s*\{\s*fault:" src/ --type ts` → zero; `rg "PersistedStatusRecord|PersistedLaunchRecord|PersistedRuntimeRecord|PersistedExitRecord|PersistedProgressRecord|WorkflowCheckpoint|ProviderResult|ProviderProgressEvent|TerminalResult|SessionContinuityPatch" src/ --type ts` → zero. All 12 Phase 2 acceptance criteria satisfied.

## Phase 3 — Coordinator Consolidation (complete)

Tag: `phase-3-complete` @ rewrite branch.

Phase 3 finishes the backend split. The daemon now composes a coordinator seam for lifecycle, startup recovery, ConsumerDriver freshness, corpus notify publication, and provider-host orchestration, plus a transport seam for HTTP/SSE parsing and wire formatting. `src/execution/` is deleted outright.

**Delivered**:

- **CG6 shared-ownership cleanup**: `src/execution/__tests__/service.test.ts` retired into the jobs/coordinator-owned destinations; `src/execution/__tests__/progress-store.test.ts` retired behind the projection rebuild proof; `src/shared/types.ts`, `src/shared/persistence-parsers.ts`, and `src/shared/persistence-readers.ts` were deleted; and the remaining AC9 MINOR rationale/comments landed.
- **CG7 layering invariant replacement**: `src/__tests__/invariants/execution-composition-only.test.ts` and `src/__tests__/__helpers__/execution-residue-ast.ts` retired in CG7; `src/__tests__/invariants/architecture-layering.test.ts` replaced the Phase 2 residue harness (see `src/__tests__/MIGRATION.md`).
- **CG8 execution deletion + phase closeout**: the last backend composition residue moved into coordinator ownership, job lifecycle contracts moved into the jobs shell, `src/jobs/job-store.ts` became the journal-backed job query/read-through seam, and `src/coordinator/bootstrap.ts` became the daemon main entry while `src/coordinator/coordinator.ts` remained the testable composition root.
- **Compatibility/regression fixes**: the file-level execution shims are gone, with any remaining backend-lock compatibility localized inside `src/coordinator/lock.ts`; the in-process server harness regained real migration coverage with an in-memory fallback when its temp roots do not exist yet; the durable `result.md` artifact path returned to the job directory contract; and the discuss golden-capture / simulation-sealing helpers were rewired to the post-execution homes.
- **Docs and ledgers**: architecture docs now describe the coordinator/transport split at the seam level, `MIGRATION.md` records the final execution-file disposition, and the design philosophy source-tree policy reflects the no-`src/execution/` end state.

**Retirement ledger progression**:

- ✅ `src/execution/` — DELETED in CG8.
- ✅ `src/execution/{session-manager,job-lifecycle,recovery-registry,smoke-open-store,backend-lock,backend-core,backend-core-types,server,server-types,service,lifecycle,progress-store,composition/**}` — retired or moved to coordinator/jobs/store homes in CG8.
- ✅ `src/execution/__tests__/service.test.ts` — DELETED after the CG6 split.
- ✅ `src/execution/__tests__/progress-store.test.ts` — DELETED in CG6.
- ✅ `src/infra/backend-info.ts` — DELETED in Phase 3; discovery now lives under coordinator ownership.
- ✅ `src/client/backend-lifecycle.ts` — DELETED in Phase 3.
- ✅ `src/shared/types.ts` — DELETED in CG6.
- ✅ `src/shared/persistence-parsers.ts` — DELETED in CG6.
- ✅ `src/shared/persistence-readers.ts` — DELETED in CG6.
- ⏭ `src/shared/legacy-terminal-outcome-compat.ts` — retires in Phase 6 when provider adapters emit domain `TerminalOutcome` directly.
- ⏭ `src/jobs/shell/legacy-ingest.ts` — retires in Phase 6.

**Verification**: `npm run lint` clean; `npm run build` clean; `npm run build:dev` clean; `npx tsc --noEmit` clean; `npm test` green (`1619 passed | 30 skipped | 3 todo`, `144` files / `1652` tests); `npx vitest run --config vitest.integration.config.ts` green (`18 passed`, `7` files); `node scripts/verify-runtime-cutover.mjs` exits 0; `bash scripts/verify-native-binding.sh` exits 0 with `ok`; `rg "\bCoralFault\b" src/ --type ts` → zero; `rg "coral_fault\s*\{\s*fault:" src/ --type ts` → zero; `rg "PersistedStatusRecord|PersistedLaunchRecord|PersistedRuntimeRecord|PersistedExitRecord|PersistedProgressRecord|WorkflowCheckpoint|ProviderResult|ProviderProgressEvent|TerminalResult|SessionContinuityPatch" src/ --type ts` → zero; `ls src/execution` → ENOENT; `grep -R "from ['\"].*execution/" src/` → zero; `grep -R "from ['\"].*shared/types\\.js\\|shared/persistence-(parsers\\|readers)" src/` → zero; `grep -RE "from.*execution/(session-manager|job-lifecycle|recovery-registry|smoke-open-store|backend-lock)" src/` → zero. All 12 Phase 3 acceptance criteria satisfied.

### Phase 3 follow-up review fixes (rewrite branch)

- Post-tag review fixes tightened the coordinator seam without reopening the large refactor: `src/coordinator/api.ts` is now documented and invariant-tested as explicit coordinator glue, its local `*RequestPort` interfaces were renamed to avoid collisions with transport contracts, and `src/coordinator/bootstrap.ts` absorbed the `--smoke-open-store` path so `src/coordinator/smoke-open-store.ts` could be deleted.
- Journal consumer registration is now factory-backed (`src/store/projection-consumer.ts`) instead of four copy-pasted `consumer.ts` implementations, backend-lock compat helpers are deduplicated in `src/coordinator/lock.ts`, and workflow result artifact writes are atomic again.
- Follow-up tests/docs now cover the release-before-acquire lease clamp, explicit cold-start liveness, a tighter warm-start handoff expectation, current runtime-state paths, and the coordinator-glue allowance in the design philosophy / topology docs.
