# Two kinds of residue in the generation run directory

**Status**: open, observation only. Both were found while investigating an unrelated machine freeze on
2026-08-24; neither is attributed to a code path yet, and the counts below are what a single census found
rather than a rate.

## Provider sockets nothing listens on

The run directory held 21 `provider-*.sock` entries. `ss -xl` showed **none of them bound to a live
listener** — every one is a filesystem entry whose process is gone. Their dates spread across a week: nine
from 2026-08-17, three from 08-18, one from 08-22, two from 08-23, six from 08-24.

That spread is the part worth keeping. A socket left by yesterday's crash is residue; sockets left by seven
separate days are a path that never cleans up, surviving coordinator restarts — including a deliberate one on
08-23 that killed every Coral process on the machine and verified none remained.

What this is not: `clearStaleSocket` (`src/transport/ipc/server.ts`) does reclaim a stale *coordinator* socket
before binding, using `ECONNREFUSED` as a decisive negative observation. These are provider sockets, and
nothing appears to sweep them. Whether that is because no owner is responsible, or because the owner only
sweeps what it recorded and these were never recorded, is exactly what has not been established.

## A spawn that keeps reaching for a deleted test tree

The coordinator log carries 95 Node crash dumps of the same shape:

```
Error: Cannot find module '/tmp/coral-hooks-QGsWsp/plugin-root/bridge/coral-backend.cjs'
code: 'MODULE_NOT_FOUND'
```

The suffix differs per occurrence, so these are distinct temporary plugin roots, each created and then removed
while something still tries to spawn a backend from it. The path shape is a test fixture's, not an installed
plugin's.

Two things about it are worth recording even before the cause is known. The failure is a bare Node module
resolution error with a full stack, which means the spawn reached `run_main` rather than being refused by
anything that could have said "that artifact is gone" — compare `resolveBackendArtifact`
(`src/provider-proxy/role-spawn.ts`), which exists to decide which backend artifact is legitimate. And the
dumps land in the real coordinator's log, so whatever is spawning is writing into the production log stream
from a test-shaped path.

## Why these are recorded together

Only because one census surfaced both, and someone chasing stray state in the run directory will meet them
together. They are not the same defect and should not be fixed as one.

## Start condition

Either can be picked up alone. The socket sweep wants an owner decided first: which party is responsible for a
provider socket whose process is gone, given that the coordinator that recorded it may itself be gone. The
spawn failure wants attribution first — find what holds the removed path and why the spawn is attempted at all.
