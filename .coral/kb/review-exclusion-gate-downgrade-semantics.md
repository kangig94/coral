# Exclusion Gates Should Downgrade, Not Hard-Drop

## Rule
When a review or analysis protocol includes exclusion gates for findings (e.g., "skip
findings about unchanged code"), the gate must downgrade severity and move findings to
a peripheral section — not hard-drop them. Hard-dropping loses findings that may signal
latent defects activated by the change. Downgrade + annotate preserves the signal without
polluting the primary findings table.

## Why
A change to module A can activate a latent defect in stable module B: B was always
broken but A's behavior masked it. If the exclusion gate drops all "B is unchanged →
skip" findings, the reviewer never sees the potential A→B interaction. The change
context is what makes the finding relevant, not whether B itself changed.

Hard-dropping also breaks auditability: if a finding disappears silently, there's no
way to know whether it was (a) not found, (b) found and deemed irrelevant, or (c) found
and potentially relevant but excluded. Downgrade + context note preserves this distinction.

## Pattern
**Wrong** (hard-drop):
```
Exclusion gate: drop findings about unchanged code when reviewing a specific change
→ Finding about stable module B disappears
→ No record that B was examined
```

**Right** (downgrade + annotate):
```
Exclusion gate: for findings about unchanged code when reviewing a specific change:
  - Downgrade severity (e.g., HIGH → MEDIUM, MEDIUM → MINOR)
  - Move to ### Peripheral Findings
  - Add context note: "unchanged code; may be activated by this change"
  → Finding is visible but deprioritized
  → Reviewer can judge whether the change could activate it
```

## Generalization
Applies to any analysis protocol with:
1. A main findings table and a peripheral findings section
2. A scope filter that excludes some inputs by default
3. Cases where "out of scope" does not mean "irrelevant"

The fix is always: assign a downgraded verdict + annotation rather than silently removing
the finding from the output. This is the finding-level analog of the accounting invariant:
all examined items must reach a visible terminal state.
