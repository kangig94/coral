# Wait read/write split — Phase C verification

Implemented scope: AC6, AC2 and AC3, on top of batch 1 (`a65f29fd`). Revision S1 governs publication: no export lock, operation child or publisher watchdog. The wait wire format and its existing ensure call remain for batch 3.

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
