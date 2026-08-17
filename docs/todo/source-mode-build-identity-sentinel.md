# TODO — every source-mode run claims the same build identity

**Status**: open. Found on `refactor/process-incarnation-token` while removing the opaque-capsule path, whose
only reachable population turned out to be this sentinel. The consequence was removed; the cause was not.

## What exists now

```
src/coordinator/composition/world.ts
  const buildSetId = strictBuild.ok
    ? strictBuild.manifest.buildSetId
    : (bootSnapshot.buildSetId ?? '00000000-0000-4000-8000-000000000000');
```

A released build mints `buildSetId` once per artifact — `randomUUID()` in `scripts/build-server.mjs`, injected
as `__BUILD_SET_ID__` — so two builds never collide. Running from TypeScript source, `__BUILD_SET_ID__` is
undefined, `resolveStrictBundleIdentity()` answers `embedded_identity_unavailable`, and the fallback applies.

Note which branch this is: every *other* not-ok reason throws a few lines above. The sentinel is reached only
by the source-mode case, and in that case **every source tree on the machine claims to be the same build.**

## Why that is worse than having no identity

`buildSetId` is not a label. It is the authorization for one build to take over another's live processes:

- `assertNamedCoordinatorBuild` at the provider roles decides whether a `handoff.redeem` is answered or
  refused with `identity_mismatch`.
- `classifyProviderProxySetInheritance` (`src/coordinator/services/provider-proxy-set/inheritance.ts`) decides
  whether a discovered capsule may be dialed at all, and refusing is not tidiness — dialing a foreign set is
  boot-fatal.

Under the sentinel both answer "same build" for two source trees that share nothing. The gate does not fail;
it returns the wrong answer confidently, which is the shape that gets trusted.

This is not hypothetical. It is exactly how `capsule-opaque` was reachable: a source-mode coordinator meeting
another source tree's capsule, waved through as its own. Deleting that path removed the one consequence anyone
had found. The sentinel will make the next build-gated decision wrong in the same way, and there is no reason
to expect it to be noticed sooner.

## The shape of the fix

**Mint a fresh UUID per boot when there is no embedded identity.** A source-mode run genuinely has no build
identity; claiming a unique one is honest, and it makes every cross-build gate answer "different build" —
which is the correct answer for two source trees, and the safe one for a tree meeting its own earlier run.

What that costs, and it is the whole reason this is not folded into the change that found it: any test that
constructs a real world and expects a stable `buildSetId` breaks, and the fixtures that pass an explicit
`bootSnapshot.buildSetId` keep working only because that branch is checked first. Inventory those before
starting — the `??` chain means a supplied snapshot value still wins, so the blast radius is narrower than it
looks, but it has to be measured rather than assumed.

**Do not** solve this by making source mode throw. Running from source is how the suite and every local
iteration works; refusing to start would trade a wrong answer for no answer at all.

## Explicitly out of scope

The embedded-identity mechanism itself (`__BUILD_SET_ID__`, `resolveStrictBundleIdentity`, the adjacent
manifest check). Those work; this entry is only about what happens when they legitimately report nothing.

## Start condition

None, beyond the inventory above. The test that pins it: construct two worlds in source mode and assert their
`buildSetId` values differ — which fails today, and is one line.
