# Codex Simplification Review Gate

## Rule
After Codex-delegated simplification, verify not only correctness (tsc + tests) but also **change justification** before committing. Single-use helper extractions and cosmetic renames that don't improve clarity should be reverted.

## Why
Codex tends to produce changes when given broad "simplify" scope — even when the code is already clean. The pressure to "do something" leads to cosmetic changes that add indirection without benefit, violating the "No abstractions for single-use code" principle.

## Pattern
**Wrong**: Run tsc + tests → all pass → commit everything.

**Right**: Run tsc + tests → all pass → review each extracted helper:
- Is it called 2+ times? Keep.
- Does the rename genuinely improve clarity in context? Keep.
- Is it a 1-call wrapper or a rename in a 5-line function? Revert.

Narrow the scope ("this switch is too long", "this pattern repeats in 3 places") rather than giving a broad "simplify these 20 files" directive.
