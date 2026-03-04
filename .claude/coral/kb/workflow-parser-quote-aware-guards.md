# Workflow Parser: All Guards Need Quote-Awareness When Adding Quoted Atoms
## Rule
When introducing quoted literal atoms to a DSL parser, every existing guard that uses simple string methods (`includes(',')`, `includes('(')`) must be replaced with quote-aware equivalents. Updating only the splitting function inside parallel groups (`parseParallelStep`) while leaving the top-level comma guard in `parseStep` unchanged causes `'do a, b' -> resolver` to incorrectly throw "Parallel steps must be wrapped in parentheses".
## Why
Simple `includes()` checks are blind to quote context. A quoted literal containing the guard character (comma, paren, arrow) looks identical to an unquoted one at the character level. If any guard is missed, correct DSL expressions silently fail with confusing parse errors — the user sees a structural error message even though the expression is valid.
## Pattern
When adding quote-aware parsing:
1. Audit every `str.includes(char)` or `str.split(char)` in the parser
2. Replace each with a quote-aware helper (`hasTopLevelComma`, `hasUnquotedParentheses`, `splitByComma`)
3. The `splitSteps` function also needs quote state tracking to ignore `->` inside quotes

```typescript
// Right: quote-aware comma check in parseStep
if (hasTopLevelComma(stepText))
  throw new Error('Parallel steps must be wrapped in parentheses');

// Wrong: blind includes check
if (stepText.includes(','))
  throw new Error('Parallel steps must be wrapped in parentheses');
```
