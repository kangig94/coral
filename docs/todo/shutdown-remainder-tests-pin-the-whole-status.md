# Shutdown-remainder tests pin the whole rendered status instead of the property under test

**Status**: open, narrowed. The coordinator-suite half is settled; the transport companion remains. Found
by a tier-1 review of the shutdown-remainder record and its retention.

## What is wrong

Several tests in `tests/unit/coordinator/shutdown-remainder.test.ts` asserted with `toEqual` against the
full decoded shape, even where the test's own name named a narrow behavior. Two concrete instances:

- `'skips an unknown successor evidence kind without rejecting readable entries'` asserted the entire
  decoded `future-instance` record even though the behavior under test is what happens to the *skipped*
  entry — the kept record's shape is incidental to that. **Settled**: it now asserts the skipped entry and
  that the readable entry survived, and nothing else.
- `'skips corrupt and undecodable files beside readable records'` asserted the full decoded
  `known-instance` record even though the behavior under test was the `skippedRecords` classification of
  the *other* two files. **Settled by deletion**: the directory scan it exercised no longer exists, and a
  single-address reader classifies one file with no neighbours to skip.

Both acted like a snapshot: an unrelated field added anywhere in the decoded-record projection (a change
design-philosophy.md principle 10 explicitly sanctions — a durable record is additive-only) forced an edit
to these tests even though nothing the test's title claimed to check had changed, and a failure here did
not say which property regressed without reading the diff by hand. The `toEqual` sites that remain in that
file are round-trip tests whose names say the full shape *is* the contract being pinned.

## Where the same pattern recurs

`tests/unit/transport/http/backend-status.test.ts` has roughly twenty `toEqual({...})` call sites against
the full `getBackendStatusFull` result, the no-daemon reader that layers its own recency and instance
scoping on top of `classifyShutdownRemainderFile`. That file belongs to a different subsystem's test suite
(owned alongside `src/transport/`), so narrowing it is a companion cleanup rather than part of this entry,
but the same fix shape applies: pull the assertion down to the field the test name claims to verify. Not
every site there is an instance — several deliberately pin the entire status union so an added field cannot
slip through a spread, and those are the "full shape genuinely is the contract" case below.

## What would settle it

For each `toEqual` call whose test name names a narrower property than the full result: replace it with an
assertion on that property alone (e.g. `.skippedEntries`, `.skippedRecords`, or the one `records[n]` field
that actually changed), or — where the full shape genuinely is the contract being pinned, such as a
wire-shape freeze test — say so in a comment rather than leaving the coupling implicit. This is a test-quality
cleanup with no production-behavior change; it does not need to close before or alongside anything else in
this directory.
