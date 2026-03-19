# Backend Bind vs Connect Host Separation
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
`CORAL_BACKEND_BIND` (the address passed to `server.listen()`) cannot be propagated verbatim as the client-reachable host. Wildcard bind literals like `0.0.0.0` or `::` are valid listen addresses but invalid advertised endpoints. The backend must persist a separate client-reachable `host` in `backend.json` — either normalized from the bind address via `resolveClientHost()` (wildcards → `127.0.0.1`) or explicitly overridden via `CORAL_BACKEND_ADVERTISE_HOST`.
## Why
Without this separation, all URL constructions in backend-lifecycle, health checks, bridge client, http-client, and reef SSE consumer would use the raw bind literal. Fetching `http://0.0.0.0:port/health` fails on most platforms. The bug manifests as silent connection failures in any consumer that reads `backend.json`.
## Pattern
```typescript
// Wrong: propagate bind address as client host
const host = process.env.CORAL_BACKEND_BIND ?? '127.0.0.1';
writeBackendInfo({ host, port, token }); // 0.0.0.0 breaks all consumers

// Right: normalize wildcards, allow explicit override
function resolveClientHost(bind: string): string {
  if (bind === '0.0.0.0' || bind === '::' || bind === '') return '127.0.0.1';
  return bind;
}
const advertise = process.env.CORAL_BACKEND_ADVERTISE_HOST;
const host = advertise ?? resolveClientHost(bindHost);
writeBackendInfo({ host, port, token });
```
