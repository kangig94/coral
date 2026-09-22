# TODO — a store epoch that stays unopenable is still replaced, and its live work is abandoned

**Status**: open, needs a design decision. Filed 2026-09-22 from the #367 post-mortem. Transient causes are already handled; what remains is the persistent case and the fate of an epoch once it is left behind.

## What holds now

`settleStoreEpoch` (`src/store/epoch.ts`) gives a non-decisive failure to open, or to observe, the current or newest epoch a bounded patience window before it gives up: repeated attempts against one absolute deadline, with SQLite waits recomputed from it. The window itself stays below the IPC health timeout; the mint that follows it is not bounded by that window, so a slow disk can still block startup past a probe. Decisive causes — an incompatible format, `SQLITE_CORRUPT`, `SQLITE_NOTADB` — still replace immediately, and the reason for any replacement is recorded in the successor's `epoch.json`, where a failure to write that record still throws as it did before.

## What remains

### 1. A persistent unknown still authorizes replacement

Once the window is spent, an epoch that could not be opened or observed is replaced exactly as before, and its `running` jobs are abandoned. Under design-philosophy §11 unknown evidence may not authorize a finalization, and replacing an epoch is one.

The hard part is what to do instead. §12 rules out waiting for a person, and refusing to boot would brick every project on the machine, which is the failure 0.10.3 shipped. A design has to leave both of these true:
- an epoch that cannot be proven unopenable is not silently abandoned;
- the machine still reaches a working coordinator.

Candidates, none chosen:
- a successor that keeps the old epoch addressable and settles or exposes its `running` jobs, carrying the recorded cause;
- patience that spans boots, deferring the switch while the evidence stays unknown;
- a degraded boot that refuses writes.

### 2. An abandoned epoch has no exit

Reads resolve only the highest proven epoch (`resolveCurrentStore`), and startup recovery scans only the database it opened. Nothing adopts, settles, or exposes an older epoch's rows, so its jobs answer `jobs_not_found` forever.

`reapPostReadyStoreEpochEntries` retains the two highest proven epochs and never checks for live rows, so a third epoch makes the abandoned one deletable with its `running` jobs still in it. That check can be added on its own, and should be before anything makes abandonment more common.

### 3. A disproven candidate does not say why

Missing metadata is named. Every other disproven cause — a wrong file type, a cross-device entry, a missing database or lock, malformed metadata — collapses into a bare `disproven`, because `StoreEpochProof` carries no cause for it. The successor records which candidates were rejected but not what was wrong with them.

## Out of scope

- Migration across format generations: [`no-store-migration-path.md`](./no-store-migration-path.md).
- Minting starved by an external reclaimer: [`store-epoch-minting-under-sustained-external-interference.md`](./store-epoch-minting-under-sustained-external-interference.md).

Neither closes with this entry.

## To start

Member 2's retention check and member 3's cause are independent of the decision in member 1, and either can ship on its own. Member 1 needs the design pass, and the causes now recorded in `epoch.json` are the evidence for how often the persistent case actually occurs.
