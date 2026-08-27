# TODO — who may own the address the singleton lock lives at

**Status**: open, and narrowed by the fix that produced it. The socket-identity work removed the ambient
input both resolvers took and moved the overflow fallback under `socketFallbackDir(uid)` —
`/tmp/coral-<uid>/`. That root is shared with every user on the host, which turns a question that
`TMPDIR` used to answer by accident into one the tree has to answer on purpose: **who is allowed to own
the directory the singleton socket sits in, and who checks.**

Three parts. All are about ownership of the address.

**Corrected 2026-08-27: length is not settled, and overflow is silent.** The sentence that stood here said
none of this was about length. Moving the test suites' `TMPDIR` from `/tmp` to a memory-backed root spent
four of the margin's bytes on the root name and a per-user suffix spent the rest, which pushed
`provider-<24 hex>.sock` from 104 to 109 bytes against the 108-byte Linux limit. `providerEndpoint`
(`src/infra/path/provider-proxy.ts`) then did exactly what Part 2 describes — relocated the address under
`socketFallbackDir(uid)` — and reported nothing. The suite that binds those sockets counts them beneath the
HOME it created, found none, and failed ten seconds later as a wait that never settled; the cause took hours
to reach and every gate but that one stayed green.

So length and ownership are the same subject, not neighbouring ones: the overflow is what moves the address
into the shared root this entry is about, and nothing on either side says it happened. Part 2 already knows
the relocation is uid-dependent. What it did not say is that **no reader learns the address moved** — not the
binder, not the process that computed the path, not an operator. `tests/invariants/temp-root-socket-budget.test.ts`
now pins the margin for the suites that bind provider sockets, which keeps the test tree from crossing it
again but does nothing for a production path that crosses it. A fix for this entry should decide whether
relocation is allowed to be silent at all.

## Part 1 — the assertion holds at one binder out of four

`ensurePrivateSocketDir` (`src/infra/private-socket-directory.ts`) creates the directory `0700`, tightens
one that is already its own, and otherwise throws a refusal carrying one of `foreign`, `unusable`,
`unsecurable`, or `unverified`, which the coordinator's binder turns into two documented codes so that the
one that observed nothing does not exit as an ownership verdict. Ownership and type come from a non-following `lstat`, because
a following `stat` describes whatever the entry currently resolves to rather than the entry itself.

`bindSocket` (`src/transport/ipc/server.ts`) calls it before binding, in the process that will hold the
socket. That is the coordinator, and it is enforcing. The premise the whole assertion rests on — that no
other user can replace the entry once it is ours — is checked rather than assumed: the parent must belong
to this uid or to root, **and** it must either be writable by neither group nor other users or carry the
restricted-deletion bit.

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
back to its parent. The endpoint's two codes move with the check, and each role binder gains a refusal
on its startup path that it does not have today — refusing to start is a hold, and
`.claude/rules/design-philosophy.md` principle 11 asks what ends it. It also has one disposition where the
coordinator now has three, so the split the coordinator side just made has to reach it.

## Part 2 — the uid participates in installation identity, and nothing says so

When — and only when — the socket beside the run directory overflows `sun_path`, the address relocates and
becomes a function of the uid as well, because the shared root demands a per-user namespace.
`coordinatorPaths` reads the uid for that, and the operator store-reset resolver reads it a second time,
independently.

So two processes over one state root with different uids compute different locks for a relocated socket,
and both can coordinate one journal. A `sudo -E` invocation that preserves `HOME` reaches it. This is not
new — an ambient temp directory produced the same divergence, and usually did — but the fix did not close
it, and nothing in the tree states the boundary.

The tree also does not say *which* uid. The path constructors take an injected `env.uid` and are neutral
about it; every production caller that supplies one — `coordinatorPaths`, the provider acquisition step, and
the operator store-reset resolver — reads `process.getuid()`, the real uid. The binder no longer reads it at
all: `prepareSocketParent` recovers the uid the address itself names, so the check cannot answer against a
different value than the one the path was built from. The directory those paths then create is owned by the
effective uid, and the mode check compares against the real one, so
under a setuid invocation Coral would refuse a directory it had just created itself. Real versus effective
is part of this decision, not a separate one.

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

## Part 3 — the assertion proves owner and mode, which is less than privacy

`ensurePrivateSocketDir` observes the entry with a non-following `lstat`, requires an owner a `uid_t` can
represent, the expected uid, the directory file type, and mode `0700` across all twelve bits, reads that
mode back after `chmod`, and separately requires a parent that is a directory, is owned by this uid or
root, and either denies group and other write or carries the restricted-deletion bit. Those are the owner,
type, and BSD mode facts Node's `fs.Stats` exposes. They are what it proves.

macOS ACLs grant a named user or group rights beyond the BSD mode bits — Apple documents them as a more
detailed policy than BSD permissions in [File System Details](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemDetails/FileSystemDetails.html)
— and Node's [`fs.Stats`](https://nodejs.org/api/fs.html#class-fsstats) surface carries no ACL entries. A
successful observation showing this uid and `0700` therefore does not show that no other principal has
effective access. The reachable case is a relocated directory carrying an inherited or explicitly added
allow ACL: owner and mode still satisfy the check, and if that ACL grants search, write, or delete rights,
that principal can reach or replace entries in the namespace.

Nothing in the injected storage boundary returns ACL state, so this is not a gap the module can close by
being more careful. A fix needs an ACL-capable port over an OS API or a strictly parsed system tool,
applied to the directory and to the parent premise, distinguishing no allow ACL from an ACL it could not
read, verifying after any tightening, preserving the existing refusal dispositions, and exercised by a
macOS fixture that demonstrates another principal's effective access through a `0700` directory. Choose the
observation boundary and the refusal mapping before writing any of it.

Until then the module says owner-and-mode rather than private, and callers may not read more into it than
that. Parts 1 and 2 both rest on this assertion, so whatever it cannot establish, they cannot either.

## Explicitly out of scope

The fallback address itself, the byte bound, and the removal of the ambient input — settled, with the
bound asserted in `tests/invariants/socket-fallback-fits-af-unix.test.ts` by measuring what the resolvers
return. That test covers length only; the identity property is enforced by the absent parameter, not by
a test.

## Start condition

None blocking for part 1, though its diagnostic channel is most of its cost. Part 2 wants the
installation-identity decision first, because the two options put the refusal in different places and only
one of them adds a hold. Part 3 wants its observation boundary chosen first, and is worth doing only
alongside a macOS fixture that can demonstrate the gap.
