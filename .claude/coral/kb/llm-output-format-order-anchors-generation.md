# LLM Output Format Order Is Also Generation Order

## Rule
When an output format spec shows an item first (e.g., `# {Name} - {Role}` as the header), the LLM generates that item first — before any context for it exists. The output format is not just layout; it is the token generation sequence. Items that should emerge from context (names, summaries, conclusions) must be explicitly deferred in the protocol even if they appear first in the output.

## Why
In persona-generator, `# {Name} - {Role}` was the first line of Output_Format. LLMs generating top-down produced names before background — defaulting to familiar, clichéd names (same names session after session). When Expertise and Perspective were written first, names emerged organically from the specific background and felt authentic.

Adjective instructions ("use unique/creative/diverse names") don't fix this — they trigger cliché "unique-sounding" names (Zephyr, Kai, etc.) instead of authentic ones. Structural constraints (generation protocol) beat quality adjectives.

## Pattern
Wrong:
```markdown
# Output_Format
# {Name} - {Role}

## Expertise
...
## Perspective
...
```
Result: LLM writes name first → generic name → persona built around it.

Right:
```markdown
# Output_Format
**Header** (required, first line of output — but generated LAST):
# {Name} - {Role}
⚠ Generation order ≠ output order. Design the full persona (sections 1-5) first,
then pick a name that fits the background.

## Expertise
...
```
Combined with Protocol: "Think through Expertise, Perspective, Communication Style, and Core Focus **before producing any output**. Only after the full background is formed, choose a name."

Key principle: For items that must be *derived* from context (not *given*), explicitly break the "top-down output = top-down generation" default.
