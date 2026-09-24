# Provider sockets remain after their listeners exit

**Status**: open. A run-directory census found 21 `provider-*.sock` entries with no listener in `ss -xl`, spread across seven days. That observation does not identify the failed cleanup path.

`clearStaleSocket` in `src/transport/ipc/server.ts` reclaims the coordinator socket before binding after an `ECONNREFUSED` observation. The provider roles bind through `createControlEndpoint` in `src/provider-proxy/control-endpoint.ts`; no equivalent provider-socket sweep has been established. Determine whether role shutdown, coordinator recovery, or another owner should reclaim a provider socket whose listener is gone, including when the coordinator that launched the role has exited. A sweep must distinguish a stale pathname from a live listener before unlinking it.

The binder ownership and relocation issues in [`socket-address-ownership.md`](./socket-address-ownership.md) concern the same provider endpoint path, but do not themselves establish stale-socket cleanup. Coordinate the design there; keep this cleanup obligation distinct.

## Start condition

Attribute the residue to a lifecycle path and choose the party that can verify listener absence after a coordinator crash.
