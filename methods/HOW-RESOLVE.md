# HOW to Resolve a Contradiction

Genrich Altshuller analyzed thousands of recorded inventive solutions and found that the strongest ones
do not trade one requirement against another — they eliminate the contradiction entirely.
In **TRIZ** (Theory of Inventive Problem Solving), contradictions are not obstacles to route around
but the precise location where invention becomes possible.
The moment two requirements appear mutually exclusive is the moment a resolution search can begin.

## Resolution Mandate

A compromise weakens both sides: requirement A is satisfied less fully, and so is B,
in hopes that the combined result is acceptable.
A resolution satisfies both requirements without concession.
These are categorically different outcomes — a compromise is a managed failure, a resolution is an invention.

Use this when two requirements are simultaneously necessary and mutually exclusive.

## Protocol

### Step 1: Identify the Contradiction

State both requirements explicitly:
- **Requirement A**: [what is needed and why]
- **Requirement B**: [what is needed and why]

Analyze the exclusion mechanism — why can't both be satisfied?
- **Shared resource**: A and B compete for the same resource, time, or attention
- **Logical impossibility**: satisfying A directly prevents B by definition
- **Assumed constraint**: A constraint blocks both, but may not be necessary

**False contradiction filter**: Is this truly exclusive,
or are you assuming a constraint that doesn't actually exist?
Test each assumed constraint by removing it: does the contradiction disappear?
If yes, the resolution is removing the false constraint. Done.

### Step 2: Envision the Ideal Final Result

Do not ask "what if we removed the contradiction?" — ask "what if the system resolved it by itself?"

The Ideal Final Result (IFR) is the state where both A and B are fully satisfied
with no trade-off, no added complexity, and no cost.
It may be unreachable in practice, but it defines the direction of search.

Define the IFR by listing its properties explicitly:
- What would be true about A in the ideal state?
- What would be true about B in the ideal state?
- What resources, constraints, or structures would be absent?
- What would the system do that it currently cannot?

These IFR properties constrain Step 3: a resolution candidate must approach this ideal to be worth evaluating.
They also provide the ranking criteria for Step 4 when multiple candidates compete.

### Step 3: Apply Resolution Principles

Before scanning principles, ask: **What existing resources are unused?**
Resources already present in the system — available capacity, byproducts of existing processes,
data already being collected, structures serving only one purpose —
can often dissolve a contradiction without introducing new elements.

Apply each principle below as a search heuristic. Match the "What it targets" column
to the exclusion mechanism identified in Step 1 — start with principles that target your specific conflict type,
then scan the rest. Not all will apply. For each that fits, generate a candidate resolution.

| Principle | Question | What it targets |
|-----------|----------|-----------------|
| **Split** | Can A and B be satisfied by independent parts instead of one unified element? | Shared resource conflicts |
| **Separate** | Can the conflicting element be isolated so it affects only one requirement? | Direct logical conflicts |
| **Differentiate** | Can the solution behave differently in different contexts — satisfying A here, B there? | Context-tied contradictions |
| **Challenge** | Is the uniform treatment of all cases causing the conflict? What breaks if you treat them asymmetrically? | Hidden symmetry assumptions |
| **Unify** | Can A and B be unified so the boundary between them disappears? | Conflicts born from separation |
| **Dual-purpose** | Can a single element serve both A and B simultaneously? | Resource and function conflicts |
| **Embed** | Can one process be nested inside the other so they no longer compete for the same layer? | Sequencing and ordering conflicts |
| **Use the tension** | Can the conflict itself be made productive — the opposing force becoming a resource? | Antagonistic requirement pairs |
| **Act earlier** | Can the condition that triggers the conflict be addressed before it arises? | Conflicts with known preconditions |
| **Define the fallback** | Can a graceful degradation path be defined in advance, making the conflict safe to enter? | Conflicts with unacceptable failure modes |

Collect all candidate resolutions before evaluating any. Multiple principles may apply.

### Step 4: Verify Resolution

For each candidate:
1. Does it satisfy requirement A — not weaken it, satisfy it?
2. Does it satisfy requirement B — not weaken it, satisfy it?
3. Does it introduce new contradictions?

If multiple candidates pass steps 1-3: rank by how many IFR properties (Step 2) each satisfies.
If tied, prefer the one introducing fewer new elements. If still tied, escalate.

If no candidate resolves: return to Step 1 and reframe. Common reframing moves:
- **Go deeper**: the stated requirements may be proxies for underlying needs. What do A and B actually serve?
- **Go wider**: the exclusion mechanism may depend on a system boundary that can be moved.
- **Change the dimension**: a resource conflict in space may resolve in time, or vice versa.

If still unresolvable after reframing: escalate — the requirements themselves may need re-negotiation.

## Failure Modes

- **Premature compromise**: Accepting "A somewhat, B somewhat" before exhausting the resolution search.
  Compromise is the exit you take when resolution fails, not the first option.
- **False dichotomy acceptance**: Treating the contradiction as given
  without testing whether assumed constraints are real.
  The false contradiction filter in Step 1 exists for this reason.
- **Single-principle fixation**: Trying one principle, failing, and concluding resolution is impossible.
  All ten are search heuristics — run the full set before giving up.
- **Resolution at wrong level**: Resolving a surface formulation while the real contradiction lives one level deeper.
  Re-examine the exclusion mechanism when candidates consistently fail.
- **Ignoring the ideal**: Skipping Step 2 and evaluating candidates without an IFR reference.
  Without it, any candidate that partially works feels like success.
- **New contradiction blindness**: Adopting a resolution without checking Step 4's third question.
  A resolution that introduces a new contradiction is not a resolution — it is a displacement.
