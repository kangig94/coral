# TODO — decide whether a proven capsule retirement needs a crash-exact receipt

**Status**: open design. The current rescan is intentional; no durable retirement receipt exists.

`recordedProcessesAllAbsent` in `src/coordinator/services/provider-proxy-set/index.ts` lets a foreign V2, V3, or V4 capsule retire only after every recorded process is observed absent. `retireProviderHandoffCapsule` in `src/coordinator/services/provider-proxy-capsule-discovery.ts` unlinks it, tolerates a repeated `ENOENT`, and reports retirement only after directory sync. A failed sync can leave a readable file after a crash. The next boot scans that file and re-derives the all-absent decision. This is bounded, non-capacity-consuming residue, but it does not preserve the original evidence or decision.

A stronger guarantee needs a durable receipt written before unlink, keyed by the exact capsule path and its deciding evidence. A build that cannot decode a receipt must not use it to authorize deletion. The receipt needs a named retirement owner; a quarantine row or operator command by itself adds no useful exit to the current bounded rescan.

## Constraints before adding a recovery boundary

- `deleteCompletedRetry` and `completeAbsentRetry` in `src/recovery/containment.ts` throw when a revision-checked completion loses its row. Decide the successor state for a capsule-path subject before using that pattern.
- `assertRecoverySourceRegistryComplete` in `src/recovery/source-registry.ts` runs before the provider-proxy lifecycle is constructed, so a new source needs an early narrow facet resolved at retry time.
- `tests/unit/recovery/retry-service.test.ts` repeats the boundary manifest in its expected ids, source constructors, and runtime registrations. A new boundary must update each representation.
- A capsule-path subject needs an `until-cleared` revision fixture in `tests/integration/coordinator/recovery-quarantine-composition.test.ts`; the generic fingerprint fixture describes a different subject.

## Start condition

Establish a case where a later-boot rescan cannot run or where preserving the original retirement decision materially changes recovery. Then design the receipt and its unattended exit. The undecidable-absence cases belong to [`legacy-v1-capsule-retirement.md`](./legacy-v1-capsule-retirement.md).
