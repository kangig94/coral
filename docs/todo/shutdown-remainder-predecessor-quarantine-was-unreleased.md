# The predecessor shutdown-remainder quarantine layout was never released

**Status**: closed 2026-09-20. This record exists so the nested layout is not mistaken for a production
migration population again.

## Decision

Do not add a reader or reconciler for `shutdown-remainder.v1/quarantine/<subject>/<slot>/evidence`. Treat a
top-level `quarantine` entry, like every other name outside the current flat record/stage vocabulary, as
present and unrecognized. Status names it and says this build did not act on it; pruning does not report
`cleanup: complete` while it remains.

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

`tests/unit/coordinator/shutdown-remainder.test.ts` seeds the exact predecessor layout and asserts both sides
of the surviving contract: the scanner reports the top-level `quarantine` identity as unrecognized, and the
pruner refuses to call the directory complete while leaving it untouched.
