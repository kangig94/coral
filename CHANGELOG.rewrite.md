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
