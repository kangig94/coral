# Expression-body arrow functions break `: void` return type

## Rule
When an arrow function declares `: void` return type but the expression body produces a value (e.g., `process.stderr.write` returns `boolean`), TypeScript raises TS2322. Block body with no explicit return is required — expression bodies are not always equivalent to block bodies during simplification.

## Why
Code simplifiers (human or LLM) routinely convert `=> { stmt; }` to `=> expr` as a "purely structural" change. When the expression returns a non-void value and the function signature declares `: void`, the build breaks silently in the diff review but loudly at compile time.

## Pattern
```typescript
// WRONG — expression body returns boolean, violates void signature
const log = (msg: string): void => process.stderr.write(`${msg}\n`);

// RIGHT — block body discards the return value
const log = (msg: string): void => { process.stderr.write(`${msg}\n`); };
```
