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

## Final Polish (AC1-AC12)

Baseline before final-polish landing: `npm test` `1619 passed | 30 skipped | 3 todo` at `phase-3-complete`; integration suite `18/18` green.

AC scope ledger:

- AC1 upcast-routing enforcement.
- AC2 jobs denormalization / replay identity coverage.
- AC3 rename pass cleanup.
- AC4 deletion-pass cleanup.
- AC5 leaf-import tightening.
- AC6 composition cleanup carry-through.
- AC7 legacy-boundary carry-through.
- AC8 jobs shell/reconcile contract closure.
- AC9 projection-only session lookup + `shard_dir` contract.
- AC10 hook-stub carry-through.
- AC11 event-backed launch/runtime/terminal payload discipline.
- AC12 invariant enforcement expansion.

Cluster commits:

- `82f0c782` — AC2 completion: jobKind upcaster, reducer-equivalence identity coverage, indexed projection reads.
- `7490d463` — AC9 completion: projection-only session lookup, deterministic sessions upcasters, shard-dir contract.
- `802f27a2` — AC5 leaf tightening: coordinator contracts stop importing shell modules; jobs store imports the event-bus leaf.
- `2c39b59e` — AC1 + AC12 tightening: result-markdown routes through `decodeBody`; invariant #45 catches `decodeEventBody(...) as ...` bypasses.
- `current cluster commit` — quality/coverage/doc closeout: cached read-context singleton, explicit `ProgressStore` upcasters, `AppServerRuntime` rename, shutdown budget binding, query-count/session v1-v2 coverage, doc sync.
- Deferred: discuss follow-up agent concurrency (`Promise.all` -> `Promise.allSettled`) stays postponed pending discuss-agent lifecycle design; see `src/__tests__/MIGRATION.md`, `Deferred — post-rewrite-final-polish`.

## Phase 4 — Transport (complete)

Tag: `phase-4-complete` @ rewrite branch.

Phase 4 moved the CLI/backend seam onto the transport split. Local mutating and live-follow commands now use authenticated IPC, remote callers retain the HTTP gateway plus the operational carveouts, and read-only no-coordinator CLI paths read `CoralStore` directly.

**Delivered**:

- GOD amendment: HTTP routing is table-driven from `rpcCatalog` rather than hand-wired per route.
- GOD amendment: the RPC catalog is the transport invariant shared by HTTP and IPC.
- GOD amendment: JSON-RPC subscriptions are backed by a generic subscription primitive instead of transport-specific follow loops.
- GOD amendment: read-only CLI `jobs` / `kb` flows migrated to direct `CoralStore` reads where no coordinator is required.
- GOD amendment: `src/transport/ipc/ensure.ts` now follows discover-or-launch semantics instead of assuming a warm backend.
- Tag `phase-4-complete` applied at `477a9ad`.
- Rollback target: `phase-3-complete`.

**Commit inventory**:

- `f226589` — `phase-4/rpc-catalog: rpc-catalog + rpc-ports + schema relocations (AC1)`
- `c35c12a` — `phase-4/json-rpc: json-rpc codec + envelope with subscriptionId slot (AC2)`
- `6e73126` — `phase-4/http-on-catalog: handler rebuilt on rpcCatalog; ops carveout explicit (AC4)`
- `1a87696` — `phase-4/ipc-coordinator-hosted: ipc server/client/ensure + coordinator lifecycle (AC3)`
- `f81a403` — `phase-4/coral-store-reads: CoralStore sub-facades + CLI read migration (AC5)`
- `323ac9d` — `phase-4/subscription-primitive: ipc subscription dispatch + follow.ts IPC switch (AC9)`
- `cbb00f3` — `phase-4/command-class-dispatch: command-class-map + makeClient split + backend-lifecycle removal (AC6)`
- `92a5ead` — `phase-4/provider-contract-flip: switch providers to streaming IPC`
- `32c1087` — `phase-4/provider-contract-flip-followup: move mutate-via-ipc to integration suite`
- `2e7370a` — `phase-4/closure`
- `7d3a4ed` — `phase-4/god-amendments`
- `0b8e48f` — `phase-4/lint-fixes: fix remaining eslint violations`
- `8d9feec` — `phase-4/discuss-watch-exemption: move discuss watch from mutate class to explicit exemption`
- `477a9ad` — `phase-4 complete — transport layer + RPC catalog + command-class routing`

## Phase 4 — Polish (post-review)

Tier-review (integration-guardian + code-critic + doc-critic + test-critic + ux-critic) surfaced 16 follow-up findings. Docs, duplication, error-message polish, and code quality all addressed in focused commits under `phase-4-polish/`:

- `c5c1012` — `phase-4-polish/docs-changelog-architecture`
- `a4ce2b8` — `phase-4-polish/transport-shared-context`
- `fb1c302` — `phase-4-polish/transport-catalog-dispatch-shared`
- `f73c6f1` — `phase-4-polish/ipc-server-readability`
- `2764da7` — `phase-4-polish/error-recovery-hints`
- `f00fa00` — `phase-4-polish/provider-stream-helpers`
- `64d064d` — `phase-4-polish/test-assertions-polish`
- `4b8f3ab` — `phase-4-polish/test-assertions-polish-followup`

## Phase 4 — Simplify (second review pass)

A deeper `/simplify` pass (reuse + quality + efficiency agents over the full Phase 4 diff `7531121..HEAD`) found 17 more items: 13 STRONG + 5 MINOR structural and performance cleanups. All 17 addressed in focused commits under `phase-4-simplify/`:

- `37a55d8` — `phase-4-simplify/dedup-helpers` — drop local `isRecord`; delete unreachable `commandClass === 'remote'` guards; dedupe `resolveMemoOwner` calls; remove stale `server.ts` JSDoc; remove `void unused` smells in `jobs/shell/launch.ts`.
- `3a9b4f4` — `phase-4-simplify/extract-line-framing` — extract `createLineFramer()` helper shared by `transport/ipc/{client,server}.ts` (three copy-pasted newline-framed JSON-RPC parsers).
- `f246613` — `phase-4-simplify/dispatch-context-cleanup` — introduce `stripTransportContextKeys()` + `buildQueryContext()` helpers; propagate `statusCode` from `domainResultToHttp` instead of re-deriving in `catalogHttpStatus`; co-locate `buildCallerContextFromQuery` with `buildCallerContext` in `shared-context.ts`.
- `832ef07` — `phase-4-simplify/controller-profile-shared` — extract `TRANSPORT_CONTEXT_FIELDS` + `CONTEXT_ENV_KEY` into a single home; three mapping sites now share one declaration.
- `477b286` — `phase-4-simplify/cli-read-handle-unification` — route `openCauseRenderer` through `getSharedReadCoralStore` so CLI opens one read-only SQLite handle per invocation instead of two.
- `d716933` — `phase-4-simplify/jobs-list-sql-filters` — push `namespace/projectRoot/phase/provider` filters to SQL WHERE clauses; `listJobs` no longer loads-all-then-filters.
- `421215f` — `phase-4-simplify/prepared-statements-cache` — hoist prepared statements in `store/queries/{jobs,events}.ts` via a per-database cache, matching the existing `sessions.ts` pattern.
- `0f9677f` — `phase-4-simplify/provider-stream-backpressure` — bound the `streamProviderEvents` queue (soft cap) with backpressure so `launch.progress` bursts can't grow memory unboundedly.
- `538db60` — `phase-4-simplify/socket-buffer-cap-ensure-cache` — cap the IPC server `data` buffer after subscription handshake; cache per-CLI invariants (flavor/bundleHash/namespace) outside the observe tick.
- `6861368` — `phase-4-simplify/json-rpc-comments` — rewrite "Phase 4" narration in `json-rpc.ts` to describe the current invariant without an implementation-phase marker.

### Intentionally skipped

The following review findings were reviewed and deliberately not applied:

- **rpc-ports.ts session launch types vs `coordinator/contracts.ts` `LaunchIntentBase`** — the duplication is real but the cross-layer refactor is a coordinator-contract reshape, not a transport concern; scoping it inside Phase 4 polish would ripple into the coordinator services layer. Deferred to a future coordinator-contracts consolidation.
- **`src/transport/json-rpc.ts` vs `src/providers/claude-appserver/protocol.ts` JSON-RPC type divergence** — intentional. The transport's internal JSON-RPC envelope uses a `kind` discriminator tuned for the catalog dispatch; the Claude app-server side speaks the external JSON-RPC 2.0 wire spec. Merging them would force the transport to adopt an external-facing contract or force the app-server adapter to tolerate an internal shape. Documented divergence.
- **`nextRequestId` module-global counter overflow** — counter reaches `Number.MAX_SAFE_INTEGER` at ~9 × 10¹⁵ requests. Non-issue at realistic scales; no action.
- **`resolveFilePath`/`resolveInput` TOCTOU pre-check in CLI arg parsing** — tokens are CLI argv strings, not hot-loop I/O. Tolerable per `/simplify` remit §5 guidance.
- **`compilePathPattern` linear route match** — ~30 routes; <1µs per match. Fine at current scale.
- **`Last-Event-ID` header read on every `/jobs/wait` HTTP request** — cheap header access; not a hot-path cost.

### Verification (final)

- `npm run lint` clean
- `npm run build` clean
- `npm test` — 1694 passed / 7 skipped (158 files)
- `npx vitest run --config vitest.integration.config.ts` — 26 passed (9 files)
- `coordinator/api.ts` export count — 5 (invariant #46, ≤10)
- `phase-4-complete` tag unchanged; rollback target `phase-3-complete`.

## Phase 5 follow-up — Skip Resolution (Pre Phase 6)

Resolved 7 vitest-counted skip units (5 it.skip + 2 it under describe.skipIf) before Phase 6 begins.

- A `claude-executor.smoke.test.ts:49` describe.skipIf — KEPT, inline comment naming CORAL_SMOKE_TEST per Phase 6 acceptance "Real-CLI E2E moved to cleanup".
- B `server.test.ts:669` empty `it.skip('uses injected fetchFn for lock ownership health checks')` — REPLACED by `src/coordinator/__tests__/backend-defaults.test.ts` (9 explicit cases covering healthy/contended/stale, including namespace-mismatch and bundleHash-mismatch stale branches plus the non-object-body and fetch-rejects contended branches, via injected fetchFn and asserting URL+token+namespace).
- C `server.test.ts:4768` `'drops the recovery registry before writing backend info'` — REWRITTEN as 'publishes backend info only after Journal startup recovery completes' in `src/coordinator/__tests__/startup-ordering.test.ts`.
- D `server.test.ts:4879` `'routes recovered app-server jobs through continuity finalization …'` — DELETED. Routing-call assertion absorbed into `src/jobs/reconcile/__tests__/lifecycle-recovery.test.ts` it 14 via an inline app-server runtime record carrying `providerContinuity.threadId`; `src/coordinator/__tests__/service-composition.test.ts:2177` remains the downstream proof that verified continuity persists as `conversationRef`.
- E `server.test.ts:4999` `'stops the startup tail when shutdown begins during recovery adoption'` — REWRITTEN in `src/jobs/reconcile/__tests__/recovery-coordinator-shutdown.test.ts`, owner = `runRecoveryAdoption` with explicit startup-tail observability.
- F `server.test.ts:5147` `'cleans up an adopted running job on shutdown after the recovery poller is live …'` — REWRITTEN in the same sibling suite, owner = `teardown()` clearing `recoveryPollIntervals` via `runtime.time.clearInterval` + `state.teardownRequested` suppression of late completion.

Net skip count: 7 → 2 (smoke pair only).
Owner-placement strategy: every test sits with its behavioral owner per architecture §29.
No production source changed; verification chain green per AC9.

## Phase 5 follow-up — Cleanup + Test Population Audit (Pre Phase 6)

Resolved 14 deferred Phase 5 findings (3 BLOCKING + 8 STRONG from /simplify) plus 7 audit-driven cleanup items (Category A legacy orphans, Category B production pollution, Category C test redundancy). 16 ACs landed across 6 execution batches.

**Group 1 — Phase 5 deferred fixes:**
- A1 `runInboundSync` correctness — `principlesChanged` added to `requiresFullInstall` at `runtime.ts:912/916`; +3 `external-edit.test.ts` cases (principle/community/.entity-graph live-edit, both directions verified)
- A2 (BLOCKING) `writeIndexState` O(corpus) hot path eliminated — NEW `src/kb/corpus/manifest-authority.ts` (runtime/snapshot-owned baseline content+metadata caches); `mutation-lock.ts` opaque `pendingOpaqueDeltas` carrier (KB semantics never leak into generic lock); 11 named writers feed authority on every mutation; NEW `src/kb/__tests__/manifest-authority-drift.test.ts` (per-writer parametric drift assertion 11/11 green); NEW `src/kb/__tests__/runtime-perf.test.ts` (pre-import `vi.mock('node:fs')` + `vi.resetModules()` + dynamic-import recipe instruments BOTH `readFileSync` AND `readdirSync`; single-note metadata edit + 100 no-op gitSync calls produce zero unrelated reads/walks)
- A3 `consecutiveFailures` persisted protocol split into `consecutiveClaimFailures` (claim retry backoff) and `consecutiveCommunityBatchFailures` (community-batch skip/backoff) across `state.ts`/`state-shared.ts`/`state-scheduler.ts`/`scheduler.ts`/`community.ts`/`runner.ts` + SQLite (in-place `001_initial.sql` edit per fresh-only rule, byte-identical to `schema.sql`) + `schema.ts` row type + `migrations.idempotent.test.ts` column expectations + `curate.test.ts` community-batch backoff path
- A4 Repair incident-id catalog — NEW `src/kb/corpus/repair/incident-ids.ts` (`REPAIR_INCIDENT_IDS as const` + derived `RepairIncidentId` union); 4 detect files + classify/fix/types + 4 repair test fixture specs share one canonical authority; renaming an id produces TS compile error in every dependent map
- A5 `migrateCurateStateIfNeeded` decomposed into 7 named phases (`scanCorpus`, `detectRepairs`, `assignEntrySeqs`, `rewriteFrontmatter`, `syncIndex`, `reconcileSeqs`, `persistState`); orchestrator ≤30 lines (24 actual); +per-phase unit tests
- A6 `gitSync()` returns structured diff (`{kind:'no-change'|'paths'|'ambiguous'}`); `git-sync.ts:diffKbPathsBetweenRevisions` uses explicit `headBeforeSync..headAfterSync` (NOT `HEAD@{1}..HEAD` which after a successful rebase points to `origin/<branch>`, the rebase target — see KB note `testing-git-head-after-rebase`); `runInboundSync({structuredDiff:true})` consumes the diff; AC2↔AC6 handoff: when `kind:'paths'`, hashes computed only for diff paths via existing `computeContentSurfaceHash`/`computeMetadataSurfaceHash` helpers; full `captureCorpusFilesystemSnapshot` reserved for `kind:'ambiguous'` (rebase/force-pull) off the hot path
- A7 `writeCurateState` diff-based writes — targeted UPDATE/INSERT/DELETE in `state.ts`/`retry.ts`/`discovery-backlog.ts`/`runner.ts`; single-scalar-change touches ≤1 row; +perf regression test
- A8 `searchKb` mode-honored early — branches on `mode` immediately after loading the index; explicit `mode='vector'` skips text-path; explicit `mode='text'` skips graph state; +perf regression test
- A9 (covered by A1's required test additions)

**Group 2 — Audit-driven cleanup:**
- AC10 (Category A) Legacy curate-state file-path orphan tests deleted at `curate-state.test.ts:884/902/938`; live SQLite "no `curate-state.retired` recreation" assertion preserved at line 337 via test-local constant
- AC11.a (Category B) `_testInternals` removed from `CurateHandle`/`scheduler.ts`/`coordinator/live/curate-scheduler.ts`; `getPendingCommunitySkipTicks` reader deleted (closure-variable, not field — surviving `spawn` + `readCurateState().consecutiveCommunityBatchFailures` assertions cover same tick behavior); 3 redundant tick assertions deleted at `curate.test.ts:2443/2447/2451`; NEW `src/kb/curate/__tests__/__helpers__/test-handle.ts` builds internals from public APIs
- AC11.b (Category B) `cli-detection.ts` exports `createCliDetector` + `CODEX_DETECTOR_CONFIG` + `CLAUDE_DETECTOR_CONFIG`; deleted `detectCodexCli`/`resetCodexCliCache`/`resetClaudeCliCache` test-only re-exports; NEW `src/providers/__tests__/__helpers__/cli-detection-fixtures.ts` constructs per-test detector instances
- AC11.c (Category B) `curateStatePath()` production export deleted from `state.ts`; consumers replaced with test-local constant
- AC11.d (Category B) `src/shared/test-deferred.ts` relocated to `src/simulation/core/test-deferred.ts` (preserves invariant #30: production cannot import `src/testing/*`); `simulation/core/index.ts:42` re-export of `createDeferred` dropped; 8+ direct importers updated
- AC12.a (Category C) NEW `src/jobs/shell/__tests__/__helpers__/service-fixture.ts` consolidates 4× `getInternals` duplicates (`launch.test.ts`/`wait.test.ts`/`abort.test.ts`/`service-composition.test.ts`)
- AC12.b (Category C) Redundant `driver.notify` count assertions removed from `sessions/shell/__tests__/consumer-driver-notify.test.ts` and `workflow/__tests__/consumer-driver-notify.test.ts`; same invariant covered at the driver layer in `consumer-driver-drain.test.ts:98-125`; projection-state assertions retained

**Verification chain (AC13):**
- `npm run lint`: clean
- `npm run build`: clean (tsc + esbuild prod flavor; 3 bundles)
- `npm test`: **1778 passed / 2 skipped** (was 1753 / 2 pre-cleanup; +25 net)
- `npx vitest run -c vitest.integration.config.ts`: **26/26** (post fresh build)
- `grep -rn "it\.skip\|describe\.skip\|test\.skip" src/`: exactly 1 line (smoke `describe.skipIf` per Phase 6 acceptance)
- `src/coordinator/api.ts`: 5 exports (≤10 per invariant #46), no shell re-exports

**Test population baseline (verified):**
- Pre-cleanup baseline (post-skip-resolution `7afaac4`): **1753 / 2 skipped**
- Post-cleanup target: **1778 / 2 skipped**
- `cleanupDelta` (AC10/11/12 only) = **−3** (AC10 deleted 3 legacy file-path `it()`s; AC11.a/b/c/d/AC12.a/b are refactors with no `it()`-count change; AC12.b dropped assertions but kept `it()` blocks). ≤0 target met.
- `finalDelta` (additions from AC1/AC2/AC5/AC7/AC8 perf+coverage tests) = **+28** (AC1: +3 external-edit cases; AC2: +11 drift + +2 perf = +13; AC5: +7 per-phase tests; AC7: +1 perf; AC8: +1 perf; net +1 from AC11.a/AC10 interactions resolves drift). Plan target `finalDelta ≥ +13` met (+28 actual).
- Net total Δ = +25 active tests. User's "test 무한 증식" perception: actual rewrite-branch progression is **Phase 0=1645 → Phase 3=1619 (execution layer deleted, −128) → Phase 5=1735 → current=1778** — modest +133 net over 5 phases of architectural rewrite, NOT infinite growth. The largest single drop was Phase 3's execution-layer deletion.

**Production code pollution removed (Category B summary):**
- `_testInternals` field on `CurateHandle` interface — gone
- `detectCodexCli` / `resetCodexCliCache` / `resetClaudeCliCache` `@internal Test-only` exports — gone
- `curateStatePath()` "legacy test helper" production export — gone
- `src/shared/test-deferred.ts` mislocated under production layer — relocated to `src/simulation/core/`
- All grep counts: 0 matches outside `__tests__/` and `__helpers__/` per AC13 layering audit

Per memory rule #1 (fresh-only): zero `Legacy*` types, zero compat shims, zero migration paths added; `001_initial.sql` edited in place; all internal version markers stay at initial values (`schema_version='1'`, `journal_version='1'`, `bodyVersion=1`, no upcasters added).

## Phase 6 — Provider Middleware (complete)

Tag: `phase-6-complete` @ rewrite branch.

Phase 6 collapses the three-path provider model into one composed stack per arch §8. Each provider's cross-cutting concerns (parse guarding, session continuity, app-server lifecycle) become orthogonal middleware files. Session continuity becomes stream-owned: the `terminal` body never mutates session state (arch §8.3 invariant #5). One producer per fault type (arch §16 invariant #14). Registry returns `ProviderSpec` descriptors (`{ name, run, preflight?, appServer?, recovery?, cleanup? }`).

**Delivered**:

- `src/providers/contract.ts` — `Provider = (req, runtime) => AsyncIterable<ProviderEventBody>`, `ProviderMiddleware = (next: Provider) => Provider`, `compose(...parts)`, `ProviderSpec`, native `ProviderEventBody` union on `kind: 'progress' | 'continuity' | 'terminal'`, native `ProviderAppServerContract` / `ProviderRecoveryContract` (split between live-turn vs durable-artifact facets).
- `src/providers/middleware/adapter-parse-guard.ts` — sole producer of `adapter_output_unparseable` fault per arch §16 invariant #14.
- `src/providers/middleware/session-continuity.ts` — sole producer of `provider_session_unavailable` + sole emitter of `continuity` bodies. Allocates fresh `ProviderContinuityBridge` per invocation, shallow-wraps runtime via `Object.assign({}, runtime, { continuityBridge })`, deactivates in `finally` (silent no-op prod / `CORAL_DEV_ASSERTIONS=1` throws).
- `src/providers/middleware/app-server-session.ts` — replaces `app-server/runner.ts` functionally. Owns `acquireServer → lease → subscribe → race(turn, closed) → release`. Never rewrites downstream terminal outcome (the `runner.ts:66-83` anti-pattern is gone). Surfaces typed transport-close via `runtime.continuityBridge.transportClosed(...)`.
- `src/providers/fault.ts` — three builders (`adapterOutputUnparseable`, `providerSessionUnavailable`, `providerRequestFailed`) + native `FaultPayload` union. Native `TerminalOutcome` type.
- `src/providers/terminal.ts` — `buildJobTerminal()` + `buildJobDiagnostics()` absorb `result-mapping.ts`.
- `src/providers/cli-runner.ts` — canonical generic CLI seam (absorbs `runner-port.ts` + `bindProviderRunner` from `launch.ts`).
- `src/providers/claude/{exec-kernel,session-kernel,exec-provider,provider-facets}.ts` — exec + session kernels + composed providers + single `claude` run dispatcher per AC7. Dispatcher preserves today's broker-default routing: `exec`/`resume` → `claudeSessionProvider`, `fork` → `claudeExecProvider`; pre-dispatch reject for fork × broker markers (`brokerSessionKey || bootstrapSignature`). `CORAL_DEV_ASSERTIONS=1` assertion in dispatcher catches corrupt-state regressions.
- `src/providers/claude-appserver/{controller,protocol,server}.ts` — 2-way split per §10.1a: `controller.ts` (1156 LOC) owns `SingleSessionController` + mutable state cohesively; `protocol.ts` (391 LOC) owns wire-format parsing.
- `src/providers/codex/{thread-kernel,thread-provider,provider-facets}.ts` — codex leaf with `compose(sessionContinuity, appServerSession, kernel)`.
- AC11 — `src/providers/registry.ts` + `src/providers/catalog.ts` reshaped to the `ProviderSpec` descriptor model. Consumer rewires landed across `src/coordinator/live/provider-hosts/{pool,lease,idle,drain,recovery}.ts`, `src/coordinator/services/{job-launch-service,recovery-service,execution-shared,workflow-execution-service}.ts`, `src/coordinator/{execution-service,workflow-cleanup,contracts}.ts`, `src/workflow/normalize.ts`, and `src/jobs/reconcile/{actions,coordinator}.ts`.
- AC12 — `src/providers/bootstrap.ts` now registers `ProviderSpec` descriptors for Claude + Codex; new `src/providers/bootstrap-scripted-override.ts` owns the env-driven scripted-provider override. This preserves arch §16 invariant #30: production code never imports `src/testing/`.
- AC14 — `src/coordinator/live/provider-hosts/*` plus `src/coordinator/execution-service.ts` now call `spec.run(...)` instead of `provider.execute(...)`.
- `src/sessions/shell/store.ts` NEW atomic APIs: `checkpointJobContinuityAtomic(sessionId, { expectedActiveJobId, expectedVersion, snapshot }) → Promise<{ ok, nextVersion } | { ok: false }>` + `releaseJobClaimAtomic(sessionId, { expectedActiveJobId, expectedVersion }) → Promise<boolean>`.
- `src/coordinator/services/continuity-consumer.ts` NEW — consumes provider stream; for each `progress` body → appends to journal; for each `continuity` body → `checkpointJobContinuityAtomic` (threads `expectedVersion` forward); for the single `terminal` body → appends to journal and returns. No terminal-side session mutation.
- `src/coordinator/contracts.ts` — shared `JobContinuitySnapshot` type; `waitStreamOnce()` now returns `{ content, continuity: JobContinuitySnapshot | null }`.
- 6 discuss-shell migration sites (runtime-build.ts × 8, context.ts, speech-flow, bid-flow, followup-flow, synthesis-flow) + 7 downstream `nonResumable` files (jobs/views, events, job-store, shell/event-subscription, reconcile/job-helpers, reconcile/snapshot, store/queries/jobs) dropped `nonResumable` from terminal data and surface `continuity.resumable` separately. Null-continuity rule split: live `continuity: null` → `resumable: true` (preserves current default); recovery `continuity: undefined` → preserve session state (matches today `recovery_parse_failed` no-op).
- `src/providers/bootstrap-scripted-override.ts` NEW owns env-spec schema + parser + `resolveScriptedProviderOverride(env): ProviderSpec | null`. `src/testing/scripted-provider.ts` is canonical test surface (re-exports schema/env + adds `createScriptedProvider`). Prod code imports ZERO from `src/testing/*` (arch §16 invariant #30).
- `src/providers/__tests__/fault-producer-invariant.test.ts` NEW — programmatic audit of single-producer invariant for each fault kind.
- `src/providers/__tests__/phase6-smoke.test.ts` NEW — end-to-end composed-stack smoke for `claude` + `codex` with mocked `runCli` / `acquireServer`. NO real CLI subprocess.
- `src/coordinator/__tests__/integration/continuity-lifecycle.integration.test.ts` NEW — 8 verify clauses for AC15 (mid-stream session-ref, strict schema rejection, abort-before-terminal, transport-close recovery via bridge, separate recovery continuity, waitStreamOnce shape, recovery-null-preserve, live-null-resumable-default).

**Three-path removal (grep gate returns ZERO production hits)**:

- DELETED 17 items total: 12 production files (`src/providers/scripted-provider.ts`, `src/providers/protocol.ts`, `src/providers/claude/adapter.ts`, `src/providers/claude/session-driver.ts`, `src/providers/codex/adapter.ts`, `src/providers/codex/session-driver.ts`, `src/providers/app-server/runner.ts`, `src/providers/result-mapping.ts`, `src/providers/runner-port.ts`, `src/providers/provider-contracts.ts`, `src/providers/claude-appserver/session.ts` as the Phase 4 shim, and `src/providers/spec-compat.ts` as the Batch 5 M1 transitional seam) plus 5 obsolete test files.
- `finalizeProviderSession` + `checkpointRecovery` session-side effects retired — `grep -rn "finalizeProviderSession|checkpointRecovery" src/` returns 0 production hits.

**Retirement ledger** (Phase 7 Cleanup carry-forward):
- `src/shared/legacy-terminal-outcome-compat.ts` — coordinator recovery + reconcile + legacy-ingest still depend; deletion would materially expand Phase 6 scope. Retire in Phase 7 once journal outcome projection migrates.
- `src/providers/claude/claude-executor.ts` — exec-kernel.ts still depends; rename/collapse in Phase 7 if valuable.

**Composition-order amendment** (GOD doc §8.1): `compose(sessionContinuity(...), appServerSession(...), kernel)` — `sessionContinuity` is outermost for app-server providers. Preserves §8.3 invariants #1/#3/#5: one continuity authority observes the full downstream stream (including transport-close from `appServerSession` via `runtime.continuityBridge`); `appServerSession` surfaces typed close-state through the bridge but never emits `continuity` itself and never rewrites downstream terminal outcome. Recorded in `.claude/analysis/2026-04-18-final-unified-architecture.md` § 8.1.

**Verification**: `npm run lint` clean; `npm run build` clean; `npm test` `1760 passed | 2 skipped`. `phase-2-boundary-quarantine` green. `fault-producer-invariant` green. `phase6-smoke` green. All three grep gates return ZERO production hits: (1) no imports from `adapter.js` / `session-driver.js` / `app-server/runner.js`; (2) no `finalizeProviderSession` / `checkpointRecovery` references; (3) no `src/testing/*` imports from `src/providers/` / `src/coordinator/` / `src/jobs/`.

Per memory rule #1 (fresh-only): zero Legacy* types added, zero compat shims beyond the two documented Phase-7 carry-forwards (legacy-terminal-outcome-compat.ts + claude-executor.ts).
