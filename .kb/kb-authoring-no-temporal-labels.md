# KB Files: Describe Correct Behavior Only — No Temporal Labels

## Rule
KB entries must describe only the correct current pattern. Never label examples as "old pattern", "deprecated", or "previous approach" — an LLM reading the file in a future session has no temporal context and treats all content as authoritative. If both a correct and incorrect approach are shown, label them "correct" and "avoid" (or omit the negative example entirely if the rule is clear enough on its own).

## Why
"Old pattern" is meaningless to an LLM without conversation history. If the KB entry shows an "old pattern" and a "new pattern", the LLM may follow either one — it cannot infer which is current. The goal of KB files is to make the correct pattern unmissable, not to document history.

## Pattern
```
# Good: only the correct pattern
## Pattern
```typescript
// Correct
const result = correctApproach();
```

# Good: explicit avoid label if contrast is needed
## Pattern
```typescript
// Correct — use this
const result = correctApproach();

// Avoid — silent failure: explain why
const wrong = wrongApproach(); // reason it fails
```

# Bad: temporal labels that carry no information
// WRONG (old pattern — removed):
// oldApproach()  ← LLM cannot tell if this is still present in the codebase
```
