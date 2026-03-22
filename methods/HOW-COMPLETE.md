# HOW to Evaluate Completion

Apply this alongside the caller's severity gate.
These are additional necessary conditions — the caller's severity gate AND all conditions below must pass for a round to exit.

## Frame Stability Condition

A round cannot pass if any FRAME-level finding appeared in it — regardless of severity.

A FRAME-level LOW finding still blocks exit.
Example: "The plan implements feature X when the user actually requested feature Y,
but the fix is a one-line scope statement change."
This is FRAME (wrong problem) but LOW (trivial to fix). It still blocks —
because solving the wrong problem at any cost is still the wrong problem.

Frame stability is achieved when the most recent round produced no FRAME-level findings from either reviewer.

## Counterexample Type Coverage

Track which counterexample types from HOW-REVIEW's checklist have been explicitly probed across all rounds.
This tracking lives in the round summary under `### Counterexample Coverage`.

Format:
```
### Counterexample Coverage
- Requirements mismatch: explored (Round 1, no finding)
- Constraint violation: explored (Round 1, HIGH — addressed)
- Missing edge case: not yet
- Incorrect assumption: explored (Round 2, no finding)
- Scalability failure: not yet
- Integration conflict: explored (Round 1, no finding)
- Verification gap: explored (Round 2, MEDIUM — addressed)
```

"Explored" means the reviewer explicitly probed that category. Finding nothing is valid —
but the probe must have happened. Absence of a finding does not mean absence of a probe.

Completion requires all major types explored, not just absence of new findings.

## Refutation Effort Assessment

Before declaring pass, assess:
"Did reviewers genuinely attempt adversarial attack, or did they rubber-stamp?"

Indicators of insufficient effort:
- Review is very short (< 5 findings across both reviewers)
- No file:line references anywhere
- No FRAME-level assessment (not even "FRAME: not applicable because...")
- Findings are only MEDIUM/LOW in the first round

If effort appears insufficient, treat the round as inconclusive and re-run —
even if the severity check would otherwise pass.
When re-running, add to the reviewer prompt: "Previous review was insufficient —
explicitly probe FRAME alignment, provide file:line references,
and attempt at least one adversarial counterexample." This prevents repeated rubber-stamping.

## Progressive Focus

Rounds should converge through levels, not jump around:
- **Early rounds**: resolve FRAME issues (right problem?)
- **Middle rounds**: resolve STRUCTURE issues (right approach?)
- **Late rounds**: resolve DETAIL issues (right execution?)

A round with only DETAIL findings and no FRAME/STRUCTURE findings indicates progressive convergence —
this is a positive signal.
A round that introduces new FRAME findings in a late round is a regression — treat it as high priority.

## Combined Exit Rule

A round passes when ALL of the following are true:
1. Caller's severity gate passed (no CRITICAL or HIGH after synthesis — reclassification happens at synthesis time, never after fixes)
2. No FRAME-level findings in this round, regardless of severity *(Frame Stability)*
3. All major counterexample types have been explored across rounds *(Coverage)*
4. Refutation effort appears genuine *(Effort Assessment)*
