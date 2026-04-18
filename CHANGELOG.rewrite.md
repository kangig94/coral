# Rewrite Changelog

## Phase 0 — Foundation (complete)

Tag: `phase-0-complete` @ rewrite branch.

Phase 0 lays down the skeleton of the new Journal + Corpus architecture on the `rewrite` branch. No behavior change — the marketplace-installed plugin at `~/.claude/plugins/cache/coral/coral/<version>/` continues to serve users from the pre-rewrite release.

**Delivered**:
- Legacy-isolation invariant + scanner exclusions (`src/__tests__/__helpers__/ts-import-scanner.ts`, `scripts/verify-simulation-sealing.mjs`). AC1 move set: 0 files — the per-file collision rule kept every pre-rewrite module in place.
- Full SQLite schema at `src/store/schema.sql` and `src/store/migrations/001_initial.sql` (content-identical at Phase 0). TypeScript row types in `src/store/schema.ts`. Idempotent migration runner at `src/store/migrations.ts` (zero `db.totalChanges` delta on rerun). Build-time asset copy into `dist/store/`.
- `CoralSetupError` class contract at `src/runtime/errors.ts`.
- `BuildFlavor` type + `resolveBuildFlavor(env)` pure resolver at `src/runtime/flavor.ts`. `npm run dev` now sets `CORAL_FLAVOR=dev`.
- Per-owner path factories: `src/store/paths.ts`, `src/kb/corpus/paths.ts`, `src/coordinator/info.ts` (with Darwin=104/Linux=108 socket fallback), `src/jobs/exports/paths.ts`, `src/infra/equipment-paths.ts`.
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
- `SimulationRuntime` canonical home at `src/simulation/runtime.ts` (L1-scoped in Phase 1). Deterministic doubles stay under `src/execution/simulation/core/*`. `core/index.ts` kept as compat barrel re-exporting FROM new home. 1000-event determinism test asserts three runs produce byte-identical state.
- Native-binding scratch-dir smoke at `scripts/verify-native-binding.sh` + `src/execution/smoke-open-store.ts` — exercises the built bundle outside the repo tree; confirms `openStoreDatabase()` finds migration assets via bundle-aware resolution.
- **Atomic runtime cutover** (§1.6 single commit): `src/execution/runtime.ts` DELETED, `src/shared/runtime-ports.ts` DELETED, `Runtime*` compat aliases removed from `src/runtime/ports.ts`. `createRealRuntime()` moved to `src/runtime/real.ts`. 76 TypeScript files updated. Verified by `scripts/verify-runtime-cutover.mjs` (AST resolver) + `scripts/__tests__/verify-runtime-cutover.fixture.mjs` self-test.
- Phase 0 debt cleared: `src/store/migrations.ts` routes file I/O through `Runtime.storage`; path factories accept `{baseDir}` option; `buildInMemoryCoralPaths` delegates to factories.

**Retirement ledger progression**:
- ✅ `src/shared/runtime-ports.ts` — DELETED (§1.6).
- ✅ `src/execution/runtime.ts` — DELETED (§1.6).
- ✅ `Runtime*` compat aliases in `src/runtime/ports.ts` — REMOVED (§1.6).
- ⏭ `src/infra/backend-info.ts` — retires in Phase 3 when backend discovery I/O moves to `src/coordinator/info.ts`.
- ⏭ `src/client/backend-lifecycle.ts` — retires in Phase 3.

**Verification**: `npm run build` (prod + dev) clean; `npm run lint` clean; `npm test` green (1698 pass / 2 skipped / 3 todo across 113 files); integration suite green (14 tests); `node scripts/verify-runtime-cutover.mjs` exits 0; `node scripts/__tests__/verify-runtime-cutover.fixture.mjs` exits 0 (self-test passes); `bash scripts/verify-native-binding.sh` exits 0 with `ok` output. All 14 acceptance criteria satisfied.
