# Complete Accounting Invariant: No Upstream Pruning

## Rule
When a protocol declares a "complete accounting" invariant — every input must reach a terminal state — no filtering or pruning mechanism that precedes the verdict pipeline is safe. Any mechanism that drops items before they receive a verdict creates a state machine hole: items enter the protocol, disappear mid-flow, and the final "list all with verdicts" step can never be satisfied for them.

## Why
HOW-FALSIFY planning (Rounds 2-4) chased this hole three times: hard scaling cap (dropped hypotheses silently) → "select most distinct" override (same hole, different mechanism) → both still broke the Step 4 "list ALL hypotheses with verdicts" invariant. Each fix introduced a new variant of the same problem.

## Pattern
**Wrong**: Add a cap/filter early in the pipeline → some items have no verdict → accounting breaks
```
Step 1: Generate → [filter: keep top 5] → some dropped, no verdict assigned
Step 4: List ALL with verdicts → impossible for dropped items
```

**Right**: Push scaling concern to generation time (soft target), not consumption time (filter)
```
Step 1: "Target 3-5 hypotheses" (soft guidance)
  → Escape gate: unfalsifiable → REJECTED verdict (still listed)
  → Step 2 grouping: indistinguishable → group, not discard
Step 4: List ALL with verdicts → all items have a path to REJECTED/FALSIFIED/WEAKENED/SURVIVED
```

The natural controls (generation guidance + gate verdicts + Step 2 grouping) handle overflow without explicit pruning. Trust the protocol's own mechanisms before adding external constraints.

## Generalization
Applies to any protocol with: (1) a completeness guarantee ("list all", "account for all"), (2) a scalability concern, (3) a temptation to add a selection/cap mechanism. The fix is always: add a verdict for filtered items, or push the constraint upstream to generation.
