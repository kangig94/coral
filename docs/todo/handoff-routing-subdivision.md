# TODO — promote the cohesive cross-build handoff routing component

**Status**: open, deliberately deferred from `fix/pr1-3-audit`. This branch crossed the documented
subdivision threshold; it does not also move the files whose new shape must be decided separately.

## What is not being done

The cohesive cross-build routing component remains in four flat coordinator files:

- `src/coordinator/handoff-runner.ts`;
- `src/coordinator/handoff-routing.ts`;
- `src/coordinator/handoff-routing-status.ts`;
- `src/coordinator/handoff-routing-status-operator.ts`.

The deferred change is to promote that component to `src/coordinator/handoff-routing/` and strip the
prefix that the directory would make redundant. No file or import path moves on this branch.

## Why the trigger is met now

[`design-philosophy.md`](../../.claude/rules/design-philosophy.md) §7 says to "promote an implicit prefix
cluster to a subdirectory when ≥4 sibling files share a prefix AND form a cohesive component (each file owns
a distinct facet of the same bounded responsibility)." The runner, routing policy, persisted routing status,
and offline status operator are four distinct facets of the same cross-build routing responsibility.

Before this branch, that cohesive group had three files, which §7 calls borderline. This branch added
`handoff-routing-status-operator.ts`, so the component crossed the threshold here rather than having sat above
it unnoticed for a long time.

The other two `handoff*` siblings do not make the six files one component:

- `handoff.ts` is the daemon-side bind/escalation state machine, a different meaning of “handoff” from
  cross-build routing;
- the present boundary leaves `handoff-repair-operation.ts` outside because it is the argument grammar shared
  with command registration rather than a distinct routing lifecycle facet.

## The argument for keeping the flat layout

At its strongest, the current layout avoids a misleading intermediate shape: a `handoff-routing/` directory
standing beside `handoff.ts` and `handoff-repair-operation.ts` could read as though those two prefixed files
were also members of the directory's component.

## Why this is deferred rather than settled

A directory is also the mechanism that makes membership explicit. On that reading, leaving the two
non-members outside `handoff-routing/` is clearer than leaving all six beside one another under the same
prefix.

The boundary is less settled than the flat-layout argument assumes. `handoff-repair-operation.ts` is no
longer purely an argument grammar: it owns the exhaustive classification of routing-status operator
invocations, and that classification decides whether a command receives a routing lifecycle at all. That
moves the file closer to the component, not further away. Whoever picks this up must first settle whether
that classification belongs with the routing component or with the shared command grammar; that decision
determines which files move and what the directory contains.

The same design-philosophy record's review lesson applies directly: expect a kept exception's argument to be
wrong, and check it against the tree rather than against the last reviewer. The flat layout is therefore a
temporary disposition, not an exception granted by the subdivision rule.

## Cost of waiting

Deferral is not free. Every further `handoff-*` file added before the boundary is settled makes the eventual
move larger and makes the flat layout look more like a decision than a deferral.

## Start condition

Begin after `fix/pr1-3-audit` lands, on a branch dedicated to the move. First settle the
`handoff-repair-operation.ts` boundary against the then-current import and call graph; do not choose the move
list before that decision. No external prerequisite remains once no other handoff-routing work is in flight.
