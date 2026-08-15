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

## Why it has not been seen more

It needs the long-path branch, which needs a deep state root, and then it needs two invocations with
different `TMPDIR`. Sandboxes, CI containers, and tools that set their own `TMPDIR` are exactly the
places that produce it. The failure is not loud when it happens: both coordinators work, and the damage
is whatever two independent owners do to one journal.

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
`env.tempDirectory`, asserting they agree. It fails today.
