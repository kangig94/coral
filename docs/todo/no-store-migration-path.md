# TODO — migrate store data across format generations

**Status**: open, unscheduled. Store-format changes preserve job identity and retained results, but do not transform an older database into the active schema.

`classifyStoreFormat` in `src/store/db.ts` compares the persisted product version and format fingerprint. A differing fingerprint is not accepted as the current writable format. `createStartupMintAuthorizer` in `src/coordinator/succession/startup-retirement.ts` can authorize a fresh epoch after custody and historical-location checks. A retained old-format build may continue live work in the protected old epoch, and `JobLocationIndex` in `src/jobs/location-index.ts` keeps known jobs addressable across the switch. The new database still begins with fresh SQL-owned state, including corpus and recovery tables.

Retention, historical reads, and result artifacts are continuity for known jobs. They do not copy or transform old sessions, KB state, or other SQL rows into the new authority. The previous generation's flat store remains outside epoch discovery.

## Questions a migration design must answer

- How to version an ordered migration separately from the fingerprint, which changes with DDL.
- Whether a rollback reads an older-format epoch, refuses a newer one, or transforms data backward.
- How to make a failed migration leave the published predecessor intact and unavailable candidates unselected.
- Whether compatible additive DDL can be handled without a full migration.

[`store-format-routing.md`](./store-format-routing.md) asks how different builds locate their own format; this entry asks how a newer build carries old data into its new format. Neither is a reason to weaken the current custody and result gates.
