# Zod .strict() Required at Top-Level for Clean API Breaks

## Rule
When renaming a top-level Zod schema field (e.g., `args` → `atoms`), apply `.strict()` on the **top-level** object schema — not just inner nested schemas. Without top-level strictness, Zod silently strips unknown keys, so the legacy field name is accepted and dropped instead of rejected.

## Why
During `args` → `atoms` migration, only the inner `atomConfigSchema` had `.strict()`. The top-level `workflowInputSchema` used default Zod behavior (strip unknown keys), meaning callers passing `args` would succeed silently — the key would be dropped, and execution would proceed with empty config. This creates a dangerous partial migration: callers think per-atom config was applied but execution runs with defaults.

## Pattern
```typescript
// WRONG: legacy `args` silently dropped
export const workflowInputSchema = z.object({
  expression: z.string(),
  atoms: z.record(z.string(), atomConfigSchema).optional(),
});

// RIGHT: legacy `args` rejected with clear error
export const workflowInputSchema = z.object({
  expression: z.string(),
  atoms: z.record(z.string(), atomConfigSchema).optional(),
}).strict();
```
