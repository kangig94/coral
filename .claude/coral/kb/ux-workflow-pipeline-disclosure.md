# Workflow Pipeline Disclosure in README

## Rule
When showcasing connected multi-skill pipelines (e.g., preplan → plan → ralph), show individual tools first, then the connected pipeline below — never lead with the pipeline. Include "each step works independently" to prevent users from assuming all steps are required. The pipeline section serves as a discovery entry point, not a tutorial.

## Why
Connected workflows suffer from the "best-designed = least-discoverable" paradox: tools with smooth internal transitions (preplan auto-proposing plan, plan saving files for ralph) are invisible if users never trigger the first step. But leading with a multi-step pipeline increases perceived complexity and violates progressive disclosure — users think the pipeline IS the product. The ux-critic dimensions of Discoverability and Progressive Disclosure directly conflict here; layered presentation resolves both.

Note on naming clarity: "ralph" is established vocabulary in the Claude Code plugin community (derived from a well-known predecessor plugin). Domain-specific naming is NOT "jargon without context" when the target audience shares that vocabulary. Evaluate naming against the actual user base, not a hypothetical general audience. The ux-critic Investigation Protocol now includes an audience calibration preamble to enforce this.

## Pattern
Right — layered disclosure:
```markdown
### Accelerate my workflow
/coral:plan add retry logic      ← individual tools first
/coral:ralph implement caching   ← each stands alone

#### Full pipeline
/coral:preplan race condition in session manager
Preplan defines → plan designs → ralph implements. Each works independently.
```

Wrong — pipeline-first:
```markdown
### Workflow Pipeline
Step 1: /coral:preplan → Step 2: /coral:plan → Step 3: /coral:ralph
```
This makes the 3-step flow look mandatory and increases cognitive load for new users.
