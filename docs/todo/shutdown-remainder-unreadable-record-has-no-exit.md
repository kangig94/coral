# Shutdown-remainder unknown evidence has a durable exit

**Status**: resolved.

## Resolution

`pruneShutdownRemainderRecords` no longer retains unreadable or unsupported records in the active record set
until a count bound deletes them. It atomically renames them with a `.quarantined` suffix and returns
`cleanup.kind = 'quarantined'` with the original subject names. The same successor owns malformed stages,
partial stages whose writer is unobservable, and complete stages that cannot be published after their writer
is no longer known alive.

Quarantined names are durable but do not match either the record or stage address, so the periodic maintenance
pass classifies them in its returned disposition without reading or reclassifying their content.
`createShutdownRemainderPruner` retries each quarantine once when the next coordinator starts, before its
initial prune. Evidence that has become readable or publishable returns to the active set; a persistent refusal
returns to quarantine rather than entering an unbounded periodic loop.

No count or age limit finalizes quarantined evidence. The 32-record limit remains only for records whose bytes
were decoded and whose identity matches their canonical filename.

## Superseded observations

The earlier note said pruning ran only once at startup. That became stale when
`createShutdownRemainderPruner` restored the periodic scan. It also proposed count- or age-based expiry for
unreadable evidence; those bounds would turn an unknown into deletion and are not part of the resolution.
