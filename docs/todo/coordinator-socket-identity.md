# TODO — two coordinators can bind over one store

**Status**: open, independent, small. Extracted 2026-08-15 from `store-format-routing.md`, where it sat
at roughly line 196 of a 274-line document about an unplanned feature. It is a real defect and it was
blocked on a refactor nobody has appetite for.

## The defect

`socketPathForRunDir` (`src/infra/path/coordinator.ts:36-43`):

```ts
const candidateSocket = join(runDir, 'coordinator.sock');
const limit = socketPathByteLimit(env.platform);
if (Buffer.byteLength(candidateSocket, 'utf8') < limit) return candidateSocket;

const hash = hashToken(candidateSocket, 8);
return join(env.tempDirectory, `coral-${flavor}-${hash}.sock`);
```

When the natural socket path exceeds the platform's `sun_path` limit, the fallback is built from
`env.tempDirectory` — which is `TMPDIR` when set, and the system temp dir otherwise.

So two processes with **the same state root** but **different `TMPDIR`** compute **different socket
paths**. Each finds its own path unbound, each binds, and both serve. Two coordinators over one journal
and one store.

That directly violates `design-rationale.md` §8.2 — exactly one coordinator per Coral installation —
which every ownership, recovery and handoff guarantee in the system is written on top of.

## The same fallback exists a second time

`providerEndpoint` (`src/infra/path/provider-proxy.ts:126-150`) resolves guardian, proxy and reaper
sockets with the identical shape: try `generationRunDir(...)`, and on a length overflow fall back to
`join(env.tempDirectory, 'coral-<uid>')`. Same ambient variable, same consequence — two processes that
agree on a provider set's identity can disagree on where its socket lives, so an existing set looks
absent and a second one gets spawned.

It is better hardened in two ways worth copying rather than re-deriving: it **refuses** when even the
fallback exceeds the limit (`proxy_endpoint_too_long`) instead of returning an unusable path, and it
asserts the fallback directory is private before returning. What it does not have, and what this item
is about, is independence from `TMPDIR`.

Fix both together. They are one missing invariant, and fixing the coordinator alone would leave the
same class live one directory away — the shape that made this defect worth extracting in the first
place.

## Why it has not been seen more

It needs the long-path branch, which needs a deep state root, and then it needs two invocations with
different `TMPDIR`. Sandboxes, CI containers, and tools that set their own `TMPDIR` are exactly the
places that produce it. The failure is not loud when it happens: both coordinators work, and the damage
is whatever two independent owners do to one journal.

## Reproduced 2026-08-19, and there is a second failure this entry did not describe

Produced by accident while exercising `backend status` against an isolated `HOME`/`TMPDIR` under this
project's own sandbox scratch root. `composeCoralPaths('prod')` returned a socket path of **134 bytes**
against the Linux limit of 108, and `net.Server#listen` on it failed `EINVAL`.

That is not the two-coordinator case. When the *fallback itself* overflows — a long `TMPDIR`, which is
the same condition that makes the fallback get taken at all — there is no second coordinator, because
there is no coordinator: `socketPathForRunDir` returns a path nothing can bind, and the operator gets
`listen EINVAL` naming no limit, no byte count, and no variable to change. The entry above reads as
though the overflow branch always ends in two owners; it can equally end in none.

This half is separable and much cheaper than the identity decision. `providerEndpoint`
(`src/infra/path/provider-proxy.ts:141-146`) already refuses with `proxy_endpoint_too_long`, carrying
`observedBytes`, `limit` and `platform`; the coordinator can raise the same shape without settling where
the fallback should live. Copying it costs nothing that the identity fix would have to undo, and it
turns an undiagnosable startup failure into one that names its own remedy. The existing coverage does
not catch it: `tests/unit/infra/coordinator-paths.test.ts` asserts at 107/108/109 bytes that the
fallback is *taken*, never that what it returns *fits*.

## What has to be decided

The fallback needs an identity derived from the same thing the primary path is derived from. Options:

- **Hash the state root, not the candidate socket path, and place the fallback in a location derived
  from the state root** rather than from ambient environment. The point of the hash is to survive a
  length limit, not to relocate ownership.
- **Refuse rather than relocate.** If the socket cannot live beside its run directory, that is a
  configuration the operator should hear about, not one Coral should paper over with a second
  namespace.

Whichever is chosen, the invariant to state and test is that **the socket path is a function of the
state root alone** — no environment variable may move it, because moving it moves ownership.

## Explicitly out of scope

Store-format routing, the active-store selection protocol, and the handoff escalation path. This item
is only the socket path's dependence on ambient environment.

## Start condition

Write the failing case first: two `socketPathForRunDir` calls with the same deep `runDir` and different
`env.tempDirectory`, asserting they agree. It fails today. Write the overflowing-fallback case beside it
— a `tempDirectory` long enough that the fallback exceeds the limit too — asserting it refuses rather
than returns; that one is independently landable if the identity question stays open. Write the matching case for
`providerEndpoint` in the same commit — same identity, same overflow, different `env.tempDirectory` —
so the invariant is stated once for both callers rather than discovered twice.
