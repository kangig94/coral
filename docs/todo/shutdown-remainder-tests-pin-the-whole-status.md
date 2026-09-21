# Backend-status tests pin the whole result when they test one shutdown-remainder property

**Status**: open. Only the transport-suite sweep remains.

## What is wrong

`tests/unit/transport/http/backend-status.test.ts` has many `toEqual({...})` assertions against the complete
`getBackendStatusFull` result. Some test names claim a narrower shutdown-remainder behavior, such as recency,
instance scoping, or one skipped classification, but their assertions pin unrelated fields in the status
union too. Adding an unrelated additive field can therefore break a test whose named behavior is unchanged,
and the failure does not identify the property that regressed.

Not every full-shape assertion is wrong. Tests that deliberately freeze an entire status-union member should
continue to do so.

## What is owed

For each full-result `toEqual` whose test name names one narrower property, assert that property directly.
Where the complete shape is intentionally the contract, make that intent explicit in the test rather than
leaving it indistinguishable from incidental coupling.

This is a test-quality change only. The corresponding coordinator-suite cases in
`tests/unit/coordinator/shutdown-remainder.test.ts` are outside this entry.
