# Conditional MANDATORY Leaves Non-Triggering Cases Without Method Coverage

## Rule
When promoting a HOW reference from RECOMMENDED to conditional MANDATORY, do NOT remove the
RECOMMENDED reference. The conditional MANDATORY fires only when its trigger condition is met.
Cases where the trigger doesn't fire still need method guidance. Keep both: MANDATORY for the
enforced path, RECOMMENDED as a lighter pointer for the general case.

## Why
During methodology-refinement, HOW-CONFIDENCE was promoted from RECOMMENDED to conditional
MANDATORY ("when competing hypotheses exist (2+)"). The plan initially removed HOW-CONFIDENCE
from RECOMMENDED entirely — reasoning "it's now covered by MANDATORY." But this created a gap:
single-hypothesis diagnoses still require a confidence tier in their output, but had no method
pointer after the RECOMMENDED reference was removed. An agent following the RECOMMENDED path
(no MANDATORY trigger) would have to guess what HIGH/MODERATE/LOW/VERY LOW means.

## Pattern
**Wrong** (gap for non-triggering cases):
```
**MANDATORY**: When competing hypotheses exist (2+), read HOW-FALSIFY + HOW-CONFIDENCE.
**RECOMMENDED**: Tag evidence provenance per HOW-PROVENANCE.
```

**Right** (dual-path coverage):
```
**MANDATORY**: When competing hypotheses exist (2+), read HOW-FALSIFY + HOW-CONFIDENCE.
**RECOMMENDED**: Tag evidence provenance per HOW-PROVENANCE and grade confidence per HOW-CONFIDENCE.
```

The RECOMMENDED path is lighter (suggestion, not obligation) but ensures that any agent
concluding a diagnosis — even a simple single-hypothesis one — has a pointer to the
confidence grading methodology. Duplication of the HOW-CONFIDENCE reference across
MANDATORY and RECOMMENDED is intentional: different enforcement strength, same file.
