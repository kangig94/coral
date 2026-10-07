# TODO — enforce additive durable records across builds

**Status**: open. The mixed-build compatibility policy is settled; its repository-wide enforcement is still owed.

A running coordinator may read records written by a newer installed CLI or successor, and a retained older build may reopen an epoch. A durable record at an existing address must preserve existing field names, types, and meanings; added fields are optional and unknown keys are tolerated. A shape that cannot satisfy that contract needs a new versioned address. Quarantine protects an unreadable row from destruction but can leave work stalled, so it is not a substitute for compatible readers.

`strictBundleManifestSchema` in `src/infra/bundle-manifest.ts` is deliberately strict. The succession capability declaration therefore lives beside the manifest in `src/coordinator/succession/protocol.ts`, at a separate address. `run/upgrade.v1.json` is revision checked and tolerates unknown keys. Those examples do not enforce the rule for every durable record.

## Start condition

Inventory durable record schemas and their supported shipped readers. Add a mixed-build contract gate that fails on removing, renaming, retyping, or newly requiring a field at the same address. Include the job read and subscription records consumed by [`jobs-read-contract-schema-first.md`](./jobs-read-contract-schema-first.md) and [wait artifact availability](../architecture.md#result-exports).
