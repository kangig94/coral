# Multi-Phase Algorithms: Later Phases Must Not Mutate Earlier Phase Outputs

## Rule
In a multi-phase algorithm (Phase A: per-item evaluation, Phase B: combination), Phase B steps operate on the combined result only. Earlier phase outputs are referenced read-only for qualification checks — never re-computed or mutated. If a Phase B step says "apply to items that were X in Phase A," it means "check Phase A results to decide whether to apply, then apply to the Phase B combined result."

## Why
Ambiguous operand scope in Phase B ("apply upgrade to individual lines") creates two valid interpretations: (1) re-compute individual Phase A results (mutation), or (2) use Phase A results as a condition and apply to the combined Phase B result (read-only reference). Interpretation (1) breaks the phase boundary — Phase A results feed into Phase B combination logic, so mutating them retroactively invalidates the combination. Multiple independent reviewers (Codex architect Round 3 + Claude architect Round 1) converged on this as a design flaw in HOW-CONFIDENCE's grading algorithm.

## Pattern
**Wrong** (Phase B mutates Phase A):
```
Phase A: evaluate each evidence line → individual tiers
Phase B Step 7: upgrade factors — apply +1 to individual lines that were LOW/VERY LOW
  (Which individual lines? Phase A's? This re-computes Phase A outputs from within Phase B)
```

**Right** (Phase B references Phase A read-only):
```
Phase A: evaluate each evidence line → individual tiers (frozen after Phase A)
Phase B Step 7: upgrade factors — applied to the combined tier.
  Qualification: at least one Phase A individual tier was LOW/VERY LOW.
  (Phase A results checked for eligibility, combined tier is the operand)
```
