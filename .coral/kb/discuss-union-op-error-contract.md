# Discuss: Discriminated Union vs unknown_op Error Contract

## Rule
If a consolidated MCP tool uses `z.discriminatedUnion('op', ...)` with parse-first dispatch, invalid `op` values naturally produce Zod validation errors, not domain-level errors like `unknown_op`. If product/API requirements mandate `unknown_op`, validate `op` explicitly before union parsing or map Zod discriminator failures to the domain error.

## Why
Teams often combine tools for token savings and keep old error contracts in acceptance criteria. Parse-first union validation makes those criteria silently unachievable, leading to flaky tests and inconsistent client behavior.

## Pattern
```typescript
// Wrong: parse-first makes bad op a Zod error, never `unknown_op`
const parsed = discussOpSchema.parse(rawArgs);
switch (parsed.op) {
  // ...
}

// Right: explicit op check preserves domain contract
const op = rawArgs.op;
if (!VALID_OPS.includes(String(op))) {
  return jsonResult({ error: 'unknown_op', op });
}
const parsed = discussOpSchema.parse(rawArgs);
```
