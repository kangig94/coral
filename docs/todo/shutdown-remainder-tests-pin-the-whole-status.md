# Shutdown-remainder tests pin the whole rendered status instead of the property under test

**Status**: open. Found by a tier-1 review of the shutdown-remainder record and its retention.

## What is wrong

Several tests in `tests/unit/coordinator/shutdown-remainder.test.ts` assert with `toEqual` against the full
`ShutdownRemainderStatusRead` `available` shape, even where the test's own name names a narrow behavior.
Two concrete instances:

- `'skips an unknown successor evidence kind without rejecting readable entries'` asserts the entire decoded
  `future-instance` record (`status.records[0]`, reconstructed via `...recordAt(...)`) even though the
  behavior under test is what happens to the *skipped* entry — the kept record's shape is incidental to that.
- `'skips corrupt and undecodable files beside readable records'` asserts the full decoded `known-instance`
  record via `decodedRecordAt('known-instance')` even though the behavior under test is the `skippedRecords`
  classification of the *other* two files.

Both act like a snapshot: an unrelated field added anywhere in the decoded-record projection (a change
design-philosophy.md principle 10 explicitly sanctions — a durable record is additive-only) forces an edit
to these tests even though nothing the test's title claims to check has changed, and a failure here does not
say which property regressed without reading the diff by hand. The neighboring `toMatchObject` assertions in
the same file (the majority of the sixteen `toEqual`/`toMatchObject` call sites) do not have this problem —
`toMatchObject` checks only the keys it lists, so it already narrows to the property under test.

## Where the same pattern recurs

`tests/unit/transport/http/backend-status.test.ts` has roughly twenty `toEqual({...})` call sites against the
full `getBackendStatusFull` result, the no-daemon reader that layers its own recency and instance scoping on
top of `scanShutdownRemainderRecords`. That file belongs to a different subsystem's test suite (owned
alongside `src/transport/`), so narrowing it is a companion cleanup rather than part of this entry, but the
same fix shape applies: pull the assertion down to the field the test name claims to verify.

## What would settle it

For each `toEqual` call whose test name names a narrower property than the full result: replace it with an
assertion on that property alone (e.g. `.skippedEntries`, `.skippedRecords`, or the one `records[n]` field
that actually changed), or — where the full shape genuinely is the contract being pinned, such as a
wire-shape freeze test — say so in a comment rather than leaving the coupling implicit. This is a test-quality
cleanup with no production-behavior change; it does not need to close before or alongside anything else in
this directory.
