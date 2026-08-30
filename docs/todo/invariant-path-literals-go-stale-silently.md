# TODO — path-literal equality guards fail open after a move

**Status**: open, reproduced. The failure mode is established; the repository-wide repair is not chosen.

## What failed

On 2026-08-30, the routing-status store was promoted from the historical file named by
`'src/store/handoff-routing-status-store.ts'` to the directory component
`src/store/handoff-routing-status-store/`. The layering invariant's
`forbiddenTargets` (`tests/invariants/architecture-layering.test.ts`) still contained the old string and
compared it with import edges by `Set.has(target)` equality. No import edge could equal the old string after
the move, so that member matched nothing while the invariant continued to pass.

The rule that stopped being enforced was that
`discardHandoffRoutingStatus` (`src/cli/routing-status-discard.ts`) must not import the routing-status store.
Nothing reported the loss. A manual review found it, and an injected import confirmed it: the invariant
passed with the stale literal and failed after the guard was repaired to use the component prefix named by
`HANDOFF_ROUTING_STATUS_STORE_ROOT` (`tests/invariants/architecture-layering.test.ts`).

## Why this is a class

Any invariant that admits a target by equality with a path literal can lose its subject when that path moves.
The guarded code can then violate the intended rule while the test stays green, because matching nothing is
indistinguishable from finding no violation. A literal passed to `readFileSync` has the opposite failure
shape: moving the named file makes the read throw, so that form fails loudly.

Measured on 2026-08-31, a scan of `tests/invariants/**/*.test.ts` found 38 files containing at least one
single-quoted literal shaped like `'src/<directory>/<file>.ts'`. The largest membership-matched collections
observed in that scan were in `tests/invariants/architecture-boundary.test.ts`,
`tests/invariants/coordinator-topology.test.ts`, and `tests/invariants/architecture-layering.test.ts`. The
scan counted files and literal shape; it did not classify every use. It therefore does not establish that all
38 files are vulnerable: some literals are read, asserted to exist, or used as fixtures rather than matched
against live paths by equality.

## What is not decided

Three repairs remain plausible:

- A shared assertion that every live path literal named by an invariant resolves to an existing file would
  make a moved file fail loudly, but it needs a way to exclude intentional fixture and proposed paths.
- Per-invariant prefix matching can express a component boundary accurately, as the repaired layering rule
  does, but each invariant must choose and maintain that semantic boundary itself.
- Generating targets from the module graph removes handwritten file identities, but couples the guard to the
  graph and still requires the invariant to state which component the generated set represents.

A path-existence assertion is necessary for some equality lists and insufficient as a general answer. It
catches a path that disappeared after a move; it does not catch a path that still exists while the rule's
real subject moved somewhere else. No option is selected by this entry.

## Explicitly out of scope

`docs/todo/invariant-scans-stop-at-src.md` records an invariant whose scan scope ends at `src/` instead of
covering `clients/hooks/`. This entry concerns a literal inside an already-running scan losing its subject.
Changing the roots of either scan cannot repair the other's failure, so the two entries do not overlap.

## Start condition

Startable now. The silent pass and the rejecting repair have both been reproduced. Before choosing a shared
mechanism, classify the equality-matched literals separately from reads, fixtures, and explicit existence
checks; that inventory is what can decide whether one assertion fits the class or the fixes must remain local.
