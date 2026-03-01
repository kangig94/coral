# HOW to Elicit Requirement Gaps

A single perspective finds only gaps visible from that angle — systematic lens rotation
exposes what each lens alone cannot see.
Following **HAZOP** (ICI, 1960s; IEC 61882:2016), requirements are treated as process nodes
subjected to guide word perturbation.
Following **Klein** (HBR 2007), failures are best anticipated by imagining they have already happened —
Mitchell et al. (1989) found a 30% improvement in reason identification.
Following **Dewar et al.** (RAND MR-114-A, 1993), the most dangerous assumptions are load-bearing and vulnerable ones
that everyone shares but no one has examined.

## Guide Words (SW-Adapted)

Adapted from HAZOP's seven guide words (IEC 61882:2016). EARLY/LATE is derived from STPA's
"too early/too late/wrong order" unsafe control action type (Leveson, 2004).

| Guide Word | SW Meaning | Example Question | Detects |
|------------|-----------|-----------------|---------|
| NO / NOT | Function doesn't execute | What if this operation fails silently? | Failure handling |
| MORE / LESS | Input exceeds or falls below expected range | What if 10M records instead of 1K? | Boundary values, load |
| AS WELL AS | Concurrent or additional operation | What if two users trigger this simultaneously? | Concurrency, side effects |
| PART OF | Only partial success/completion | What if the third step in a 5-step process fails? | Atomicity, rollback |
| REVERSE | Opposite direction or order | What if the user undoes this action? | Undo, rollback, order dependency |
| OTHER THAN | Entirely different input type | What if the input is XML instead of JSON? | Type safety, injection, format |
| EARLY / LATE | Timing deviation | What if the callback fires before setup completes? | Race conditions, timeouts |

## Step 0: Requirement Quality Gate

Before applying lenses, verify the raw requirements meet minimum quality.
This prevents analyzing garbage requirements with sophisticated tools.

For each stated requirement, check:
1. Is it testable? (can you write a pass/fail check?)
2. Is it unambiguous? (does it have exactly one interpretation?)
3. Is it complete? (does it specify behavior, not just intent?)

Any requirement failing these checks → finding (category: Missing Acceptance Criteria).
Then proceed to lenses with the validated requirements.

## Protocol

### Lens 1: Boundary Scoping

Origin: PICO framework (Population/Intervention/Comparison/Outcome) from systematic literature reviews (PRISMA methodology).
Establish what IS and IS NOT in scope before looking for gaps.

1. Identify the subject — what system/component (PICO: Population)
2. Identify the action — what change/feature (PICO: Intervention)
3. Identify the baseline — what is the current behavior (PICO: Comparison)
4. Identify the boundary — what is explicitly excluded
5. Flag ambiguous boundaries as findings

### Lens 2: Deviation Analysis

Origin: HAZOP guide word method (ICI, 1960s; IEC 61882:2016), enriched by STPA's 4 unsafe control action types
(Leveson, 2004): not providing, providing causes hazard, wrong timing, wrong duration.
Apply each guide word to each stated requirement.

1. List stated requirements/behaviors (the "nodes" in HAZOP terms)
2. For each requirement, apply each guide word from the table above
3. For each deviation: is the behavior defined? If undefined → gap
4. Prioritize by severity (undefined behavior in critical path > edge case)

### Lens 3: Assumption Surfacing

Origin: Assumption-Based Planning (Dewar et al., RAND MR-114-A, 1993).
Key framework: load-bearing × vulnerable = critical.
Also check STPA's "process model" concept: what does the system assume about its environment?

1. List implicit assumptions (things taken for granted without evidence)
2. For each assumption: is it load-bearing? (if wrong, does the design fail?)
3. For each load-bearing assumption: is it vulnerable? (could it plausibly be wrong?)
4. Load-bearing + vulnerable = critical gap requiring explicit validation

### Lens 4: Inversion (Pre-mortem)

Origin: Prospective hindsight (Klein, HBR 2007; Mitchell et al., 1989).
Mitchell found that imagining an event has already occurred increases ability to identify reasons by 30%.
Independence in this step prevents anchoring on already-found gaps.

1. Assume the feature shipped and failed. State the failure scenario.
2. Generate 3-5 failure reasons independently (not constrained by previous lenses)
3. For each reason: was it addressed by Lenses 1-3? If not → new gap
4. Inversion finds risks that forward analysis misses

### Lens 5: Completeness Check

Origin: Gawande checklist (DO-CONFIRM type, 2009) + FMEA standard failure categories (MIL-P-1629, 1949).
ISO 13485 gap analysis clause-by-clause pattern informed the category structure.
This is a DO-CONFIRM checklist: you have already analyzed via Lenses 1-4, now confirm each standard category was addressed.

Standard categories (check each):
- Error handling: what happens on failure?
- Authentication/Authorization: who can do this?
- Validation: what input is rejected?
- Persistence: what state changes? Is it reversible?
- Observability: how do we know it's working?
- Migration: what happens to existing data/users?
- Performance: what are the SLAs?
- External constraints: API limits, backward compatibility, rate limiting, transport restrictions

Any uncovered category → gap.

## When to Apply Partial Lenses

Proportional effort based on scope:
- Simple change (single function): Step 0 + Lens 2 (Deviation) only
- Feature addition: Step 0 + Lenses 1-2-5 (Boundary + Deviation + Completeness)
- Architecture change: Step 0 + All 5 lenses

Scale guidance: when requirements exceed ~20 items, prioritize critical-path requirements first.
Apply full lens analysis to critical items, Lens 2 + Lens 5 only to remaining items.

## Failure Modes

- Single-lens fixation: running only Deviation and calling it complete
- Guide word mechanical application without thinking about the specific context
  (HAZOP IEC 61882 warns: guide words need "intuition and good judgement")
- Over-analysis: 50 edge cases for a trivial feature — prioritize by impact and likelihood
- Missing the forest: catching subtle gaps while core happy path is undefined
- Assumption blindness: not questioning assumptions because they "feel obvious"
  (ABP's core insight: the hardest assumptions to find are the ones everyone shares)
- Confirmation bias: only finding gaps that confirm pre-existing concerns
