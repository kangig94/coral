# The predecessor shutdown-remainder quarantine layout was never released

**Status**: closed 2026-09-20. This record exists so the nested layout is not mistaken for a production
migration population again.

## Decision

Do not add a reader or reconciler for `shutdown-remainder.v1/quarantine/<subject>/<slot>/evidence`. The
question is now moot on the reading side as well: the remainder lives at one address,
`shutdown-remainder.v1.json`, nothing enumerates the run directory, and nothing deletes — so a leftover
`shutdown-remainder.v1/` directory from an unreleased build is simply never opened. It is disposable
development state, and a reconciler for it would be exactly the compatibility code design-philosophy
principle 1 forbids.

## Proof of the empty supported-runtime population

- Commit `b1f342b82770bb775e83da40111cce030d824360` introduced the only production writer for the nested
  layout. The next commit on this branch,
  `0c09fee47258b70442ac40a996469e19591461ef`, removed that writer. There is no intervening branch commit.
- `git tag --contains b1f342b8` returns no tag. The remote release tags likewise contain no descendant of
  that commit. The commit therefore never entered a released plugin bundle.
- The committed `clients/bridge` runtime was last changed by `Release v0.10.9` at
  `2bb4a471369bc9703b67d54e31896decdb2e0044`, before the nested writer existed. Its manifest still identifies
  v0.10.9. Normal hooks and CLI startup execute `bridge/coral-backend.cjs`; they do not execute `src/`.
- The ordinary build writes `clients/build/coral-backend.cjs`; only the release build copies artifacts to
  `clients/bridge`. Building the branch does not launch the generated backend. The repository occurrences
  that constructed the predecessor path outside the removed writer were test fixtures backed by synthetic or
  temporary storage.

Those facts prove the layout has no population produced by a supported installed runtime. A manually invoked,
unreleased build artifact is disposable development state and does not justify permanent compatibility code
under design-philosophy principle 1.

## Regression boundary

There is nothing left to guard. The scanner and the pruner that the predecessor layout was measured against
were both deleted with the directory, and `tests/unit/coordinator/shutdown-remainder.test.ts` no longer
seeds that layout: a reader that derives one address opens no directory entry to classify. The boundary that
survives is the address itself — `SHUTDOWN_REMAINDER_RECORD_NAME`
(`src/infra/shutdown-remainder-record.ts`) — and the tests that pin it.
