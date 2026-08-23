# Routing-status persistence stays behind runtime ports

**Status**: closed by step 18 of `backend-routing-disposition`.

## Resolution

`tests/invariants/no-domain-ambient-io.test.ts` now scans `src/coordinator` for ambient filesystem, OS,
subprocess, SQLite, and cryptographic-randomness imports. The Journal database owner in `src/store/db.ts` and
the delegated-process owner in `src/coordinator/handoff-runner.ts` are named, module-specific exemptions;
`src/coordinator/handoff-routing-status.ts` is not exempt.

`src/coordinator/handoff-routing-status.ts` retains the bounded event vocabulary, transition and retention
rules, total policy, and read projection. `src/store/handoff-routing-status-store.ts` owns the SQLite schema,
transaction boundary, SQL append/query operations, and raw snapshot. Filesystem mutation and the SQLite engine
arrive through `StoragePort`, while generated retirement IDs arrive through the runtime ID port.

The real runtime binds those ports to the host filesystem and `node:sqlite`. `InMemoryStorage` binds each
virtual database path to an in-memory SQLite database and a virtual filesystem entry, so a simulation
publication can commit and be read back without creating the corresponding host path.

## Verification

The focused simulation test publishes a selection at a virtual absolute path, asserts a committed sequence,
reads the current projection through the same simulation runtime, and asserts the host path remains absent.
The widened invariant rejects a direct `node:sqlite` import under `src/coordinator`.
