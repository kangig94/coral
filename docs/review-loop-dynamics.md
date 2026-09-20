# Review Loop Dynamics

Why a review loop stops converging, how to recognise it from inside the loop, and what
actually ends a defect class. Derived from a 90-round tier-1 loop on one branch
(`fix/a-drain-ends-without-an-operator`), where every round ran two independent reviewers
against a green gate and every finding below was reproduced by measurement.

This document is about the *shape* of findings, not their content. It is meant to be
liftable into a review skill: the tells, the three responses, and the stopping signal are
stated so they can be turned into prompt clauses.

## The observation

For six consecutive rounds, each round's blocking findings were the **mirror image** of the
previous round's fix. In every case the delegate did exactly what the brief asked.

| The brief said | What was built | The measured defect |
| --- | --- | --- |
| Unknown age must not authorize a deletion | Unstatable records skipped entirely | Directory grows to disk capacity while the disposition reports `complete` |
| Stop the log carrying a filename as prose | The canonical errno dropped with it | `EACCES`, `ENOSPC`, `EROFS` indistinguishable, while the CLI still says to fix the reported cause |
| Give the released set an automatic disposition | The remediation wording, no owner | A promise with no producer — worse than the operator solicitation it replaced, because it hid the only existing successor |
| Add a lease so a failed proof collection cannot strand the set | Handback marked settled before releasing the fence | A throw while rearming strands the set exactly as before |
| Delete the directory pagination | One bounded observation | Silent truncation, and the starvation the pagination existed to prevent |
| Bound the quarantine population | A count bound on unknown-owner records | A count bound on unknown *is* a finalization on unknown |

The brief was the defect each time, not the delegate.

## The mechanism

These are not independent bugs. Each pair sits at the two ends of one **conserved axis** — a
trade-off where reducing one failure increases the other. Pushing along the axis does not
remove the defect; it moves it.

An instruction phrased as a *direction* ("retain rather than delete", "expose less", "bound
it") is therefore read as a gradient to slide along, and the far end of that gradient is a
new defect of the same severity, usually violating the same principle.

Coral's design philosophy makes this visible because principle 11 is cited against *both*
ends: deleting on unknown evidence is a finalization on unknown, and retaining forever is a
hold that names no exit. When one principle condemns both ends of a remedy, that remedy is a
direction on an axis.

## Recognising an axis

Three tells, any of which should raise the question:

1. **The remedy is comparative** — more or less, retain or delete, bounded or unbounded,
   eager or lazy, verbose or quiet.
2. **Both failure modes carry the same severity** and cite the same rule against them.
3. **This round's finding lives inside the mechanism the previous round introduced.** This is
   the strongest tell and the easiest to check mechanically.

The decisive test: *push the proposed remedy to its extreme and say what breaks.* If the
answer is "nothing, it is simply correct", the finding is a point defect. If the answer is a
defect of comparable severity, the finding is on an axis.

## Three responses, most valuable first

### 1. Change the axis

Find the construction in which the trade-off does not exist. This is the only response that
ended a defect class on the branch studied, and it did so four times:

| Class | Rounds spent moving along the axis | What ended it | Net |
| --- | --- | --- | --- |
| Schema/type drift guard | 5 | Derive the type from the schema — nothing left to compare | — |
| Quarantine addressing | 3 | Quarantine as a disposition, not a place | −179 |
| Durable refusal record | 2 | The refused record is its own witness; delete the second artifact | −337 |
| Status taxonomy render | 3 | Render what the reader can act on, not the owner's state machine | −814 |
| Directory pagination | 2 | One bounded observation, honestly truncated | −793 |

Each is a deletion. That is not a coincidence: a conserved axis usually exists because a
mechanism was introduced to mediate between two concerns that did not need mediating.

### 2. Add an authority

Some axes are real and irreducible. A finite local store cannot losslessly retain an
unbounded sequence; no phrasing removes that.

Principle 11 provides the third answer for exactly this case — *an explicit authority
empowered to override the uncertainty*. The move is not to pick an end but to add a
dimension: a typed disposition that states what was lost, on whose authority, and what a
reader can still learn. Arbitrary eviction presented as "retained" is the failure this
replaces.

### 3. State both ends

The weakest response, and the cheapest. When a fix brief names an axis-type finding, it must
name **both** failure modes and the specific opposite it expects — "retain unknown-age
records **and** keep the population bounded"; "remove the path from the log **and** keep the
errno". This is a guardrail against sliding, not a cure for the axis.

## What does not generalise

**Most findings are not on an axis, and applying this framing to them is noise.** The
highest-value findings in the loop studied were plain defects with no trade-off at all:

- `localeCompare` is not a strict total order — `'é.json'.localeCompare('é.json')` is
  `0` for two distinct strings, so a cursor skipped an entry permanently.
- Decoding a filename to a string is not injective — 130 raw-distinct directory entries
  decoded to 2 JavaScript strings, defeating both an ordering and a 128-entry bound.
- A bare `502`/`503`/`504` was reported as a verified shutdown with a success exit code.

These have one correct answer. Run the extreme test before reaching for the axis framing.

## Applying it in a review loop

Three insertion points, in increasing order of value.

**In the review brief.** Ask the reviewer to look for the mirror of the previous round's fix.
Measured effect in the loop studied: the round this clause was first added, one reviewer's
verdict opened by naming the blockers as "their far-side mirrors" — never-terminal retention,
a rendered owner that may not exist, and an automatic release whose only refusal successor is
itself. One paragraph of brief, immediate return.

**In the fix brief.** State both failure modes for axis-type findings only, and authorise the
delegate to report a conflict between them rather than pick a side silently.

**As a stopping signal.** When N consecutive rounds have their findings inside the mechanism
the previous round introduced, stop patching and escalate the axis question to a design
review. This is the most valuable of the three, because it does not make individual fixes
better — it identifies the point at which further fixes are the problem. Every one of the
five class-ending changes above came from such an escalation.

A corollary worth encoding: **a round whose net line count grows while the defect count stays
flat is evidence for the stopping signal**, not evidence of progress.

## Honest limits

This is one loop, one branch, one codebase. The mechanism — conserved trade-offs, and
instructions read as directions — is not specific to any of them, and the classic instances
are everywhere: strict versus tolerant parsing, retry versus give up, cache invalidation
eagerness, log verbosity versus noise, lock granularity, timeout length.

But the discipline would not have collapsed the loop studied. Roughly six rounds were
mirror-image rounds and each pulled in a follow-up, so perhaps ten of ninety. The remainder
were genuine defects that only measurement found, and no framing shortens those.
