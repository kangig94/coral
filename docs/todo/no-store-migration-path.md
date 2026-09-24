# TODO — a format change starts a fresh store epoch, because there is no migration

**Status**: open, unscheduled. Recorded 2026-09-12 while designing the write-once epoch layout that
prevents store-reset work from refusing a boot. That layout does not carry data forward.

## The fact

`classifyStoreFormat` in `src/store/db.ts` classifies a store with user tables as follows:

| Observation | Result |
| --- | --- |
| fingerprint or product-version metadata is absent or invalid | `corrupt-or-unsupported` |
| stored product version is newer than current | `newer-incompatible` |
| stored fingerprint equals current and the product version is not newer | `compatible` |
| stored product version is older and fingerprints differ | `older-incompatible` |
| versions equal and fingerprints differ | `corrupt-or-unsupported` |

Absent product-version metadata is `corrupt-or-unsupported`, even when a fingerprint is present; there
is no adoption classification.

`tryOpenCurrentEpoch` in `src/store/epoch.ts` maps every non-opened classification to replacement, and
`settleStoreEpoch` publishes a complete successor epoch. The previous positive epoch remains as retained
data until positive-epoch retention removes it, but the successor carries none of its jobs, sessions,
journal, or KB projection history. The previous generation's flat `store/store.db` is outside discovery
and remains untouched.

The fingerprint covers the executable SQL manifest and persisted codecs. A release that changes
`src/store/schema.sql` therefore changes the fingerprint and starts a fresh active epoch unless it also
provides a migration path. Measured on 2026-09-12, 9 commits had touched `src/store/schema.sql` against
33 release tags. The epoch design removed the former copy, quarantine, and 1-GiB boot veto; it did not
make incompatible data readable by the successor.

## Why retention is not migration

`reapPostReadyStoreEpochEntries` in `src/store/epoch.ts` can delete a retained older epoch without checking
for `running` rows. That separate disposition gap is tracked in
[`store-epoch-replaced-on-undeterminable-open.md`](./store-epoch-replaced-on-undeterminable-open.md).

Keeping the superseded positive epoch preserves its bytes temporarily. It does not make those rows part
of the current authority: this build does not copy from it, transform it, or open it as the active store.
The flat previous-generation artifact is preserved for rollback but is never an epoch candidate.

Preservation therefore buys rollback or manual inspection, not continuity.

## What the shape of a fix would have to answer

- **What a migration is addressed by**, given §10. The fingerprint is derived from the DDL, so a
  migration cannot be keyed on it without the key changing underneath the migration. A separate,
  monotonic schema generation with its own owner is the candidate, with the fingerprint retained as the
  integrity check rather than as the version.
- **Which direction is supported.** Forward-only migration still leaves a rollback meeting a store it
  cannot read. Today `newer-incompatible` selects another fresh successor rather than carrying data
  backward, so a migration design must decide whether rollback refuses, routes to a compatible epoch, or
  transforms the data.
- **What happens to a migration that fails halfway**, on the startup path. A failed candidate must not
  become current or make the previously published epoch unavailable; publication needs an atomic commit
  boundary at least as strong as the epoch directory rename.
- **Whether every DDL change needs one.** Many are additive — a new table, a new nullable column — and
  additive changes are exactly what a tolerant reader survives. The fingerprint does not distinguish
  additive from destructive, so it reports every change as fatal. Distinguishing them may be most of the
  fix.

## Not the same entry as `store-format-routing.md`

[`store-format-routing.md`](store-format-routing.md) is the sibling half and the two do not close
together. It asks how an **older** build finds and opens a store in its own format — a layout question,
answered by keeping more than one store. This asks how a **newer** build carries an older store's data
forward — a transformation question. Fingerprint-keyed routing
would let both builds run without either destroying the other's store, and would still leave every
upgrade starting from nothing.

## What to do in the meantime

Nothing here blocks a release. But a release that changes `src/store/schema.sql` should say so in its
notes, because today it reads as an ordinary patch and is not one.
