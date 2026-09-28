# TODO — route each build to a store family for its format

**Status**: dormant design. Store-epoch succession and historical job reads are implemented; fingerprint-keyed routing is not.

`routeOrOpenBackendStoreAtStartup` in `src/store/startup-store-routing.ts` selects the active epoch family for a flavor. `classifyStoreFormat` in `src/store/db.ts` still decides whether that epoch's contents are writable by this build. Upgrade escalation can defer a format-changing succession until no work is live, then retire and mint an epoch; `JobLocationIndex` in `src/jobs/location-index.ts` keeps known historical jobs addressable. None of this gives two formats independent active store families or migrates SQL rows between them.

## Design still owed

A fingerprint-keyed layout would let a build find its own format family. It needs a format-neutral selector that prevents an older build from silently resuming an obsolete history, plus one coordinator namespace across all families. The path itself cannot authenticate the database: each opener must still classify metadata and unreadable contents. `classifyStoreFormat` can reject a newer product version even when the fingerprint matches, so routing alone does not make every same-format build compatible.

The old illustrative flat path `formats/<fingerprint>/store.db` predates write-once epochs. A current design must put an epoch family beneath each fingerprint and define what happens when a pre-routing build opens the old selector. Changing only the path would leave the same fingerprint in two physical histories. A format-neutral transition fence must make that split impossible before publication.

`recovery_quarantine` belongs with the format whose records it describes. Historical selectors must identify both format and epoch, and any pruning decision must prove that no live owner or retained result depends on the selected family. [`no-store-migration-path.md`](./no-store-migration-path.md) tracks transforming old SQL state into the new format; address routing does not perform that transformation.

## Crash recovery that must precede routing

Coordinator-local provider hosts still have no boot-time containment recovery. `ensureProviderServerHandle` in `src/coordinator/live/provider-hosts/recovery.ts` repairs a host held by the current process; it does not discover one orphaned by a dead coordinator. `routeOrOpenBackendStoreAtStartup` can select a successor epoch before `runStartupRecovery` in `src/coordinator/lifecycle.ts`, so a containment record stored only in the old SQL epoch could disappear from the recovery view while its process group remains alive.

That recovery needs a format-neutral pre-routing record naming both the exact host containment and the coordinator that owned it. A successor may reap only after positive evidence that the owning coordinator is absent. Keep this terminal, non-inheritable host record distinct from a proxy-set handoff capsule, which a successor can redeem.

## Start condition

Choose the format-neutral selector and transition fence against the current epoch protocol. Specify how a build finds historical quarantine and jobs, and how a rollback refuses or selects a prior family without forking history. Design the pre-routing host-containment recovery window with them. No fingerprint-keyed layout has been implemented or simulated.
