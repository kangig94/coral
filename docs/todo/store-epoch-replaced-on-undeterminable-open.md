# TODO — preserve rejection causes for disproven store epoch candidates

**Status**: open, one member.

`StoreEpochProof` in `src/store/epoch.ts` carries a cause for `unobservable` but only `{ kind: 'disproven' }` for a disproven candidate. A wrong file type, cross-device entry, missing database or lock, and malformed `epoch.json` therefore collapse into the same answer. The successor can record which candidate it rejected, but not why.

Add a bounded, public-safe cause to the `disproven` arm and carry it into store-reset listing and the successor's provenance. Preserve the distinction between decisive disproof and an observation that could not be made. A cause must not turn unreadability into permission to close or delete an epoch.

The active mint path now requires a coordinator retirement disposition after custody and historical-location checks; the post-ready sweep requires closure and result release. Those rules do not supply the missing rejection cause.

## Start condition

Enumerate the `StoreEpochProof` producers in `src/store/epoch.ts`, then give every disproven arm a cause that the listing and publication paths can render without raw filesystem or SQLite error text.
