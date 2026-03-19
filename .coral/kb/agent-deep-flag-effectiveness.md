# --deep Flag Effectiveness: When HOW Method Injection Adds Value

## Rule
The `--deep` flag (HOW method injection) provides significant quality improvement only when **design decisions are still open**. Its value correlates with decision openness, not domain complexity. For post-implementation reviews, deep adds marginal depth at disproportionate cost. Agent diet (minimal base instructions) is a prerequisite — without it, HOW methods overlap with built-in agent protocol, producing redundancy rather than enhancement.

## Why
Without this knowledge, teams either always enable `--deep` (wasting 10-55% more time on reviews where it adds nothing) or never use it (missing senior-level analysis on complex pre-implementation plans). The flag's value also differs by agent role: architect gains qualitative improvement (design alternatives + trade-offs), while critic gains primarily quantitative improvement (more gaps found).

## Pattern
**Conditions for high --deep value** (all three should hold):
1. Plan is **pre-implementation** (design decisions still open)
2. Plan is **complex** (multi-phase, cross-cutting concerns, ownership boundaries)
3. Agent base instructions are **dieted** (WHO/WHAT/GUARD/FORMAT only — no HOW sections)

**Effect by agent role**:

| Role | Without --deep | With --deep | Difference |
|------|---------------|-------------|------------|
| Architect | Finds issues, cites code | Finds issues + proposes alternatives + trade-off tables | Qualitative ("senior") |
| Critic | Finds gaps via logical reasoning | Finds more gaps via systematic exploration | Quantitative on simple plans, qualitative on complex migrations |

**When NOT to use --deep**:
- Post-implementation review (code already written, decisions closed)
- Simple schema/config changes (base agent is sufficient)
- Quick iterative reviews during development (speed matters more)

**Verified examples** (4 experiments, 8 agent runs):
- Kanban plan (pre-impl, medium): deep architect proposed SQLite→JSON, FIFO→reject alternatives
- T3 Scene plan (pre-impl, complex): deep architect found reset() workflow break; deep critic found 12 missing consumer files
- SVO LUT plan (post-impl, complex): deep added only subtle 8-tree performance analysis — minimal difference

**Agent diet prerequisite**: Before dieting, deep and non-deep produced similar or worse results because HOW-REVIEW overlapped with the agent's built-in Investigation_Protocol. After removing HOW sections (keeping only Role/Success_Criteria/Constraints/Output_Format), deep fills a genuine gap.
