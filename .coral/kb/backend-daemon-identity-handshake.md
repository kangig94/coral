# Backend Daemon: Verify Identity, Not Just Liveness

## Rule
When a short-lived stdio server becomes a long-lived backend daemon, `health == 200` is not sufficient proof that the proxy is talking to the correct process. The daemon must publish verifiable identity metadata, at minimum a random auth token, build version, and instance id, and the proxy must check that identity on every ensure/health path before reusing the daemon.

## Why
Without an identity handshake, a stale info file can point at a reused localhost port, a newly updated proxy can keep talking to an older daemon build, and the new localhost HTTP surface becomes callable by any local process that can guess the port. Liveness alone only proves "something answered"; it does not prove "the right Coral backend answered."

## Pattern
```text
WRONG
backend.json -> { pid, port }
GET /health -> 200
proxy assumes backend is correct
```

```text
RIGHT
backend.json -> { pid, port, token, version, instanceId }
GET /health with X-Coral-Backend-Token
response -> { status: "ok", version, instanceId, ... }
proxy reuses backend only when auth + version + identity all match
```
