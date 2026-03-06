# Backend Owner Handoff Must Fence Admission Before Releasing Ownership
## Rule
When replacing or shutting down a singleton backend, do not remove discovery or lock artifacts until the backend has already stopped admitting new work. Ownership release must happen after the listener is closed and the old owner can no longer accept or start requests.

## Why
If `backend.json` or the ownership lock disappears while the old backend is still draining, another process can win the lock and publish new discovery data before the old owner is fully gone. That produces two valid-looking owners during restart or version-mismatch recovery even though the design nominally uses a singleton lock.

## Pattern
```text
WRONG
shutdown starts
remove backend.json / backend.lock
old backend still draining or briefly still accepting requests
new backend starts and publishes itself
=> overlapping owners
```

```text
RIGHT
shutdown starts
transition to draining
close listener / reject new requests
wait for drain boundary
remove backend.json / backend.lock
=> ownership is released only after admission is fenced
```
