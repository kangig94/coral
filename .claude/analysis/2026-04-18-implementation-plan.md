# Unified Architecture Implementation Plan — 2026-04-18

> Historical execution record only. This file is not normative anymore.
> Source of truth: `2026-04-18-final-unified-architecture.md`.
> Keep only as cleanup-era implementation history, then delete or archive it after cleanup converges.

**Source of truth**: `2026-04-18-final-unified-architecture.md` (endpoint spec). This doc covers HOW to get there.

**Deployment model**: solo development, no user deploy until the entire refactor lands. No transition-window behavior, no feature flags, no dual-write, no compatibility shims. When the work completes, a single deploy swaps the user's installed plugin to the new shape wholesale.

**Clean-slate invariant**: user's `~/.coral/` state at first deploy is assumed destroyed. No migration path, no legacy preservation.

---

## 0. Overview

### 0.1 Structure

Eight phases (0–7) plus a cleanup/verification pass. Each phase:
- **Compiles clean** at completion (`npm run build` → 0 errors).
- **Satisfies per-phase acceptance gates** (listed per phase, not a blanket test-count heuristic).
- Phase-interior red state is allowed; phase boundary is non-negotiable.

### 0.2 Critical path

```
Phase 0 — Foundation (schema, skeleton dirs, flavor paths, error contract, invariants list)
    │
    ▼
Phase 1 — Journal substrate (SQLite, envelope, ConsumerDriver, SimulationRuntime substrate)
    │
    ▼
Phase 2 — Journal domains (jobs, sessions, discuss, workflow) + legacy type elimination
    │
    ▼
Phase 3 — Coordinator consolidation + CorpusConsumer notify wiring + integration test rewrite
    │
    ├───────────────┐
    ▼               ▼
Phase 4         Phase 5
Transport       KB / Corpus + Orama vector cosine + repair pipeline
    │               │
    └───────┬───────┘
            ▼
Phase 6 — Provider middleware (scripted-provider tests only)
            ▼
Phase 7 — Equipment + simplify + expansion consolidation (dynamic register + race/install-lock, install logic migrated to `src/expansion/` as `coral-cli expansion <verb> <name>`)
            ▼
Cleanup — hooks, skills, docs, bundle release, real-CLI E2E
```

Phase 4 & 5 are parallelizable only because Phase 3 ships the CorpusConsumer notify path. Without that dependency closed, Phase 5 cannot start.

### 0.3 Branch and commit policy (mandatory)

**Branch**: single long-lived `rewrite` branch forked from `dev` at the start (dev is the merge target per project conventions). **Never** commit rewrite work directly to `dev`; all rewrite work accumulates on `rewrite` and lands as a rebase-merge PR at Cleanup. During the rewrite, `dev` receives only emergency bugfix cherry-picks (unlikely given the freeze).

**Commit shape within a phase**: phase may be a single atomic commit OR multiple commits, but every commit message is prefixed `phase-N/<scope>:` and the final commit in the phase is `phase-N complete — <one-line summary>`, tagged `git tag phase-N-complete`.

**Tags** are the rollback boundary (§3.7).

**Local build only**: `npm run build` during phases (writes `build/*.cjs`). `bridge/*.cjs` is only consumed after marketplace install, so regenerating it locally is harmless — but there is also no reason to do so until Cleanup.

### 0.4 No-deploy discipline

Users continue running pre-refactor plugin until all 8 phases + cleanup land. No partial functionality exposed. The installed plugin at `~/.claude/plugins/cache/coral/coral/<version>/` stays on the pre-rewrite release for the entire duration; marketplace install only pulls a new version when Cleanup tags a release. If development pauses, the checkpoint tags let a future session resume at the last completed phase.

---

## 1. Phase Dependency Graph

| Phase | Depends on | Blocks |
|---|---|---|
| 0 | — | 1 |
| 1 | 0 | 2 |
| 2 | 1 | 3 |
| 3 | 2 | 4, 5 |
| 4 | 3 | 6 |
| 5 | 3 (CorpusConsumer notify wiring in Phase 3 is the actual blocker, not just "coordinator exists") | 6 |
| 6 | 4, 5 | 7 |
| 7 | 6 | cleanup |
| Cleanup | 7 | — |

---

## 2. Phase Definitions

### Phase 0 — Foundation

**Goal**: runnable skeleton for the new layout. No behavior change; old code still drives the installed plugin. New directories exist but are empty/stub. SQLite schema drafted with idempotent migrations. All cross-cutting policies are set here so later phases inherit them.

**Deliverables**:

- **Skeleton directories**: `src/store/`, `src/coordinator/`, `src/jobs/`, `src/sessions/`, `src/providers/middleware/`, `src/transport/{ipc,http}/`, `src/runtime/`, `src/infra/`, `src/simulation/`, `src/testing/`, `src/workflow/` with `index.ts` barrels.

- **Canonical SQLite schema reference** at `src/store/schema.sql` plus the first applied migration at `src/store/migrations/001_initial.sql`:
  - Tables per architecture §3.1: `events`, `projection_jobs`, `projection_sessions`, `projection_discuss`, `projection_workflows`, `projection_kb`, `meta`, `corpus_state`, `equipment_cursors`, `curate_scheduler`, `curate_retry_queue`.
  - Indexes: `events_stream`, `events_type`, `events_refs_parent`, `curate_retry_by_time`.
  - All `CREATE TABLE IF NOT EXISTS` for crash-resume idempotency.
  - **Explicit seed rows** (singleton tables):
    - `INSERT OR IGNORE INTO corpus_state (id, content_seq, metadata_seq, last_mutation) VALUES (1, 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'));`
    - `INSERT OR IGNORE INTO curate_scheduler (id, processed_through, discovery_high_seq, discovery_offset, last_run_day, consecutive_failures, community_topology_hash) VALUES (1, NULL, NULL, NULL, NULL, 0, NULL);`
    - `INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1'), ('journal_version', '1'), ('coordinator_id', lower(hex(randomblob(16)))), ('created_ts', strftime('%Y-%m-%dT%H:%M:%fZ','now'));`
  - Migration runner at `src/store/migrations.ts` is idempotent: applies only `NNN_*.sql` files whose numbered version is above `meta.schema_version`.

- **Runtime ports**: `src/runtime/ports.ts` with all 6 subports (`time`, `storage`, `paths`, `process`, `ids`, `env`). `src/runtime/real.ts` stubbed.

- **Flavor-aware paths** at `src/infra/paths.ts`:
  - Journal substrate: `~/.coral/data/store/store.db` (prod) / `~/.coral/data-dev/store/store.db` (dev).
  - **Corpus substrate (flavor-gated)**: `~/.coral/kb/` (prod) / `~/.coral/kb-dev/` (dev). Dev flavor must not share user's live KB.
  - Runtime dir: `~/.coral/run/coordinator.sock`, `coordinator.json`, `coordinator.lock` (prod) / `~/.coral/run-dev/...` (dev).
  - Equipment install base: `~/.coral/data/equipment/<name>/` (prod) / `~/.coral/data-dev/equipment/<name>/` (dev) — parent auto-created with `mkdir -p` at access time.
  - Durable job artifact: `<os-tmpdir>/coral-jobs/<id>/result.md`.
  - macOS socket-path fallback: if `$HOME`-based path exceeds 108 bytes, fall back to `$TMPDIR/coral-<flavor>-<sha>.sock`.

- **Error-shape contract** at `src/runtime/errors.ts`:
  ```ts
  export interface CoralSetupError {
    code: string;                   // stable identifier for lookup
    userMessage: string;            // one-line human-readable
    remediation: string;            // actionable steps
    context?: Record<string, unknown>;
  }
  ```
  Every prerequisite-missing error in any phase uses this shape. No invented error formats downstream.

- **Dev-flavor invocation**:
  - `npm run dev` sets `CORAL_FLAVOR=dev` via package.json script.
  - `CORAL_FLAVOR` read by `src/runtime/flavor.ts` (`resolveBuildFlavor`); `src/infra/paths.ts` exposes `setBuildFlavor` for settlement at coordinator startup.
  - `flavor-coexistence.test.ts` in `src/__tests__/integration/` exercises both flavors side-by-side.

- **Invariants test scaffolding**: architecture-boundary test + type-ownership test present, failing initially. Each phase closes more invariants; cleanup passes all.

**Acceptance criteria**:

- `npm run build` clean.
- `sqlite3 :memory: < src/store/schema.sql` and `sqlite3 :memory: < src/store/migrations/001_initial.sql` run without error.
- Re-running migrations on an already-migrated DB is a no-op (idempotency test).
- `src/runtime/errors.ts` exports `CoralSetupError` with the shape above.
- Flavor-gated paths return distinct paths for `CORAL_FLAVOR=dev` vs unset/prod.
- Architecture-boundary test file exists and runs (assertion closures deferred).
- Git tag `phase-0-complete` applied.

**Files touched**: ~35 new, 0 existing modified (all new code alongside old code).

**Test strategy**: unit tests for path resolution, schema idempotency, error-shape construction, flavor path separation.

**Risks**:
- better-sqlite3 native binding: verify it loads from bundled path (deferred to Phase 1 acceptance).
- Socket path length on macOS: mitigated by hash fallback.

---

### Phase 1 — Journal Substrate

**Goal**: SQLite event store operational with append + query + consumer primitives. SimulationRuntime can substitute for production storage. Journal authority usable but not yet consumed by domains.

**Deliverables**:

- `src/store/db.ts` — `better-sqlite3` connection factory. WAL mode, FK enforcement, prepared-statement cache.
- `src/store/append.ts` — transactional append. `appendEvents(events: CoralEventInput[]): CoralEvent[]` assigns `seq`, returns events.
- `src/store/envelope.ts` — Zod schema for event envelope + `bodyVersion` validation + upcaster registry (`registerUpcaster(type, fromVersion, toVersion, fn)`).
- `src/store/queries/events.ts` — `getEvent(stream, seq)`, `getEventsSince(afterSeq, filter?)`.
- `src/store/migrations.ts` — idempotent runner described in Phase 0.
- `src/coordinator/consumer-driver.ts` — `ConsumerDriver` with `notify(authority, version)`, single-in-flight drain, condition-var `waitFreshUntil`, cursor persistence in `equipment_cursors`.
- `src/simulation/runtime.ts` — `SimulationRuntime` implementing all 6 `Runtime` ports. **Substrate decision**: `:memory:` SQLite instance for journal, virtual filesystem for Corpus. `SimulationRuntime` is the reference deterministic implementation for all subsequent phase tests.
- `src/store/index.ts` — public barrel: `CoralStore` (query-only handle). Write-side uses the `appendEvents` primitive in `src/store/append.ts`; there is no separate `CoralWriter` class.

**Acceptance criteria**:

- Append 10k events in one transaction; `seq` monotonically increasing.
- `getEventsSince(seq)` returns correctly filtered range.
- **Projection rebuild equivalence test**: insert events → delete `projection_*` → re-derive → byte-identical result. Uses `SimulationRuntime` in `:memory:` mode.
- `ConsumerDriver` smoke test: register consumer, notify, apply runs, cursor advances.
- `waitFreshUntil` returns immediately when cursor ≥ target; blocks when behind; resolves on cursor advance.
- **Native binding verification**: `better-sqlite3` resolves from the plugin's installed path (test that loads the bundle via `bridge/coral-cli.cjs` in a fresh directory). This rules out "works in repo but breaks at install" class of bugs.
- **Simulation substrate verified**: `SimulationRuntime` executes a 1000-event sequence; output is byte-identical to production-mode run against `:memory:` DB. Known-unknown resolved.
- Git tag `phase-1-complete`.

**Files touched**: ~15 new under `src/store/` + `src/coordinator/` + `src/simulation/`.

**Test strategy**: integration tests against `:memory:`, property tests for append ordering, native-binding smoke test.

**Risks**:
- `better-sqlite3` vs `node:sqlite`: if the former fails to bundle, swap. Acceptance caps the risk.
- WAL corruption on crash — SQLite self-heals; test via simulated crash.

---

### Phase 2 — Journal Domains + Legacy Elimination

**Goal**: `jobs`, `sessions`, `discuss`, `workflow` domains run on Journal authority. All legacy record types eliminated. Causal-graph fault model replaces `CoralFault` union. Hook stability window resolved.

**Deliverables**:

- `src/jobs/` — `events.ts`, `outcome.ts` (5-variant `TerminalOutcome` + 3-variant `JobLifecycleFault` + `CauseRef` + describers), `phase.ts`, `launch.ts`, `result.ts`, `wait.ts`, `projections.ts`, `shell/{launch,abort,wait,abort-registry,agent-resolution,instruction}.ts`, `reconcile/{plan,snapshot,actions,coordinator,cross-namespace-adoption,claim-protocol,ownership-checker,job-helpers,errors}.ts`.
- `src/sessions/` — `types.ts`, `events.ts`, `continuity.ts`, `fault.ts`, `projections.ts`, `shell/{store,resolve}.ts`.
- `src/discuss/shell/` — decomposed per §10.1a of architecture: `bid-flow.ts`, `speech-flow.ts`, `followup-flow.ts`, `synthesis-flow.ts`, `session-store.ts`, `live-registry.ts`, `runtime-build.ts`, `persistence.ts`, `read-helpers.ts`.
- `src/workflow/` — `parser.ts`, `ast.ts`, `normalize.ts`, `plan.ts`, `command.ts`, `events.ts`, `projections.ts`, `executor.ts`, `launch.ts`, `wait.ts`, `recover.ts` (from pipe-executor.ts decomposition; `launch` and `retry` stay together per architecture §10.1a).
- `src/shared/coral-fault.ts` **removed** — replaced by per-domain types.
- **Test migration map** (commit to `src/__tests__/MIGRATION.md` alongside this phase's work):
  - `execution/__tests__/recovery-core.test.ts` → deleted; replaced by `src/jobs/reconcile/__tests__/plan.test.ts`.
  - `execution/__tests__/progress-store.test.ts` → deleted; replaced by `jobs/__tests__/projection-rebuild.test.ts`.
  - `execution/__tests__/lifecycle-recovery.test.ts` → deferred to Phase 3 (depends on coordinator shape).
  - `execution/__tests__/service.test.ts` → split across per-handler tests in `jobs/shell/__tests__/*`, `sessions/shell/__tests__/*`; mechanical per-function migration.
  - `shared/__tests__/coral-fault.test.ts` → deleted; `CoralFault` union removed.
  - `shared/__tests__/persistence-parsers.test.ts` → deleted; persistence moves to SQLite.
  - `execution/__tests__/simulation-*.test.ts` → kept; updated imports to `src/simulation/`.
  - Full 41-file map in the committed `MIGRATION.md`.
- **Hook stability decision**:
  - `hooks/post-compact.mjs` and `hooks/pre-compact.mjs` are **stubbed to no-op** during Phase 2–6 (emit a single log line, return). Cleanup rewrites them to read from `projection_jobs`.
  - No synthetic `status.json` shim — status.json simply stops being written; hooks safely no-op.
  - Rationale: installed plugin (old bundle) still has its own `status.json` for its own jobs; rewrite-branch stubs do not affect installed plugin.

**Acceptance criteria**:

- `grep -r "PersistedStatusRecord\|PersistedLaunchRecord\|PersistedRuntimeRecord\|PersistedExitRecord\|PersistedProgressRecord\|WorkflowCheckpoint\|ProviderResult\|ProviderProgressEvent\|TerminalResult\|SessionContinuityPatch" src/` returns **zero**. Note: `TerminalResult` added to grep (not in prior draft).
- `grep -r "coral_fault\s*{\s*fault:" src/` returns zero (old outcome variant).
- `grep -r "CoralFault" src/` returns zero (union eliminated; per-domain types now).
- Reducer-equivalence tests (per domain): inject historical event sequence → projection equals hand-computed expected. Plain `tsc` pass is not sufficient; tests verify semantic migration.
- `src/__tests__/MIGRATION.md` committed with entries for all 41 `execution/__tests__/` files.
- Stub hooks (`post-compact.mjs`, `pre-compact.mjs`) load without error and no-op cleanly.
- Causal-graph fault renderer handles a 4-link `causeRef` chain without crash or cycle.
- Git tag `phase-2-complete`.

**Files touched**: ~80 new/modified in new domain directories; ~49 files in other domains updated to purge legacy types.

**Test strategy**: reducer unit tests, projection-rebuild-equivalence CI gate, cycle-detection test for renderer, hook no-op loadability test.

**Risks**:

- `pipe-executor.ts` (37K) decomposition: launch + retry are intertwined per architecture §10.1a; preserved as one file (`launch.ts`). Test the combined module; don't force a split.
- 49-file update via TS compile errors is necessary but insufficient — reducer-equivalence tests catch silent semantic drift.
- Discuss `session-store.ts` (18K): port via golden-master — fixture session files, compare projected state old vs new.

---

### Phase 3 — Coordinator Consolidation + CorpusConsumer Wiring

**Goal**: `coordinator/` directory fully assembled, single-writer discipline enforced, live state (admission, host pool, idle, curate scheduler) runs under coordinator. **CorpusConsumer notify path wired** so that Phase 5 can invert `ensureVectorIndex` cleanly. Integration tests rewritten against the new coordinator surface.

**Deliverables**:

- `src/coordinator/coordinator.ts` — composition root (factory + world + state + lifecycle combined).
- `src/coordinator/api.ts` — public RPC surface (types used by Phase 4 transport).
- `src/coordinator/control.ts` — shutdown/drain.
- `src/coordinator/lock.ts` — singleton lock with warm-start handoff (STARTUP_DEADLINE 30s, CONTENDER_BUDGET 90s, bundleHash + flavor gating).
- `src/coordinator/discovery.ts` — `~/.coral/run/coordinator.json` read/write (renamed from `info.ts` in Phase 3 — name now matches its responsibility per architecture §10.3 intent-revealing rule; see Amendments at file end).
- `src/coordinator/log.ts`, `caller-context.ts`.
- `src/coordinator/live/`:
  - `admission.ts` (from `engine.ts`), `worker-limits.ts`, `durable-transport.ts`.
  - `provider-hosts/` — `pool.ts`, `lease.ts`, `idle.ts`, `drain.ts`, `recovery.ts` (from `host-manager.ts`).
  - `idle.ts` (from `idle-timer.ts`).
  - `curate-scheduler.ts` — replaces JSON-based scheduling with SQLite-backed tables.
- `src/coordinator/shutdown/` — `mode.ts`, `network.ts`, `sequence.ts`.
- `src/coordinator/recording/observer.ts`.
- **CorpusConsumer notify wiring** (architect's finding — explicit Phase 3 deliverable, not Phase 5):
  - `src/coordinator/corpus-notify.ts` — hook called by KB mutation path after Corpus mutation lock releases. Takes `{contentSeq, metadataSeq}`, invokes `ConsumerDriver.notify('corpus', seq)` for each registered Corpus consumer.
  - Registered consumers list initially empty; Phase 5 populates (Orama, needle).
  - Phase 3 provides the plumbing; Phase 5 plugs in concrete consumers.
- `src/jobs/reconcile/` operational against real process table.
- **Legacy `src/execution/` DELETED** at the end of this phase.
- **Integration test rewrite** (must complete within Phase 3):
  - `lifecycle-recovery.test.ts` → `src/jobs/reconcile/__tests__/lifecycle-recovery.test.ts`. Rewritten against new coordinator + reconcile shape. Covers: orphan adoption, wrapper_lost, ghost_launch detection.
  - `backend-warm-start.test.ts` → **created new** (the plan previously referenced this as existing — it didn't). `src/coordinator/__tests__/warm-start.test.ts` covers: two-coordinator handoff, bundleHash mismatch detection, flavor-gate isolation.
  - `host-manager.test.ts` → `src/coordinator/live/provider-hosts/__tests__/*.test.ts`. Replace current unit tests with **property tests** on invariants:
    - `sharedLeaseCount` never negative.
    - No lease leak on drain (acquired lease count equals released).
    - Idle evictions never touch active leases.
    - Both pre-decomp and post-decomp code must satisfy the same property suite.
- `follow.test.ts` → `src/transport/ipc/__tests__/follow.test.ts` (deferred to Phase 4 for transport rewrite; placeholder commits go here).

**Acceptance criteria**:

- Coordinator cold-starts: creates `coordinator.json`, acquires `coordinator.lock`, applies migrations, sits idle.
- **Two-coordinator handoff test**: spawn first coordinator, then spawn second with newer bundleHash; verify first detects handoff request, second takes over within CONTENDER_BUDGET.
- Flavor-gated lock: dev and prod coordinators coexist on same machine without interference (existing `flavor-coexistence.test.ts` passes).
- Curate scheduler fires at expected cadence (every 60s by default; `CORAL_CURATE_INTERVAL_MS` overrides); updates `curate_scheduler.last_run_day`.
- **CorpusConsumer notify API works end-to-end**: mock KB write → `corpus_state.content_seq` increments → `corpus-notify.ts` fires → registered mock consumer's `apply()` runs → cursor advances. Phase 5 depends on this being verified here.
- Reconciliation: inject orphaned projected-running job with no live process → reconciliation appends `job_fault{wrapper_lost}` terminal in one SQL transaction.
- `src/execution/` directory removed; `grep -r "from ['\"].*execution/" src/` returns zero.
- `host-manager.ts` property tests green (invariant-level assertions).
- All Phase-3-migrated integration tests green.
- Git tag `phase-3-complete`.

**Files touched**: ~40 coordinator files, ~30 execution/ deletions, ~15 integration-test rewrites.

**Test strategy**: two-coordinator integration test, flavor-coexistence, curate scheduler tick, CorpusConsumer notify E2E with mock consumer, invariant property tests for host-pool.

**Risks**:

- `host-manager.ts` decomposition preserving lease/drain/idle semantics: property tests pin the invariants (sharedLeaseCount ≥ 0, no lease leak), both old and new code must satisfy. If new fails, decomposition wrong.
- Warm-start handoff race: CONTENDER_BUDGET backoff is already in current code; port the semantics.

---

### Phase 4 — Transport

**Goal**: CLI routes via IPC (local mutating/live) or library-direct (read-only); HTTP gateway as thin wrapper.

**Deliverables**:

- `src/transport/ipc/server.ts`, `client.ts`, `ensure.ts` (launches coordinator if `coordinator.lock` absent).
- `src/transport/http/server.ts` (route table), `gateway.ts`, `client.ts`, `sse.ts`, `query.ts`, `contracts.ts`, `tool-response.ts`, `errors.ts`, `health.ts`.
- Per-resource route files: `jobs-routes.ts`, `discuss-routes.ts`, `kb-routes.ts`, `workflow-routes.ts`.
- `src/transport/json-rpc.ts`.
- CLI switched: read-only (`jobs list`, `kb read`, `kb search`) → `CoralStore` library-direct; mutating (`codex`, `claude`, `workflow`, `abort`, `wait`) → IPC.
- `src/client/` cleanup deferred: `readers.ts` remains as a transport-adapter bridge and retires in Phase 6 / Cleanup after the last importer moves to store queries + transport clients.

**Acceptance criteria**:

- Local read: `coral-cli jobs list` works without coordinator running (opens DB read-only).
- Mutating call: `coral-cli codex "hello"` auto-launches coordinator via `ensure.ts`, completes via IPC. **Uses scripted provider from Phase 6's test infra (prepared in Phase 1's simulation substrate)** — no real Codex binary required at this phase gate.
- HTTP path: same command via gateway matches IPC result byte-for-byte.
- IPC and HTTP share identical RPC shapes (invariant 25 from architecture).
- Launch output format preserved: `Job <id> <state> (session <sid>)`.
- `Result path: <path>` output preserved on `coral-cli wait`.
- `follow.test.ts` migrated and green.
- Git tag `phase-4-complete`.

**Files touched**: ~25 new transport files; ~7 client deletions.

**Test strategy**: IPC roundtrip (server + client in-process), HTTP gateway mirroring IPC, scripted-provider smoke covering launch/wait flow end-to-end.

**Risks**:

- Skill format preservation: snapshot-tested against literal expected lines.
- Socket path fallback on macOS (already handled in Phase 0).

---

### Phase 5 — KB / Corpus Authority

**Goal**: KB operations run under Corpus mutation lock; Orama (FTS + cosine vector) + needle backends maintained as CorpusConsumers consuming Phase 3's notify plumbing; curate state in SQLite; corpus repair pipeline built fresh. Orama vector implementation lands here as a named deliverable.

**Corpus repair taxonomy document (committed before fixtures)**: `src/kb/corpus-repair-taxonomy.md` is committed as the **first** deliverable of Phase 5 and defines the classification buckets below. Fixtures are then mapped to the taxonomy, not derived from fixture discovery.

**Deliverables**:

- `src/kb/corpus/` — `mutation-lock.ts`, `mutation-helpers.ts` (writeFileAtomic + `content_seq`/`metadata_seq` bumps + **calls `coordinator/corpus-notify.ts` after lock release**), `paths.ts`, `frontmatter.ts`, `markdown-entries.ts`, `entry-seq-guard.ts`.
- `src/kb/runtime-state.ts` — in-memory state mirroring `corpus_state` row.
- `src/kb/search/`:
  - `contract.ts` — `SearchBackend` interface.
  - `router.ts` — equipment-aware selection.
  - `chunking.ts`, `embedding.ts` — shared utilities.
  - **`orama-backend.ts`** — FTS (port current) **+ vector (new cosine implementation, named Phase 5 deliverable, not a risk)**. Cosine correctness tests against fixture embeddings + rank stability under permutation.
  - `orama-factory.ts`, `orama-schema.ts`.
  - `needle-backend.ts` — CorpusConsumer wrapping `coral-needle` N-API addon. Subscribed to `coordinator/corpus-notify.ts` via Phase 3's plumbing.
  - `hybrid.ts` — RRF fusion.
- `src/kb/ops/` — mutation ops (`memo.ts`, `promote.ts`, `update.ts`, `delete.ts`, `source-import.ts`, `source-store.ts`, `reindex.ts`, `search.ts`) using new Corpus mutation lock.
- `src/kb/curate/` — ported with `state.ts` reduced (SQLite-backed):
  - State read/write via `curate_scheduler` + `curate_retry_queue` tables.
  - All other curate files ported (`scheduler`, `runner`, `discovery`, `classification`, `community-detection`, `entity-consolidation`, `principles`, `tags`, `text-artifacts`, `metadata-commit`, `git-sync`, `claim-io`, `shared`, `types`, `operations`, `usage-budget`).
- `src/kb/vector/` DELETED (merged into `kb/search/`).
- **Corpus repair pipeline** (designed from the taxonomy doc, not ported from current code):
  - Detector covers: conflict markers (`<<<<<<<` / `=======` / `>>>>>>>`), invalid frontmatter (unclosed YAML, YAML syntax errors), missing required fields (`entrySeq`, `slug`, `title`), `entrySeq` collisions, orphan entity-graph refs.
  - Classifier returns `auto-fixable | needs-manual | unrecoverable` with structured reason.
  - Auto-fix runs under Corpus mutation lock, commits via git-sync, logs the repair.
  - `needs-manual` enters `curate_retry_queue` with a repair hint; surfaced via `coral-cli kb diagnose`.
  - `unrecoverable` is logged + the entry is skipped in projections.
- **Ensure-vector-index inversion — honest about the change**:
  - Diff algorithm ported from `src/kb/vector/sync.ts` intact (content-hash manifest + staging-swap atomicity).
  - Trigger model inverted: pull (lazy on search) → push (from `corpus-notify.ts`).
  - Concurrency envelope is new: staging dir ownership crosses the Corpus mutation lock boundary. Explicit new invariants:
    - Staging dir never survives past its owning consumer's `apply()` completion.
    - Consumer crash during staging: next drain recomputes full manifest.
    - Coordinator crash between `corpus-notify` and consumer `apply()`: startup replay from persisted cursor.
  - Budget: 1 week of index-corruption debugging is expected and allocated. Daily backup of `~/.coral/data/kb-dev/vec/` during Phase 5.

**Acceptance criteria**:

- `src/kb/corpus-repair-taxonomy.md` committed before any repair code.
- `kb promote` writes markdown under mutation lock, bumps `content_seq`, updates Orama synchronously, notifies CorpusConsumers via Phase 3's `corpus-notify.ts`.
- `kb search "query"` hits Orama FTS.
- `kb search --vector <emb>` hits Orama cosine (base) or needle (equipped). **Orama cosine test**: 100 random vectors, top-k ranking matches hand-computed cosine within floating-point tolerance.
- `kb search --hybrid` uses RRF fusion.
- External edit simulation: write a `.md` file directly, restart coordinator, startup scan bumps `content_seq`, Orama reindexes.
- Curate scheduler + retry queue: simulate failures, retry schedule is O(log n) (index on `retry_not_before` confirmed by `EXPLAIN QUERY PLAN`).
- Git-sync auto-commits after coordinator-mediated corpus mutations (DEFERRED_COMMIT_DELAY_MS debounce preserved).
- `ensureVectorIndex` pull model fully removed; `grep -r "ensureVectorIndex" src/` returns zero.
- Corpus repair: synthetic fixture per classification bucket; detector + classifier + auto-fix verified.
- Crash tests: mid-staging-swap crash → next startup full rebuild (not partial corruption).
- Git tag `phase-5-complete`.

**Files touched**: full `src/kb/` reorganization (~40 files).

**Test strategy**:

- Corpus mutation lock concurrency: two write attempts → one succeeds, other waits.
- External edit absorption: manipulate filesystem, verify reconciliation.
- CorpusConsumer push via `corpus-notify`: mutation → notify → drain → cursor advance.
- Curate scheduler + retry queue: simulate failures, verify retry schedule.
- Corpus repair fixtures per classification.
- Orama cosine fixture suite + rank stability under insertion permutation.
- Golden-master: run curate on a fixture Corpus, compare output with pre-refactor output on same fixture.
- Staging-swap crash recovery.

**Risks**:

- Orama cosine implementation is new first-deploy feature; test surface must be dense.
- Corpus repair taxonomy completeness: 5 buckets listed in architecture; real corpus may surface more. Plan for one taxonomy revision during Phase 5; document in committed taxonomy file.
- Community-detection hash correctness (`communityTopologyHash`): ensure hash inputs match current algorithm via regression fixture.

---

### Phase 6 — Provider Middleware

**Goal**: provider contract becomes `(req, runtime) => AsyncIterable<ProviderEventBody>`. Three paths collapse into one composed stack. All phase-gate tests use scripted providers; real-CLI smoke deferred to cleanup.

**Deliverables**:

- `src/providers/contract.ts` — `Provider`, `ProviderEventBody`, `ProviderMiddleware`, `compose()`.
- `src/providers/middleware/` — `session-continuity.ts`, `adapter-parse-guard.ts`, `app-server-session.ts`.
- `src/providers/fault.ts` — provider-specific fault payloads.
- `src/providers/terminal.ts` — `JobTerminal` + `JobDiagnostics` builders.
- `src/providers/claude/` — `exec-provider.ts`, `exec-kernel.ts`, `session-kernel.ts`, `control-protocol.ts`, `output-parser.ts`, `progress.ts`, `request-mapping.ts`, `shared-utils.ts`, `types.ts`.
- `src/providers/claude-appserver/` — `server.ts` + `controller.ts` + `protocol.ts` (2-way decomposition per architecture §10.1a; `SingleSessionController` stays a coherent unit).
- `src/providers/codex/` — `thread-provider.ts`, `thread-kernel.ts`, `protocol.ts`, `request-mapping.ts`.
- `src/providers/app-server/{driver,types}.ts`.
- `src/providers/{catalog,registry,bootstrap,cli-runner,cli-detection,inject}.ts`.
- `src/testing/scripted-provider.ts` — test-only scripted provider factory (already sketched in Phase 1 simulation infra; finalized here).

**Acceptance criteria**:

- Scripted provider test suite: each middleware verified in isolation.
- All three current paths (`adapter.ts`, `session-driver.ts`, `runner.ts`) removed; `grep` returns zero.
- Fault producer invariant (§16 architecture):
  - `adapter_output_unparseable` → `middleware/adapter-parse-guard.ts` only.
  - `provider_session_unavailable` → `middleware/session-continuity.ts` only.
  - `provider_request_failed` → leaf kernel only.
- `runner.ts:66-83` outcome-overwrite pattern doesn't exist in new code.
- Abort mid-turn: signal propagates through middleware, terminal fires with `aborted` outcome.
- **Scripted provider smoke test** covers full round-trip (no real CLI required at phase gate). Real-CLI E2E moved to cleanup.
- Git tag `phase-6-complete`.

**Files touched**: `src/providers/` full rework (~30 files).

**Test strategy**: scripted-provider unit tests per middleware, compose-stack integration tests, abort-signal propagation.

**Risks**:

- `claude-appserver/session.ts` (35K) 2-way decomposition: `controller.ts` is large (likely 20K+). That is fine — coherent state ownership > arbitrary split (per architect finding).
- Interrupt path preservation: `app_server_interrupted` trigger + continuity semantics pinned via scripted test.

---

### Phase 7 — Equipment + simplify + expansion consolidation (dynamic register + race/install-lock, install logic migrated to `src/expansion/` as `coral-cli expansion <verb> <name>`)

**Goal**: `/equip needle` activates live without coordinator restart. Equipment model operational. Race/install-lock infrastructure verified.

**Expansion / Equipment / Skill taxonomy**: Skill (`/equip`) is the user-facing slash-command verb. Expansion (`src/expansion/`) is the installable noun (`needle`, `cgc`, ...). Equipment (`src/coordinator/equipment/`) is the coordinator slot where an expansion becomes active. The layers stay distinct: the skill routes user intent to expansion workflows, and equipped state exists only through coordinator equipment slots.

**Deliverables**:

- Coordinator RPC: `registerEquipment`, `unregisterEquipment`, `listEquipment`.
- Equipment lifecycle:
  1. `/equip needle` → `coral-cli expansion equip needle` (one unified workflow: install + activate) acquires filesystem lock at `~/.coral/data/equipment/needle/install.lock` via `src/shared/fs-lock.ts` (parent auto-created via `mkdir -p`).
  2. Downloads binary (idempotent; resume via partial-file cleanup on error).
  3. Coordinator RPC `registerEquipment` dynamically imports `coral-needle`.
  4. Creates `CorpusConsumer` wrapping the addon; registers in `coordinator/corpus-notify.ts` consumer list.
  5. Initial catchup: consumer cursor starts at 0, first `apply()` replays full Corpus history.
  6. Binary load failure path: caught, marks consumer `disabled_pending_reinstall` in equipment metadata; CLI errors with reinstall guidance (`CoralSetupError` shape per §3.9).
- `/equip uninstall needle`:
  - `coordinator.unregisterEquipment` waits for in-flight drain (`ConsumerDriver.stop()`).
  - Removes consumer from notify list.
  - Deletes cursor row + equipment storage.
- Identity unification (A2): skill catalog id, runtime consumer id, install dir, and CLI target all use `needle` (`/equip needle`, `coral-cli expansion unequip needle`, `~/.coral/data/equipment/needle/`, consumer id `needle`). Skill grammar remains `/equip uninstall needle`; `skills/equip/SKILL.md` routes that input to `expansion unequip` internally.
- Slot registry (A3): migration 002 persists `equipment_state`; `kb.vector` defaults to Orama and can be reassigned to `needle`. `KbRuntime` becomes single authority for vector surface (`getActiveVectorSurface()` + `getBaseVectorSurface()`) and corpus snapshot (`getCorpusStateSnapshot()`); `src/kb/search/router.ts` and `src/coordinator/coordinator.ts:178-180` stop open-coding fallback projections or calling `readCorpusState(runtime.db)` directly. KB routing reads ownership through `KbRuntime.getEquipmentView()` without coordinator imports; no boot-time needle auto-registration remains.
- Consumer handle shape (A4): `ConsumerDriver.register()` returns `ConsumerHandle { id, stop(), unregister(), status(), lastApplyError }`, with `onApplyFailure` plumbing async apply failures and `registrationKind` distinguishing equipment vs base consumers.
- Corpus equipment freshness observation (A7): `waitFreshUntil` remains journal-only; CLI and tests observe `catching_up` → `equipped` through `listEquipment` polling rather than a new corpus waiter primitive.
- Exclusive per-path enforcement: second equip for same query path fails with structured error.
- `/equip --list` reads catalog + current equipment state from coordinator.
- `skills/equip/` updates: `skills/equip/` keeps SKILL.md only; `install.mjs`, `coordinator-client.mjs`, `equipment-paths.mjs`, `fs-lock.mjs`, and `scripts/equip-driver.mjs` are deleted. Catalog ownership moves to `src/expansion/catalog.ts` with a `Strategy<Config>` interface (`equipment-addon` for needle, `github-binary` for cgc).

**Acceptance criteria**:

- `/equip needle` fresh install: binary downloads, installs to `~/.coral/data/equipment/needle/` (parent auto-created), RPC registers consumer, initial catchup runs, vector search available without coordinator restart.
- `/equip uninstall needle`: consumer stops, storage cleared, FTS-only mode restored. Re-equip replays from cursor=0.
- Second `/equip needle` while already equipped: reports "already equipped".
- Restart-cleared equipment reports `inactive`; binary-missing durable equipment reports `unavailable`; callers observe catchup completion by polling `listEquipment`.
- Second `/equip <other-vector-tool>` (hypothetical): errors with "`/equip uninstall needle` first".
- Corrupt binary: load catches, marks consumer `disabled_pending_reinstall`, CLI returns `CoralSetupError` with reinstall guidance.
- `grep -R "kb-needle" src/ skills/` returns zero.
- `grep -R "data/equipment/kb" src/ skills/` returns zero.
- **Race test** (multi-process): infrastructure at `src/testing/multi-process-driver.ts` exposes `spawnNodeScript<T>`, which the race integration uses to spawn two subprocesses against the invocation-adapter bundle at `<os.tmpdir()>/coral-race-<pid>/install-invocation.cjs` (built once per suite from `src/testing/invocation/install-invocation.ts` via inline `esbuild.build(...)`). Subprocesses call `src/expansion/install.ts#installExpansion` directly and race on the filesystem install-lock. The old `scripts/equip-driver.mjs` harness is deleted. `vitest.integration.config.ts` `singleFork` remains sufficient because OS-level lock contention happens between the spawned child processes, not between vitest workers.
- Git tag `phase-7-complete`.

**Files touched**: ~10 new coordinator + equip files; ~3 skill updates.

**Test strategy**:

- Live register/unregister cycle.
- Race test via multi-process driver.
- Corrupt-binary simulation.
- Install lock contention.

**Risks**:

- Dynamic import behavior on supported Node versions (≥20) — smoke tested on all.
- Native addon load failure → structured error, never crash.

---

### Cleanup — Finalization

**Goal**: hooks functional, skills updated, docs rewritten, full real-CLI E2E passes, bundle regenerated, legacy-free verified.

**Deliverables**:

- `hooks/post-compact.mjs`, `hooks/pre-compact.mjs` rewritten:
  - Read job summaries via `CoralStore.jobs.getTerminalByJobId(id)` (SQLite read-only).
  - Read result content from `<os-tmpdir>/coral-jobs/<id>/result.md`.
- `hooks/cli-resolve.mjs` unchanged (regex valid).
- Skill files updated for any changed CLI output shapes. Where ergonomic, skills shift from literal-text parsing to `coral-cli <cmd> --help` dynamic discovery.
- `docs/architecture.md` rewrite: Journal + Corpus authorities, coordinator + substrate, equipment model.
- `docs/core-modules.md` rewrite: new src/ layout, per-module responsibilities.
- `docs/configuration.md` update: flavor paths, embedding provider env, equipment catalog.
- `docs/hooks.md` update: new paths for hook state inspection.
- `README.md` updates:
  - Vector search one-line setup (Gemini API key in `~/.coral/.env`).
  - Equipment system (`/equip needle`).
  - Two-authority mental model.
- **`npm run build:release` run for the first and only time during the refactor**:
  - Regenerates `bridge/coral-backend.cjs`, `bridge/coral-cli.cjs`, `bridge/coral-claude-appserver.cjs`, `bridge/manifest.json`.
  - This is the "single deploy" moment.
- **Full E2E real-CLI smoke** (run manually by developer before merge):
  - Fresh `~/.coral/` wipe.
  - `npm install` fresh.
  - `coral-cli codex "say hi"` completes with real Codex binary.
  - `coral-cli kb promote --memo test --title "test"` round-trips.
  - `coral-cli kb search "test"` returns the promoted entry.
  - `/equip needle` installs needle, vector search upgrades.
  - `/equip uninstall needle` reverts cleanly.

**Acceptance criteria**:

- `grep -r "execution/" src/` returns zero.
- `grep -r "shared/" src/` returns zero.
- `grep -r "client/" src/` returns zero.
- `grep -r "PersistedStatusRecord\|WorkflowCheckpoint\|ProviderResult\|TerminalResult\|CoralFault\s" src/` returns zero.
- `grep -r "coral_fault\s*{\s*fault:" src/` returns zero.
- `grep -r "curate-state.json\|ensureVectorIndex" src/` returns zero.
- `npm run build:release` produces bridge bundles without errors.
- `npm test` all green.
- Architecture-boundary test passes all invariants from architecture §16.
- Type-ownership DAG test passes.
- Full E2E real-CLI smoke passes.
- Hooks fire correctly on compact events.
- Every skill runs as expected against the new CLI.
- Git tag `cleanup-complete` (equivalent to ready-to-merge-to-main).

**Risks**:

- Hooks require manual verification via Claude Code runtime.
- Skill text parsing: CI lint greps for skills' expected literal fragments and verifies CLI emits them (tests added in Phase 4 still apply).

---

## 3. Cross-Cutting Concerns

### 3.1 Runtime paths (canonical)

| Concept | Prod path | Dev path (CORAL_FLAVOR=dev) |
|---|---|---|
| Journal substrate | `~/.coral/data/store/store.db` | `~/.coral/data-dev/store/store.db` |
| Corpus authority | `~/.coral/kb/` | `~/.coral/kb-dev/` |
| Corpus indexes | `~/.coral/data/kb/` | `~/.coral/data-dev/kb/` |
| IPC socket | `~/.coral/run/coordinator.sock` | `~/.coral/run-dev/coordinator.sock` |
| Coordinator info | `~/.coral/run/coordinator.json` | `~/.coral/run-dev/coordinator.json` |
| Coordinator lock | `~/.coral/run/coordinator.lock` | `~/.coral/run-dev/coordinator.lock` |
| Equipment install | `~/.coral/data/equipment/<name>/` | `~/.coral/data-dev/equipment/<name>/` |
| Durable job artifact | `<os-tmpdir>/coral-jobs/<id>/result.md` | `<os-tmpdir>/coral-jobs/<id>/result.md` |

All paths resolved via `src/infra/paths.ts` after `src/runtime/flavor.ts` (`resolveBuildFlavor`) settles the flavor and coordinator startup calls `setBuildFlavor`. Dev paths enable safe testing without corrupting user's live KB workflow.

`CORAL_FLAVOR=dev` is set by `npm run dev` (added in Phase 0).

Socket-path fallback on macOS: `$TMPDIR/coral-<flavor>-<hash>.sock` when primary path exceeds 108 bytes.

### 3.2 Phase-boundary discipline (invariant-coverage, not raw test counts)

Each phase gate verifies:

1. `npm run build` — zero tsc errors.
2. `npm test` — zero failures, zero `.only`.
3. `grep -rn "@ts-expect-error\|TODO rewrite\|FIXME" src/` — zero matches.
4. Architecture-boundary test runs; all invariants **in scope for that phase** hold.
5. **Invariant coverage not lost**: architecture `§16` enumerates 46 invariants. Each invariant has a test that demonstrates it. Phase boundary requires: for every invariant marked `in-scope-as-of-phase-N`, the test exists and passes. Deletion of a test is allowed only if its invariant is also removed (which should never happen for architecture invariants).
6. Phase-specific acceptance criteria (per phase §2).

Raw test-count deltas are not a guardrail — rewriting a phase may legitimately delete many tests while adding equivalent-coverage new tests. Coverage is measured against the invariant list.

### 3.3 Edge cases

| Scenario | Resolution |
|---|---|
| SQLite WAL checkpoint fails mid-write | SQLite retries internally; disk-full triggers operational log + coordinator health flips unhealthy. Commit blocked until resolved. |
| Corpus mutation lock held by dead process | Lock file includes pid + mtime; acquisition checks `kill -0` liveness + mtime staleness (>5 min); stale lock reclaimed with warn log. |
| Corrupt needle binary after `/equip` | `dlopen`/`require` wrapped in try/catch; failure writes `disabled_pending_reinstall` to equipment metadata; CLI returns `CoralSetupError` with reinstall hint. |
| git-sync detects conflict | Conflict markers detected in frontmatter parser; entry routed to corpus repair pipeline (§Phase 5); skipped with diagnostic. |
| Orphan `.tmp` files at startup | Phase 3 startup sweep removes `*.tmp` older than start time under `~/.coral/kb/`. |
| `/equip uninstall` during in-flight drain | `unregisterEquipment` awaits `ConsumerDriver.stop()`; removes consumer + cursor atomically. |
| Partial-phase crash mid-migration | Migrations are `IF NOT EXISTS` idempotent; re-running is a no-op. Manual `git reset --hard phase-N-complete` for code; DB migrations self-heal. |

### 3.4 Concurrency

| Scenario | Resolution |
|---|---|
| Two `/equip needle` races | `src/expansion/install.ts#installExpansion` acquires `~/.coral/data/equipment/needle/install.lock`; the losing caller receives a structured `equipment_install_lock_contended` error. |
| Obsidian edits mid-promote | Coordinator's write path computes pre-write `content_hash`; if differs from projection's last-seen, abort with `CorpusRaceDetected` (`CoralSetupError` shape); caller retries. |
| Journal write concurrent with Corpus rescan | Independent authorities; `projection_kb` updates inside Corpus mutation lock; Journal writes never touch it. |
| Two CLI processes race for coordinator launch | Warm-start handoff (§Phase 3); `ensure.ts` detects in-flight launch and waits. |

### 3.5 Missing invariants (added to architecture §16 alongside this plan)

- `contentHash = sha256(markdown_body_after_frontmatter)`. Metadata-only edits don't invalidate contentHash.
- Upcaster composition produces output that re-validates against current Zod schema.
- Read-side event bodies route through upcast-aware decode helpers; raw `schema.parse(decodeEventBody(...))` and one-arg `rowToCoralEvent(row)` are forbidden outside `store/body-codec`, `store/append`, and `store/rebuild`.
- `coordinator/api.ts` stays a thin public seam: at most 10 exported symbols, and no re-export of domain shell implementation modules.
- Singleton rows seeded in `001_initial.sql` (corpus_state.id=1, curate_scheduler.id=1).
- `meta.coordinator_id` stable per install, regenerated only on explicit `/reset`.
- `projection_kb.content` capped at 1 MB; oversize stored with `content IS NULL` + size metadata.

### 3.6 Branch and commit discipline

See §0.3 for branch policy and commit shape. Key points:

- **Never commit rewrite work to `dev`**.
- Phase = one commit or N commits prefixed `phase-N/<scope>:`.
- Final commit of each phase is `phase-N complete — <summary>`, tagged `phase-N-complete`.
- `cleanup-complete` is the merge-ready tip.

### 3.7 Rollback matrix

| Rollback to | Safe via `git reset --hard`? | Additional steps |
|---|---|---|
| `phase-0-complete` | Yes | Wipe `~/.coral/data/store*` and `~/.coral/data-dev/*` (fresh schema). |
| `phase-1-complete` | Yes | Same as above. |
| `phase-2-complete` | Yes | Re-run migrations (idempotent). Legacy types in main are unchanged because rewrite branch is isolated. |
| `phase-3-complete` | Yes | Kill any stale coordinator process; delete `~/.coral/run*/coordinator.lock`. |
| `phase-4-complete` | Yes | IPC socket may linger; `rm -f ~/.coral/run*/coordinator.sock`. |
| `phase-5-complete` | Requires care | Corpus state in DB may be ahead of filesystem; wipe `~/.coral/data-dev/kb/` and rerun `kb reindex`. |
| `phase-6-complete` | Yes | No runtime state affected. |
| `phase-7-complete` | Yes | Uninstall any dev-equipped needle: `rm -rf ~/.coral/data-dev/equipment/`. |
| `cleanup-complete` | N/A | This is the merge point. |

**No rollback changes the installed plugin** — `bridge/*.cjs` is not regenerated until Cleanup.

### 3.8 Test migration map

Committed to `src/__tests__/MIGRATION.md` at Phase 2 start. Per the architect finding, 41 files in `src/execution/__tests__/` need explicit fates. Summary (full table in MIGRATION.md):

| Category | Current count | Phase 2 fate | Phase 3 fate |
|---|---|---|---|
| Recovery/lifecycle | ~8 files | Partially deleted (recovery-core redone as `jobs/reconcile/__tests__/`) | Rewritten against coordinator shape |
| Progress/session store | ~6 files | Deleted; replaced by projection-rebuild tests | — |
| Service handlers | ~15 files | Split across per-domain `shell/__tests__/` | — |
| Simulation | ~4 files | Kept; imports updated to `src/simulation/` | — |
| Host manager | ~3 files | — | Rewritten as invariant property tests |
| Discuss | ~5 files | Moved to `src/discuss/shell/__tests__/` | — |

`flavor-coexistence.test.ts` under `src/__tests__/integration/`: updated to cover new dev/prod path separation (Phase 0 deliverable).

`backend-warm-start.test.ts` under `src/coordinator/__tests__/`: **newly created** in Phase 3 (current codebase has `hooks/backend-warm-start.mjs` — a hook, not a test; prior plan draft incorrectly referenced it).

### 3.9 Error shape contract

All prerequisite-missing, configuration-missing, or setup-failure errors use `CoralSetupError` (Phase 0, `src/runtime/errors.ts`):

```ts
interface CoralSetupError {
  code: string;              // e.g. "embedding_provider_missing", "coordinator_lock_stale"
  userMessage: string;       // one-line human message
  remediation: string;       // actionable steps (markdown OK)
  context?: Record<string, unknown>;
}
```

Each phase introduces specific codes; Phase 0 seeds the generic shape. Every thrown error of this class renders consistently in CLI (`coral-cli` shows userMessage + remediation; `--verbose` adds context).

### 3.10 Guardrails (runtime limits and protocols)

- **`waitFreshUntil` timeout**: mandatory `timeoutMs` parameter, default 30000 ms, throws `FreshnessTimeout` on expiry.
- **Microtask queue backpressure**: `ConsumerDriver` coalesces pending notifications to "latest version only"; idempotent `apply()` tolerates.
- **Circular causeRef detection**: `describeCauseRef` walks with a `Set<string>` of visited `(stream.kind, stream.id, seq)`; cycle returns `CircularCauseRefDiagnostic` metadata to a caller-owned persistence path.
- **Events-table growth**: unbounded; future operational work may add archival. Document in `docs/operations.md` during Cleanup.

---

## 4. Known Unknowns

Decisions deferred to the implementation phase that owns them:

- **Curate scheduler cadence under SQLite**: default 60s between retry-queue polls (tunable via `CORAL_CURATE_INTERVAL_MS`). Revisit if retry queue depth grows unexpectedly. Decided during Phase 3.
- **Hook read API performance**: hooks open `store.db` read-only concurrently with coordinator. SQLite WAL handles this. Revisit if contention observed. Decided during Cleanup.
- **`coral-reef` dashboard transport**: HTTP gateway with SSE assumed sufficient. If reef grows new needs, extend Phase 4 deliverables. Revisit post-cleanup.
- **`coral-cli discuss --user` interactive semantics**: long-running IPC session. Protocol shape determined during Phase 4; scripted-tested at Phase 4 gate.

Items previously in "known unknowns" that are now hard-specified above:
- ~~Simulation substrate over new store~~ → Phase 1 acceptance (`:memory:` SQLite + virtual filesystem).
- ~~Hook read API exists?~~ → Cleanup deliverable (hooks rewritten to read `projection_jobs`).
- ~~Coordinator upgrade while subscribers attached~~ → Phase 3 warm-start test covers.

---

## 5. References

- Endpoint spec: `2026-04-18-final-unified-architecture.md` (~1880 lines).
- Agent review findings synthesized into this plan: architect, critic, gap-finder (Phase 0 of review: architect + critic + scanner + gap-finder on architecture; Phase 1 of review: architect + critic + gap-finder on this plan).
- Source of truth for current code: `/home/kang/workspace/coral/src/`.

---

**Status**: Plan is implementation-ready after addressing 25 agent findings. Branch policy mandates `rewrite` branch; bundle regeneration is locked to Cleanup phase; Phase 3 explicitly owns CorpusConsumer notify plumbing; Phase 5 honestly frames the `ensureVectorIndex` inversion; hooks are stubbed through Phase 2–6; test migration mapped; error shape contractualized. Remaining risks are scoped to individual phase budgets.

---

## Amendments

Tracked deviations from the original plan adopted during implementation. Each entry names the change, the phase that adopted it, and the binding rationale. The companion architecture document (`2026-04-18-final-unified-architecture.md`) carries matching entries.

- **`coordinator/info.ts` → `coordinator/discovery.ts`** (Phase 3, tag `phase-3-complete`). Renamed so the filename matches the module's responsibility (discovery record I/O) per architecture §10.3 intent-revealing rule + invariant #31 (no generic filenames at domain roots). Same reasoning that drove the Phase 2 `src/sessions/entry.ts` decision over this plan's `types.ts`.
- **`coordinator/bootstrap.ts` introduced as a sibling of `coordinator.ts`** (Phase 3). Owns argv parsing, `--smoke-open-store` short-circuit, and main-process exit-code orchestration. `coordinator.ts` stays a pure composition root invokable from tests without argv plumbing. `bootstrap.ts` is the bundle entrypoint targeted by `scripts/build-server.mjs` and `scripts/verify-native-binding.sh` (the Phase 3 plan §AC1 and AC10 references reflect this split).
- **Phase 2 sessions filename**: `src/sessions/entry.ts` over this plan's `src/sessions/types.ts` (Phase 2, tag `phase-2-complete`). Same intent-revealing rule. The architecture §10.2 ban on generic filenames at domain roots takes precedence over the implementation-plan's `types.ts` placeholder for this slot.
- **Dev data path layout** (Phase 0 implementation correction). Flavor-gated data families use a `data-dev/<family>/` prefix, not `data/<family>-dev/`. This applies to the store, corpus indexes, and equipment paths per `src/store/paths.ts`, `src/infra/corpus-paths.ts`, and `src/infra/equipment-paths.ts`.
- **`result.md` stays in the job directory contract** (Phase 3 follow-up review fixes). The durable wait/follow artifact remains `<os-tmpdir>/coral-jobs/<jobId>/result.md` per `src/jobs/shell/result-artifact.ts`. The `~/.coral/exports/jobs/<jobId>/` path remains present for future tooling, but it is not the authoritative durable artifact path today.
- **Phase 0 schema deliverable split** (Phase 0 implementation correction). The canonical reference lives at `src/store/schema.sql`; the first applied migration lives at `src/store/migrations/001_initial.sql`. Acceptance criteria require `sqlite3 :memory: < src/store/schema.sql` and `sqlite3 :memory: < src/store/migrations/001_initial.sql` to both exit 0.
- **Amendment #6**: `sessions/types.ts` → `sessions/entry.ts` (Phase 2). Same intent-revealing rule as `coordinator/discovery.ts` — generic `types.ts` at a domain root is banned by invariant #31.
- **Amendment #7**: `discuss/schemas.ts` → `discuss/command-schemas.ts` (Phase 2). Same rule as Amendment #6: generic `schemas.ts` at a domain root is banned by invariant #31.
- **Phase 4 (tag `phase-4-complete`) — HTTP route decomposition stays table-driven in `src/transport/http/handler.ts`.** The per-resource file split proposed in the plan (`jobs-routes.ts`, `discuss-routes.ts`, etc.) is not adopted; §11.3 already names the single table-driven form.
- **Phase 4 (tag `phase-4-complete`) — new invariant: single coordinator RPC catalog is the sole source of truth.** `src/transport/rpc-catalog.ts` holds pure metadata; HTTP handler table and IPC server dispatch both project from it via `rpcPorts` injected by coordinator composition. Invariant #25 (IPC/HTTP shape parity) is satisfied by construction. Operational `/health`, `/admin/shutdown`, `/events/stream` endpoints are an explicit transport-local carveout, not catalog entries.
- **Phase 4 (tag `phase-4-complete`) — new §11 clause: interactive/live subscriptions use one generic subscription primitive.** `src/transport/json-rpc.ts` defines unary + subscription envelopes with a reserved `subscriptionId` slot; HTTP projects subscriptions to SSE, IPC carries notifications directly. At Phase 4 gate, subscriptions are one-per-connection; multiplexing is a transparent future optimization.
- **Phase 4 (tag `phase-4-complete`) — CLI read commands migrate from `BackendClient` (HTTP) to `CoralStore` read facade in Phase 4.** `src/client/readers.ts` file retirement remains Phase 6/Cleanup (non-CLI importers), but CLI importers migrate now so invariant #23 actually closes at the Phase 4 gate.
- **Phase 4 (tag `phase-4-complete`) — `src/transport/ipc/ensure.ts` uses discover-or-launch via `coordinator.json` + socket readiness, not lock-file polling.** The singleton lock remains the launch gate but is not the detection mechanism. Current `ensureBackend` semantics (observation lattice, compatibility on `bundleHash + flavor + namespace`, verified sick ownership, unsafe-replacement refusal, corrupt-lock quarantine) preserved literally.
- **A1 — `/equip uninstall` replaces `/unequip` slash command** (Phase 7, tag `phase-7`). Rationale: `/equip` is already the catalog + lifecycle entry; a separate slash command duplicates surface area for no UX gain. Coordinator RPC name `unregisterEquipment` is preserved; only the CLI surface collapses.
- **A2 — Needle identity unification** (Phase 7, tag `phase-7`). Rationale: Skill catalog id (`kb`), runtime consumer id (`kb-needle`), on-disk directory naming, and user messaging all collapse to the single name `needle`. `/equip needle`, `/equip uninstall needle`, `~/.coral/data/equipment/needle/`, consumer id `needle`.
- **A3 — Explicit equipment slot registry + durable state** (Phase 7, tag `phase-7`). Rationale: Prior implicit-boot registration replaced by durable `equipment_state` persisted via migration 002; `kb.vector` slot has default Orama owner and optional equipped owner. Router reads slot ownership via `KbRuntime.getEquipmentView()` port without coordinator import. Boot-time needle auto-registration removed from `coordinator.ts:190`. Needle enters the process only via `/equip needle` activation.
- **A4 — `ConsumerDriver.register()` returns per-consumer `ConsumerHandle`** (Phase 7, tag `phase-7`). Rationale: Signature changes from `void` to `ConsumerHandle { id, stop(), unregister(), status(), lastApplyError }`. `onApplyFailure` callback plumbs async apply errors. `registrationKind` metadata distinguishes equipment vs base consumers for cursor-deletion semantics. Existing base-tier consumers migrate to the same handle shape via `projection-consumer.ts` helper.
- **A5 — Legacy types retire to upcaster boundary only** (Phase 7, tag `phase-7`). Rationale: `src/shared/legacy-terminal-outcome-compat.ts` deleted; read-time body transforms moved to per-domain upcaster registrars (`jobs/upcasters.ts`, `sessions/upcasters.ts`, `workflow/upcasters.ts`). `src/store/upcasters.ts` remains assembler only. Runtime multi-event canonicalization stays in `legacy-ingest` (consumes upcaster output). Active runtime code uses canonical `SessionContinuityState` / `SessionProviderFailureReason` / `SessionFault` directly.
- **A6 — Codex pre-turn notification mailbox** (Phase 7, tag `phase-7`). Rationale: `src/providers/codex/thread-kernel.ts` `applyNotification` replaces unconditional buffering with an admission-filtering mailbox. Notifications are admitted only if they can still belong to the active thread's lifecycle (matching `state.threadId` candidate, or lifecycle messages without thread id). `PRE_TURN_MAILBOX_CAP=64` FIFO eviction with `dropped` counter. `status()` exposed for observability. Provisional candidates seeded from persisted continuity / resume `conversationRef` (robustness against `thread/resume` id mismatch).
- **A7 — Corpus equipment freshness observed via polling** (Phase 7, tag `phase-7`). Invariant 41 split: journal consumers keep `waitFreshUntil` condition-variable wake; corpus equipment consumers are observed via `listEquipment` polling. Rationale: adding a corpus-side waiter primitive was out of scope; `catching_up` → `equipped` transition surfaces through the existing status-read RPC.
