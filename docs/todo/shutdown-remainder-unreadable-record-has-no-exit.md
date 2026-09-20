# Shutdown-remainder unknown evidence has a durable exit

**Status**: resolved.

## Resolution

`pruneShutdownRemainderRecords` returns unreadable, unsupported, age-unobservable, and unpublishable subjects
as typed deferrals. Their bytes stay at the original address; there is no `.quarantined` rename. The disposition
names `next-coordinator-start` as successor and permits exactly one content retry there.
`createShutdownRemainderPruner` keeps the subject's incarnation with that disposition, so periodic maintenance
does not reread the same evidence. Replacing the directory entry changes its incarnation and makes the new
subject eligible for ordinary classification.

The active record store is still finite. When more than 32 final-record subjects exist, decodable records are
retained before opaque ones and ties use bytewise subject order. A deletion that overrides unknown age or
content is returned as `cleanup.kind = 'truncated'`: it names the exact lost subjects and causes, the
`bounded-shutdown-remainder-store` authority, the retained count, and that subject identity plus cause are the
only surviving evidence. This is capacity authority, not an age inference. A refused deletion remains a named
cleanup refusal and is not reported as truncation.

## Superseded observations

The earlier note said pruning ran only once at startup. That became stale when
`createShutdownRemainderPruner` restored the periodic scan. It also proposed count- or age-based expiry for
unreadable evidence; those bounds would turn an unknown into deletion and are not part of the resolution.
