# Wait read/write split — verification through Phase D

Implemented scope: AC6, AC2 and AC3, on top of batch 1 (`a65f29fd`). Revision S1 governs publication: no export lock, operation child or publisher watchdog. Phase C preserved the legacy wait wire format. Phase D below removes its read-side ensure dependency.

## Implementation and positive evidence

| AC | Owners and behavior | Tests |
| --- | --- | --- |
| AC6 | `jobs/terminal/identity.ts:validatedTerminal` rejects inconsistent retained copies; `location-index.ts:recordTerminal` records epoch/sequence-bound owner age independently of export. Compaction and concurrent recording preserve validated saved classification. `historical-reader.ts:historicalDetail` uses journal outcome/diagnostics and active workflow usage policy. `location-index.ts:resultDurable` requires readable retained detail, then accepts trusted known expiry or the existing synchronized nonempty-file proof. All index constructions use the shared clock authority through the index itself. | `tests/unit/jobs/location-index-additive.test.ts`; export owner tests for corrupted copies, legacy optional copies, missing evidence, unknown age, regression and source loss; `tests/integration/jobs/historical-reader.test.ts`; publication/retention integration tests for historical seed failure, stale projection, usage, compaction, source removal/restart and actual v0.10.16/v0.10.17 decoder acceptance. |
| AC2 | `jobs/terminal/export.ts:TerminalResultExportOwner` accepts only job identity and renders accepted source content. Workflow composition injects `workflow/result-report.ts:renderWorkflowReport`, paired with the moved pure `serializeWorkflowResult`. Available files are preserved; empty terminals get outcome explanations. All former writers use the owner. The unused recovered completion method, forwarder, contract and mocks are deleted. | `tests/invariants/result-artifact-owner.test.ts` enforces owner access and jobs/workflow dependency direction; owner tests cover real journaled step output through deletion/repair, empty provider/workflow outcomes, missing workflow facts and available-file preservation; historical integration tests cover seed reports and interrupted recovery regression suites cover the production finalizer. |
| AC3 | `jobs/export-retention.ts:terminalEligibility` resolves each location's own epoch, preserves saved regression and uses `jobs/retention-clock.ts:trustedJobRetentionCutoff` with strict expiry. Availability is read-only and explicit. Repair retries/hints are in memory, with failure status shared by historical and coordinator owner entries; `storage-retention-scheduler.ts` gives repair its own budgeted owner. The atomic writer checks publication authorization immediately before rename. Retention rechecks eligibility, holds and tree identity. Recorded jobs use terminal age; unowned residue retains its separate filesystem-age policy. | Export owner tests cover cutoff below/equal/above, untrusted cutoff, transient failure/hinted repair, source-backed regression publication and file proof, legacy unknown refusal and retained-only absence. `tests/unit/jobs/export-retention.test.ts`; scheduler suite; `tests/integration/jobs/publication-retention.integration.test.ts` pauses actual coordinator and KB composition publishers across process boundaries before staging and after durable staging. |

The integration fixture inserts pauses only into its bundled runtime, without production pause hooks. It checks the stage is discarded after crossing the cutoff and that pruned active exports stay absent through repair, historical seed, source retirement and restart. Revision S1 accepts the narrower race where publication wins the last recheck and retention removes canonical bytes on its next cycle; age discharge prevents retirement blockage.

## Falsifying controls

All 17 mutations below was applied separately, its focused test executed under `env -i` with a temporary HOME, then the original source restored. Every control exited 1 with the intended assertion failure, rather than a fixture or transformation failure. Logs and machine-readable results are under `/tmp/waitfix-controls/` in this session.

| AC | Mutation | Failed assertion |
| --- | --- | --- |
| AC2 | Add a foreign production writer | Owner invariant reports the foreign source. |
| AC2 | Render workflow final terminal text alone | Report lacks intermediate step output. |
| AC2 | Rewrite an already available file during repair | Existing rendering is replaced. |
| AC3 | Authorize expired publication and remove retained-away refusal | Below-cutoff artifact is recreated. |
| AC3 | Change strict `< cutoff` to `<= cutoff` | Equality is wrongly expired. |
| AC3 | Remove the durable writer's final authorization check | Independently paused staged process publishes after expiry. |
| AC3/AC6 | Restore blanket regression publication veto | Separate canonical-byte and file-based retirement-proof assertions fail, alongside the failed-first-attempt retry test. |
| AC6 | Infer legacy age from retained timestamp | Missing age evidence wrongly discharges retirement. |
| AC6 | Accept terminal presence without semantic agreement | Corrupted copies remain readable; mismatched recording is accepted. |
| AC6 | Restore projection phase authority | Stale projection makes canonical historical detail unreadable. |
| AC6 | Let one export failure abort seed hydration | Seed becomes unrecoverable instead of hydrating other history. |
| AC6 | Omit historical workflow usage aggregation | Child token usage is missing. |
| AC6 | Remove age discharge and require a file | Validated expired source-retired outcome cannot release retirement. |
| AC6 | Discharge age before checking retained detail | Corrupted or missing outcome passes proof. |
| AC6 | Recompute saved age after prefix pruning | Saved regression becomes known from a timestamp-only query. |
| AC6 | Overwrite age captured before acquiring the revision lock | A concurrent owner's saved regression becomes unknown. |
| AC3 | Give historical hydration an isolated failure set | The coordinator reports repair-pending after a failed repair instead of failed with scheduled retry. |

## Gate

The final complete gate ran sequentially in the same isolated environment used for the initial gate. All final exits were 0. The second knip run moved `dist/` aside and restored it in `finally`. Final logs and the gate results are in `/tmp/waitfix-gate-complete/`. Earlier lint, fixture and batch 1 failures were investigated, corrected and rerun.

| Gate | Result | Duration |
| --- | --- | --- |
| typecheck:tests | Pass | 9.1 s |
| lint | Pass | 36.9 s |
| format:check | Pass | 10.1 s |
| knip (dist present) | Pass | 1.0 s |
| knip (dist moved aside and restored) | Pass | 1.1 s |
| build | Pass | 26.3 s |
| npm test — 2,302 tests, 453 files | Pass | 23.0 s |
| test:integration — 354 tests, 81 files | Pass | 116.8 s |
| test:store-reset:integration | Pass | 1.9 s |
| verify:store-reset-build | Pass | 2.8 s |
| test:e2e:lifecycle | Pass | 2.2 s |

## Regression fixture conflicts

The old export-retirement fixture recreated an expired artifact through `ensureResultArtifact` during deletion. That conflicts with AC3/D2. It now explicitly models an external filesystem recreation while keeping its tree-identity, mtime and conservation assertions. The progress-retention fixture publishes before pruning, preserving its projection/replay check without asking unknown-age history to repair an absent export. The interrupted-finalizer harness asserts identity-only owner publication at the same terminal/ownership boundary. The custody fixture now journals the job in the epoch it names, and the legacy epoch-switch fixture models a complete global prefix. No invariants were removed or weakened.

## Batch 1 corrections

`tests/integration/coordinator/proxy-wait-observation.integration.test.ts` required three type corrections in the already landed AC12 fixture: branded canonical work directory, a unary formatting callback, and a literal progress discriminant. Transport imports of the batch 1 cursor decoders also violated the existing layering invariant; they now use the public jobs wait contract, which reexports the same decoders. Delegated monitor teardown uses the sanctioned `gracefulKill` helper with timers capped by the original cleanup budget, replacing hand-written escalation. The workflow subset-cursor fixture now expects acknowledgements filtered to its requested membership, as implemented in batch 1. The existing layering and escalation invariants and focused regression tests pass without new allowlist entries.

## Phase D — AC4 read-only addressing

Batch 3 builds on `a65f29fd` and `fce969d4`. Revision S3 governs this evidence: ordinary read-only historical SQLite opens are permitted to change SQLite reader sidecars. Coral location records, exports, lock files, journal/meta bytes and durability synchronization remain forbidden on reads. No immutable-source policy or commit-fed view was added; `runtime/real.ts:openSqliteDatabaseSync` is unchanged. The existing `infra/fs-lock.ts:acquireSharedFileLockNoRepairSync` is reused.

| AC | Change (`path:symbol`) | Verification |
| --- | --- | --- |
| AC4 | `jobs/location-index.ts:JobLocationView/readOnlyView` exposes reads and time only. `coordinator/composition/request-ports.ts:createCoordinatorRequestPorts` injects that view, the historical observation port, availability observation and in-memory repair hint. `jobs/addressing.ts:location` admits an active journal detail without registration, including an epoch-less KB store. Admission registration stays in `location-index.ts:beforeAppend`. | Four unindexed active-terminal read-entry cases in `tests/integration/jobs/wait-read-purity.integration.test.ts`; epoch-less KB admission and restricted-view cases. |
| AC4 | `jobs/historical-reader.ts:readHistoricalSource/historicalSourceReader` opens a source read-only under the no-repair guard and checks its identity under that guard. Its transaction reads journal terminal/progress through `historicalDetail`, without hydration. `jobs/addressing.ts:historicalLocation` first preserves an AC6-validated retained outcome, otherwise reads closure before source facts. Decided closure plus successful terminal absence proves unrecoverable; missing, malformed or identity-mismatched sources stay unresolved. | Four historical read-entry cases with terminal and progress committed only in WAL, maintenance paused and unchanged main-file bytes. Missing/malformed guard, pending closure, identity mismatch and conclusive absence cases. Historical and cross-process epoch-switch regression suites. |
| AC4 | `jobs/historical-reader.ts:refreshHistoricalEpochs/refreshHistoricalEpoch` owns hydration and certification. `jobs/location-recovery.ts:recoverJobLocations` runs hydration at startup; `coordinator/composition/store-epoch-sweep-scheduler.ts:createStoreEpochSweepScheduler` runs retry, closure settlement, hydration, then retirement. | Explicit maintenance-only hydration/certification case; reads leave the historical location unresolved until the write owner runs. |
| AC4 | `jobs/shell/wait.ts:WaitCoordinatorDeps/resultPathFor` takes availability observation and an in-memory hint instead of ensure. `coordinator/contracts.ts:ExecutionServiceDeps`, `coordinator/composition/execution-services.ts:createExecutionServiceRegistry` and `coordinator/execution-service.ts:ExecutionService` pass only those read-side dependencies. `jobs/terminal/source.ts:withTerminalSource` inspects identity under its existing guard without acquiring a second repair-capable lock. | Missing, inside-window active-terminal artifact case delivers the canonical outcome, observes repair-pending, posts a hint and leaves the artifact absent. Storage and direct `node:fs` sync instrumentation detect the ensure/fsync controls. |
| AC4 | `jobs/location-index.ts:holdUnknownLocations/unknownLocationHolds` adds epoch identity and scheduled-retry evidence to existing holds. Historical recovery marks transient retryable holds; unsupported/missing sources remain permanent. Recovery-source quarantine clears retry scheduling. `jobs/addressing.ts:unknownJobDisposition/unknownJobCaveat` and the existing transport error envelope distinguish discovery uncertainty from permanent missing IDs. | Real hold observation cases; direct continuation/re-admission in `tests/unit/jobs/job-addressing.test.ts`; legacy transient/503 (exit 75) with an exact single retry command, and permanent jobs_not_found/404 (exit 1) with an epoch/reason caveat in `tests/unit/transport/jobs-detail-dispositions.test.ts`. |

The purity fixture snapshots the complete isolated data/store tree before and after each measured read, comparing paths, sizes, mtimes, inodes and byte hashes. It instruments mutating StoragePort/index calls, write-capable file opens, and direct `node:fs` fsync/fdatasync. Only `-wal`/`-shm` for databases actually opened by the read are excluded. SQLite sidecar creation may also change the containing directory's size/mtime; that directory's identity and all remaining children are still compared. Setup commits finish before measurement; source writers are quiescent and maintenance is absent.

The failed-publication case hydrates and certifies the retained terminal independently of export success, crosses expiry, proves retirement release, removes the source and constructs a fresh index/addressing instance. Detail and bounded wait still deliver the validated outcome and the owner observes retained-away. Removing usable terminal evidence plus the artifact leaves the job unresolved and denies retirement proof.

### Phase D falsifying controls

Each mutation was applied separately, executed with `env -i PATH="$PATH" HOME="$(mktemp -d)" LANG=C.UTF-8 TMPDIR=/tmp`, then restored in `finally`. All nine final control runs exited 1 for the intended assertion. Source mutations and the runner are recorded in `/tmp/waitfix-d-controls.py`; individual logs and `results.json` are in `/tmp/waitfix-d-controls/`.

| Control | Focused case | Intended failure observed |
| --- | --- | --- |
| Restore registration in lookup | Unindexed active terminal, scopeCheck | Mutating index/storage calls; location registration during read. |
| Restore unknown-epoch retry in lookup | Retry-scheduled hold | Seed registration/recording and hold clearing during read. |
| Restore historical refresh in addressing | Historical WAL terminal, detail | Hydration/certification/export mutation calls during read. |
| Restore artifact ensure in WaitCoordinator | Missing inside-window active artifact | Terminal recording, publication and durability sync during read. |
| Restore direct fsync in location reads | Historical WAL terminal, detail | Direct node:fs fsync calls are recorded. |
| Restore repair-capable source lock acquisition | Malformed guard | Renamed lock, replacement lock and changed filesystem paths/bytes. |
| Remove validated retained-terminal fallback | Publication failure, expiry, source retirement and restart | Retained terminal delivery becomes unresolved. |
| Treat failed source reads as successful absence | Missing guard after decided closure | Unresolved outcome becomes falsely unrecoverable. |
| Treat every unknown hold as retryable | Permanent missing-source hold | Typo disposition becomes discovery-unknown instead of missing. |

The final positive purity suite contains 19 cases. Snapshot purity and wire-visible availability/lost-progress wording remain in the atomic E–F completion batch. D preserves the legacy terminal wire shape and advertises no new capability. Retryable discovery therefore uses the supported transient error envelope and preserves the whole request in one retry command; v3 per-job dispositions arrive in E–F.

### Phase D fixture corrections

The historical-reader fixture previously asserted that a lookup enumerated and cleared an unknown-location hold. It now asserts lookup leaves the index untouched, followed by an explicit write-owned retry that performs enumeration. The v2 carrier-abort mock now supplies the new read-only hold method; its cancellation/timer assertions are unchanged. The live-WAL epoch-switch fixture now creates the matching lineage marker during setup, so guarded reads can establish the source identity. Its progress, exact terminal and independent-epoch cursor assertions are unchanged. No invariant was removed or weakened.

### Phase D gate

The gate ran sequentially under the same isolated environment recorded in `/tmp/waitfix-d-gate/environment.json`. Both knip runs passed; the second moved `dist/` aside and restored it in `finally`. After the two fixture corrections above, the affected checks passed and the gate resumed from the failing suite. Supplemental typecheck/lint/format checks cover those fixture edits. The initial failures remain recorded in `npm-test-initial.log` and `test-integration-initial.log`; all final gate exits are 0. No production source changed during gate recovery.

| Gate | Final result | Duration |
| --- | --- | --- |
| typecheck:tests | Pass | 2.3 s |
| lint | Pass | 37.7 s |
| format:check | Pass | 10.0 s |
| knip (dist present) | Pass | 1.0 s |
| knip (dist moved aside and restored) | Pass | 1.0 s |
| build | Pass | 26.3 s |
| npm test — 2,306 tests / 453 files | Pass | 23.1 s |
| test:integration — 373 tests / 82 files | Pass | 115.4 s |
| test:store-reset:integration | Pass | 2.1 s |
| verify:store-reset-build | Pass | 2.9 s |
| test:e2e:lifecycle | Pass | 2.1 s |

Final logs and machine-readable gate results are in `/tmp/waitfix-d-gate/`. The new purity suite ran in the complete integration gate; its 19 cases all passed. The initial and final focused fixture/contract logs are under `/tmp/waitfix-d-*.log`.
