# Plan Review Exit Gate: HIGH/CRITICAL Findings Always Require Re-verification Round

Promoted: 2026-03-12 | Updated: 2026-03-12
## Rule
After applying fixes for CRITICAL or HIGH reviewer findings, always run another review round — do NOT declare "Fix and pass" and exit. "Fix and pass" is only valid when the current round's reviewers return NO CRITICAL or HIGH findings (only MEDIUM/LOW or clean). The distinction: if reviewers returned HIGH this round, the rule is "Continue" even after fixes are applied, because the fixes themselves may introduce new issues that require re-verification.

## Why
Applying fixes to a plan does not eliminate the need for re-verification. The modifications made in response to HIGH findings may introduce new structural issues, contradict other plan sections, or leave the original concern incompletely addressed. Exiting after one round of HIGH findings — even after applying fixes — skips the safety check that confirms the fixes actually resolved the problem without creating new ones.

Concrete: During `domain-enrichment` planning, Round 1 returned two HIGH findings (DAST missing from AC5, budget arithmetic off). Fixes were applied (DAST added, relief valve added). The orchestrator incorrectly declared "Fix and pass" and exited. The user correctly pointed out that the protocol requires another round. Round 2 then confirmed the fixes were correct and returned only LOW/MEDIUM findings, legitimately exiting as "Fix and pass."

## Pattern
```
Round 1: reviewers return HIGH(2) + LOW(1)
→ Apply fixes → "Continue" → run Round 2

Round 2: reviewers return MEDIUM(1) + LOW(1)
→ Apply fixes → "Fix and pass" → exit ✓

Wrong:
Round 1: reviewers return HIGH(2) + LOW(1)
→ Apply fixes → "Fix and pass" → exit ✗  (HIGH findings require re-run)
```

Exit gate decision is based on what reviewers RETURNED this round, not on whether you applied fixes.
