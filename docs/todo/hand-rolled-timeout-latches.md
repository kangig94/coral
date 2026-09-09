# TODO — three files race a promise against a timer by hand, and one of them is shared

**Status**: open, one shape at three sites, no defect behind it. Found by a tier-3 review on
`fix/preflight-cannot-defer` and left out of that branch because none of the three is wrong — they are
harder to read than they need to be, and one of them had just been stabilised over five rounds of review,
which is the worst moment to restructure it.

## The shape

Each site declares a `settled` boolean, arms a timer, attaches handlers to a promise, and has every path
check and set the latch before resolving or rejecting:

- `runPreflightWithTimeout` (`src/coordinator/services/execution-policies.ts`) — returns a classified
  decision or a deadline decision.
- `withDiscussLaunchTimeout` (`src/discuss/shell/runtime-build.ts`) — returns a launch decision or an
  undetermined one.
- `raceTimeout` (`src/infra/async.ts`) — returns a boolean, and has three consumers that inherit the
  control flow.

`Promise.race` against a deadline promise, with the timer cleared in `finally`, expresses all three
directly. The latch exists because each site settles from two callbacks instead of racing two promises.

## Why it is worth doing, and why not here

The latch is where this pattern goes wrong, and it already did once: `runPreflightWithTimeout` closed its
latch and cancelled its timer *before* the work that could throw, so a throw left the promise neither
resolved nor rejected and the awaiting launch never returned. That is fixed, and the fix added a comment
saying no path may cancel the timer without settling — a constraint a `Promise.race` would make
structural instead of asserted.

Against doing it in that branch: the preflight path took five review rounds to stabilise, its behaviour is
now covered (deadline arbitration, re-ask budget, faulted classification, timer cleanup), and a rewrite
buys readability at the cost of re-opening the one function whose settlement semantics were hardest to get
right. `raceTimeout` was not touched by that branch at all.

## A second member, same review, different shape

`checkSupportedClaudeSettings` (`src/providers/claude/provider-facets.ts`) enumerates candidate paths,
reads each, decides read-error precedence, parses JSON, and validates credential policy in one loop with
one result variable. The rule that matters — continue past an unobserved read so a later established
refusal still wins — lives in a `readFailure ??=` and an easy-looking early `return` breaks it. Splitting
the read from the validation would put that precedence in the open. Same reasoning for deferral: it is
correct and covered, and the branch that touched it was fixing a different defect.

## Start condition

Independent of everything else, and independent of each other. Do the three timeout sites together — the
point is that one shape stops being written three ways — and confirm each site's existing tests still
describe the behaviour rather than the mechanism before changing it.
