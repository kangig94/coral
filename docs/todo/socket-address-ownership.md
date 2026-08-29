# TODO — who may own the address the singleton lock lives at

**Status**: the startup exclusion gap for a published v0.10.9 address is closed. Binder-local enforcement,
ACL evidence, and a legacy custom address that remains unpublished across the startup observation window
remain open. Relocated addresses now live under
`socketFallbackDir(stateRoot)` — `/tmp/coral-<state-root-hash>/`. The directory
therefore names the installation rather than the caller, while the bind boundary separately requires the
calling uid to own it with mode `0700`. A second uid over one state root reaches the same directory and
refuses if it cannot own it; it cannot derive a second coordinator lock.

Three parts. All are about ownership of the address.

**Corrected 2026-08-27: length is not settled, and overflow is silent.** The sentence that stood here said
none of this was about length. Moving the test suites' `TMPDIR` from `/tmp` to a memory-backed root spent
four of the margin's bytes on the root name and a per-user suffix spent the rest, which pushed
`provider-<24 hex>.sock` from 104 to 109 bytes against the 108-byte Linux limit. `providerEndpoint`
(`src/infra/path/provider-proxy.ts`) then did exactly what Part 2 historically described — relocated the
address — and reported nothing. The suite that binds those sockets counts them beneath the
HOME it created, found none, and failed ten seconds later as a wait that never settled; the cause took hours
to reach and every gate but that one stayed green.

So length and ownership are the same subject, not neighbouring ones: the overflow is what moves the address
into the shared root this entry is about, and nothing on either side says it happened. Part 2 closed the
uid-dependent identity defect. What remains is that **no reader learns the address moved** — not the
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

## Part 2 — closed: the installation owns the namespace

The fallback namespace is a hash of the generation state root. Coordinator and provider endpoint paths use
that same owner, and the operator store-reset resolver receives no uid-shaped path input. Caller identity is
still checked at the bind boundary: the first caller that can securely create the directory owns it, while a
different uid reaches the same address and receives the existing `foreign` refusal. This supplies the
three-answer disposition without adding uid to installation identity.

## Shipped-selector compatibility — published addresses participate in exclusion

The path owner computes v0.10.9 guards from the raw configured temp value and the runtime's system temp
directory, admits only non-empty absolute directories, and deduplicates the result. It decides whether the
tagged build relocated with v0.10.9's own 104-byte Darwin/108-byte non-Darwin rule rather than this build's
more conservative limit. Binding is atomic with the current address: an incumbent at any guarded address
prevents this coordinator from starting, and shutdown closes every listener.

An empty, whitespace-only, or relative configured value is not an empty guard set. If the tagged ordinary
socket would overflow, v0.10.9 joined that value into a relative address resolved from its working directory;
this process cannot enumerate that address. Startup therefore refuses and names the unenumerable selector.
The operator can unset `TMPDIR` or set it to a non-empty absolute directory and retry; Coral will not claim
that no shipped address exists.

The finite selector is no longer the only evidence. Before binding, startup reads the discovery record in this
state root with `readDiscoveryRecordDisposition`. A decoded absolute record's `socketPath` joins the compatibility
bind set only when v0.10.9's derivation reproduces its exact Coral-owned socket name from that parent. The bind
boundary does not create the published parent, inspects the existing entry with non-following `lstat`, requires a
socket, and repeats that inspection before stale cleanup may unlink it. A live v0.10.9 coordinator launched with
an absolute selector has therefore published the exact address that excludes a contender, including an address
selected from its launcher's custom absolute `TMPDIR`, without granting a durable record authority over an arbitrary
pathname. An unreadable or undecodable record, a decoded relative socket string, or a path outside Coral's
coordinator namespace stops startup with the documented unreadable-record refusal. A missing or non-socket
published-only entry stops at the bind boundary. Only `missing` means there is no published address to add.

The ordering is read, bind the current address plus every derived and published address, then read again before
accepting bind authority. If the second read names an address outside the attempted set, startup closes every
listener it just acquired and repeats the atomic bind with that address included. A live listener then produces
the binder's addressed-incumbent disposition and enters the existing handoff against that exact socket; a stale
record whose address can be bound does not counterfeit handoff provenance. This excludes the race in which
v0.10.9 selects an otherwise unenumerable socket after the first read, binds it, and publishes its record before
the contender's post-bind read: the contender cannot keep its own listeners while probing or handing off the
newly published incumbent.

What remains is the interval in which no usable record exists at either read. If v0.10.9 uses the ordinary run
socket, an empty derived guard set is safe because both builds still contend for the same primary address. If it
uses one of the derived fallback guards, that address is bound atomically too. Coexistence is still possible only
when v0.10.9 binds an unenumerated custom fallback and does not publish it until after this build's post-bind read
— including a rollback launched later while this coordinator is already running. Closing that last interval
would require a continuously enforced operating-system primitive both builds already acquire; the discovery
record narrows the gap but cannot retrofit such a primitive into v0.10.9.

The same pre-publication interval is also outside operator shutdown discovery. `backend shutdown` reads the
record and, when it is missing, checks only this build's current coordinator socket. A live v0.10.9 coordinator
bound at an unenumerated custom fallback has neither observable artifact, so the command returns `no_record`,
prints that no discovery record was found, and exits `75` without sending a shutdown request. If a stale record
from an earlier coordinator remains and its pid is observed absent, the same interval returns
`recorded_process_absent`: the named pid is gone, but the unpublished coordinator is still not excluded. Both
messages state that limit, and neither exit authorizes an operator to proceed as if shutdown succeeded.

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
that. Part 1 and the installation-keyed bind refusal both rest on this assertion, so whatever it cannot
establish, they cannot either.

## Explicitly out of scope

The current-build fallback address and byte bound are settled. Unit coverage changes the calling uid over
one state root and requires the relocated coordinator and provider addresses to remain unchanged. A published
custom legacy address is now covered; only an unenumerated address that remains unpublished across the startup
observation window is outside the compatibility guarantee described above.

## Start condition

None blocking for part 1, though its diagnostic channel is most of its cost. Part 3 wants its observation boundary chosen first, and is worth doing only
alongside a macOS fixture that can demonstrate the gap.
