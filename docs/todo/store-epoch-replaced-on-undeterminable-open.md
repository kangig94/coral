# TODO — an epoch that could not be opened is replaced, and its live work is abandoned

**Status**: open, needs a design decision. Filed 2026-09-22 from the #367 post-mortem and a source scan.

## Observed

In #367 a coordinator exited process-fatally mid-drain. Its replacement, eleven minutes later, came up on a **new** store epoch. epoch-1 still held three `running` jobs with projection cursors 8 events behind the journal. After the switch those jobs answer `jobs_not_found`, and nothing will ever settle them.

The reporter's `epoch-2/epoch.json` is unavailable, so which classification caused the switch is not known.

## What exists (verified in source)

`settleStoreEpoch` (`src/store/epoch.ts`) is the only automatic minter of a successor epoch. It switches in two ways that do not decide anything:

- **`unavailable`.** `tryOpenCurrentEpoch` catches every failure from any of these steps, returns `unavailableClassification()`, and the caller mints:
  - `acquireStoreEpochReadLock`, including the re-observation after the lock;
  - `assertProvenStoreOpenable`;
  - `openWritableStoreDatabase`;
  - `registerStoreEpochHolder`.

  The likeliest transient cause is contention. Format classification runs before any busy timeout is installed, and `raiseStoredProductVersion` then takes `BEGIN IMMEDIATE` under the 750 ms startup timeout.
- **`absent`.** When candidate epochs exist but none is proven, `currentProvenEpoch` returns null, and the mint records the same `absent` a genuinely empty root records.

Known format incompatibility and `store-reset discard` also mint, and those are by design.

**An abandoned epoch has no exit.**
- Reads resolve only the highest proven epoch (`resolveCurrentStore`), and startup recovery scans only the database it opened.
- Nothing adopts, settles, or exposes the older epoch's rows.
- `reapPostReadyStoreEpochEntries` retains the two highest proven epochs and never checks for live rows. Once a third epoch exists, the abandoned one is deleted with its `running` jobs.

Nothing records why the switch happened. The successor's `epoch.json` stores only the classification kind, and no log line names the swallowed failure, so a field report cannot be diagnosed after the fact.

## Decided

- Unknown evidence may not authorize replacement (design-philosophy §11). A live-job query is **not** the gate: the rule holds whether or not live work can currently be enumerated.
- Decisive and undeterminable open failures are distinguished by errcode class:
  - `SQLITE_NOTADB` / `SQLITE_CORRUPT` are decisive;
  - `SQLITE_BUSY`, permission, resource-exhaustion, and generic I/O errors are not.

  The handoff-routing store already draws this line in `unreadableOrUndeterminableClassification`. Reuse the split, not that function: it misfiles `SQLITE_BUSY` met before its transaction ([`routing-status-contention-read-as-undeterminable-artifact.md`](./routing-status-contention-read-as-undeterminable-artifact.md)).
- Discovery must tell apart three cases: no candidate at all, candidates definitively disproven, and a candidate that could not be observed. Only the first two may flow to `absent`.

## Open: what happens when "undeterminable" persists

Holding the current epoch through a bounded retry and then refusing to boot is the obvious reading of §11. Against a persistent cause, such as permissions or a filesystem fault, it leaves Coral unable to start for every project. That is a hold with no exit (§12), and 0.10.3 shipped exactly that kind of boot failure.

The decision needs a shape where both of these hold:
- the undeterminable epoch is not silently abandoned;
- the machine still reaches a working coordinator.

Candidates to evaluate, not chosen:
- a successor epoch that keeps the old one addressable and settles or exposes its `running` jobs, with the recorded cause;
- bounded retry across boots, with the switch deferred to a later boot while the evidence stays undeterminable;
- a degraded boot that refuses writes.

## Out of scope

- Migration across format generations: [`no-store-migration-path.md`](./no-store-migration-path.md).
- Minting starved by an external reclaimer: [`store-epoch-minting-under-sustained-external-interference.md`](./store-epoch-minting-under-sustained-external-interference.md).

## To start

This needs a design pass on the three-way open disposition and the persistent-undeterminable exit.

Recording the stage and cause of the swallowed failure in the successor's `epoch.json` changes no decision, and it can land first. That record is what will say how often the transient case occurs.

The sweeper's live-row blindness can be fixed independently, and should be before any change that makes abandoned epochs more common.
