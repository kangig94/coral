# TODO — the fallback directory's privacy is checked by a process that does not bind

**Status**: open, separable, and split out rather than deferred. Found by a pioneer pass while closing
`coordinator-socket-identity`, which removed the ambient input both socket resolvers took and moved their
overflow fallback under a fixed per-uid directory. That change makes the privacy question answerable; it
does not answer it.

## What exists

`providerEndpoint` (`src/infra/path/provider-proxy.ts`) calls `ensurePrivateFallbackDirectory` before
returning: it creates `socketFallbackDir(uid)` with mode `0700`, then `lstat`s and `stat`s it and refuses
with `proxy_endpoint_insecure` unless it is a non-symlink directory owned by that uid at exactly `0700`.

Two things follow from where that runs.

**It is advisory, not enforcing.** The check happens in the coordinator, inside a function that returns a
`string`. The bind happens later, in a guardian the coordinator spawns (`resolveBackendArtifact` in
`src/provider-proxy/role-spawn.ts`). Check-then-use with a process boundary in between is a guarantee that
has already expired at the moment it is needed.

**It is invisible at its call site.** `createCapsules` (`src/coordinator/live/provider-proxy/acquisition-steps.ts`)
computes the guardian, reaper and proxy endpoints on three consecutive lines that read as pure path
composition. Two of them `mkdir` and `stat` the filesystem. `infra/path/` is the layer whose name promises
it does neither, and `ProviderProxyEndpointEnvironment` carries a `storage` port for no other reason.

The coordinator's own socket has no such check at all. `bindSocket` (`src/transport/ipc/server.ts`)
`mkdir`s the parent, binds, then `chmod`s the socket to `0600` — best-effort, after the bind, with the
failure swallowed.

## Why it matters more than it did

While the fallback root came from `TMPDIR`, macOS supplied a per-user `0700` directory and the check was
largely confirming what launchd had already arranged. Under a fixed root the directory is created by
whoever gets there first, and the socket it holds is the singleton lock: `design-rationale.md` §8.2 makes
exclusive ownership of the canonical IPC socket the thing every ownership, recovery and handoff guarantee
rests on.

The per-uid subdirectory that `coordinator-socket-identity` introduced is what makes the bad cases hard to
reach — a stranger cannot create entries in a directory they do not own. That is the mitigation. It is not
the same as asserting the property at the point of use.

## Required shape

The assertion belongs at the binder, which already `mkdir`s the parent and already `chmod`s the result, and
which runs in the process that will hold the socket. Moving it there:

- returns `infra/path/` to pure path composition, and lets `storage` leave
  `ProviderProxyEndpointEnvironment` entirely;
- gives the coordinator socket the same guarantee the provider sockets have, which it does not have today;
- turns a check whose result is stale by the time it is used into one that is not.

`proxy_endpoint_insecure` needs a new home when that happens, and the binder gains a failure mode on the
startup path that it does not have today — which is the substance of this entry, not a detail of it.

## Also here, and independently landable

`ensurePrivateFallbackDirectory` opens by rejecting a uid that is not a non-negative safe integer, and
reports it as `proxy_endpoint_insecure` — a claim about filesystem ownership that has not been checked yet
and may well be false. An operator reading it goes and looks at directory permissions. A malformed uid is
an ingress-validation failure; `design-rationale.md` §11 asks for canonical values at boundaries. The uid
enters at `acquisition-steps.ts` as `process.getuid?.() ?? 0` and travels as a bare `number`.

## Explicitly out of scope

The fallback address itself, the byte-limit bound, and the identity invariant — all settled by
`coordinator-socket-identity` and asserted in `tests/invariants/socket-fallback-fits-af-unix.test.ts`.

## Start condition

None blocking. The work is a move plus one new refusal on the startup path, and the entry price is deciding
what that refusal does to a coordinator that cannot secure its own socket directory: refusing to start is a
hold, and `design-rationale.md` §11 asks what ends it.
