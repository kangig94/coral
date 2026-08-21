# TODO — who may own the address the singleton lock lives at

**Status**: open, and narrowed by the fix that produced it. The socket-identity work removed the ambient
input both resolvers took and moved the overflow fallback under `socketFallbackDir(uid)` —
`/tmp/coral-<uid>/`. That root is shared with every user on the host, which turns a question that
`TMPDIR` used to answer by accident into one the tree has to answer on purpose: **who is allowed to own
the directory the singleton socket sits in, and who checks.**

Two halves. Both are about ownership of the address; neither is about its length, which is settled.

## Half 1 — the assertion holds at one binder out of four

`ensurePrivateSocketDir` (`src/infra/private-socket-directory.ts`) creates the directory `0700`, tightens
one that is already its own, and refuses one it observes as someone else's or cannot observe at all.
Ownership and type come from a non-following `lstat`, because a following `stat` describes whatever the
entry currently resolves to rather than the entry itself.

`bindSocket` (`src/transport/ipc/server.ts`) calls it before binding, in the process that will hold the
socket. That is the coordinator, and it is enforcing.

The provider roles are not. `providerEndpoint` (`src/infra/path/provider-proxy.ts`) calls the same
assertion, but it runs in the **coordinator**, inside a function that returns a `string`, while the
guardian, reaper and proxy each bind later in their own spawned process through
`createControlEndpoint`'s `created.listen(socketPath)` (`src/provider-proxy/control-endpoint.ts`), which
neither creates the parent nor checks it. Check-then-use with a process boundary in between has already
expired at the moment it is needed, and three binders inherit a guarantee none of them makes.

This is also why removing the filesystem effects from `providerEndpoint` cannot be done surgically: the
role binders would then have no parent at all on a relocated path. The shape wanted is the shared
assertion called at each binder — noting that the provider listener deliberately does not clear a stale
socket the way `bindSocket` does, so routing provider sockets through `bindSocket` wholesale is not it.

Moving the check also has to move its report, and today there is nowhere for it to land. A role's startup
throw is collapsed to a numeric exit status by `runProviderRoleMain`'s caller in
`src/coordinator/bootstrap.ts`, and `spawnRoleProcess` (`src/provider-proxy/role-spawn.ts`) drains the
child's stderr into a no-op listener. A refusal raised in a role binder therefore reaches the coordinator
as an opaque connect failure unless this work also gives the role a structured startup-diagnostic channel
back to its parent. `proxy_endpoint_insecure` moves with the check, and each role binder gains a refusal
on its startup path that it does not have today — refusing to start is a hold, and
`.claude/rules/design-philosophy.md` principle 11 asks what ends it.

## Half 2 — the uid participates in installation identity, and nothing says so

When — and only when — the socket beside the run directory overflows `sun_path`, the address relocates and
becomes a function of the uid as well, because the shared root demands a per-user namespace.
`coordinatorPaths` reads the uid for that, and the operator store-reset resolver reads it a second time,
independently.

So two processes over one state root with different uids compute different locks for a relocated socket,
and both can coordinate one journal. A `sudo -E` invocation that preserves `HOME` reaches it. This is not
new — an ambient temp directory produced the same divergence, and usually did — but the fix did not close
it, and nothing in the tree states the boundary.

The tree also does not say *which* uid. Every producer calls `process.getuid()`, the real uid, while the
directory those producers create is owned by the effective uid and the mode check compares against the
real one; under a setuid invocation Coral would refuse a directory it had just created itself. Real
versus effective is part of this decision, not a separate one.

`docs/design-rationale.md` §8.2 says exactly one coordinator per Coral installation, and
`docs/todo/store-format-routing.md` states a store authority of canonical state root plus flavor. Neither
says whether the uid augments that identity. Either:

- define an installation as `(state root, flavor, uid)` and refuse a state root whose owner is not that
  uid, which makes the divergence impossible rather than undetected; or
- derive the fallback namespace from the state root's owner rather than the caller's uid, which makes one
  state root resolve to one lock for every caller that can reach it.

The first is a refusal on a startup path and owes principle 11 an answer about what ends it. The second
keeps today's behaviour for the ordinary case and needs a `stat` of the state root at composition time,
which that layer does not do today.

## Explicitly out of scope

The fallback address itself, the byte bound, and the removal of the ambient input — settled, with the
bound asserted in `tests/invariants/socket-fallback-fits-af-unix.test.ts` by measuring what the resolvers
return. That test covers length only; the identity property is enforced by the absent parameter, not by
a test.

## Start condition

None blocking for half 1, though its diagnostic channel is most of its cost. Half 2 wants the
installation-identity decision first, because the two options put the refusal in different places and only
one of them adds a hold.
