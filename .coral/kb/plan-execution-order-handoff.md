# Plan Execution Order Is A Ralph Handoff Contract
Promoted: 2026-03-21 | Updated: 2026-03-21
## Rule
When a plan is intended for `skills/ralph/SKILL.md` plan mode, `## Execution Order` is required plan content, not optional scaffolding. The section must spell out the dependency graph, ordered batches, and AC-to-file mapping, because `ralph` reads that section directly to derive sequencing and parallel work boundaries.
## Why
Detailed phases and acceptance criteria are not enough if the implementer still has to infer batch order and file ownership. A blank or placeholder `Execution Order` section leaves the handoff incomplete, which forces execution-time guesswork and breaks the plan-mode contract even when the rest of the plan looks implementation-ready.
## Pattern
Right:
```md
## Execution Order

Dependency graph:
1. Foundation batch first.
2. Runtime/persistence batch depends on foundation.

Ordered batches:
| Batch | Files | ACs |
|---|---|---|
| 1 | ... | AC1 |

Acceptance Criteria to file mapping:
| AC | Primary files |
|---|---|
| AC1 | ... |
```

Wrong:
```md
## Execution Order (written later)
```
