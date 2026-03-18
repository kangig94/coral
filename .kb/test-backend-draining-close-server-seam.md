# Backend Draining Tests Need a Delayed Close Seam
## Rule
When testing an HTTP server's `draining` state, do not rely on a plain subprocess or an unmodified `server.close()` call to prove that new requests return a draining-specific response. Extract server creation into a controller and inject the close function so tests can delay the actual `server.close()` while lifecycle has already transitioned to `draining`.
## Why
`server.close()` stops accepting new sockets almost immediately, so a black-box test often sees flaky `ECONNREFUSED` failures instead of the intended `503 backend_shutting_down` response. That makes it hard to verify both admission fencing and the ordering constraint that owner files survive until the close boundary is crossed.
## Pattern
```text
WRONG
start server
trigger shutdown
immediately open a new connection
test races between 503 and ECONNREFUSED
```

```text
RIGHT
extract a controller around startup/shutdown
inject closeServer in tests
set lifecycle -> draining
delay the actual close callback
assert authenticated requests get the draining response
assert owner files still exist
release the close barrier
assert cleanup happens afterward
```
