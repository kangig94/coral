# TODO — enforce provider socket ownership at bind and finish legacy address exclusion

**Status**: partly implemented. Current-build fallback paths share one installation namespace; binder-local enforcement, macOS ACL evidence, and one legacy pre-publication interval remain.

`providerEndpoint` in `src/infra/path/provider-proxy.ts` derives an overflow address from the state root and calls `ensurePrivateFallbackDirectory` before returning it. `bindSocket` in `src/transport/ipc/server.ts` calls `ensurePrivateSocketDir` in the coordinator process that binds. The provider roles bind later through `createControlEndpoint.listen` in `src/provider-proxy/control-endpoint.ts`, which calls `created.listen(socketPath)` without repeating that parent check. The check made by the coordinator can expire before a role binds. Put the shared assertion at each role binder and carry its refusal to the coordinator through a structured startup diagnostic.

`ensurePrivateSocketDir` in `src/infra/private-socket-directory.ts` verifies owner, type, mode, and the parent replacement premise using filesystem metadata. Node's `fs.Stats` does not expose macOS ACL grants. Choose an ACL-capable observation boundary and prove the refusal mapping with a macOS fixture before claiming effective privacy from a `0700` mode.

The current startup guard derives published v0.10.9 addresses and checks the discovery record before and after binding. It excludes a published custom absolute fallback address. A v0.10.9 coordinator can still bind an arbitrary custom fallback after this build's final read and publish later; those builds share no continuously enforced primitive that would close that interval. Decide whether that retained-build limitation needs an external owner. Do not treat a missing record as proof that no legacy listener exists.

Path overflow may silently relocate a provider socket. `providerEndpoint` returns only a string, so neither its binder nor status receives a relocation fact. Decide whether the returned address or diagnostic should name the fallback selection.

## Start condition

The role-binder check and its startup diagnostic can start now. ACL enforcement needs an observation port and macOS test. The legacy pre-publication interval needs an authority both builds actually share; another finite address list cannot cover arbitrary future `TMPDIR` values.
