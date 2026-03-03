# Zod `.default()` Cascades into Derived Types via `z.infer` + `Extract`

## Rule
Adding `z.boolean().default(false)` (or any defaulted field) to a Zod discriminant member
silently makes that field **required** in derived TypeScript types built with `z.infer<typeof schema>`
+ `Extract<..., { op: 'exec' }>` + `Omit<...>`. Zod's `.default()` resolves at parse time but
does not make the TypeScript field optional — `z.infer` sees it as `boolean`, not `boolean | undefined`.
Any typed object literal for those derived types must include the field explicitly.

## Why
Runtime intent ("bypass defaults to false if omitted") and compile-time contract ("typed object
literals now require bypass") diverge invisibly. A plan that says "force bypass: true on coral paths"
must also account for the type checker requiring `bypass` to be set on every manually-constructed
object literal of that type — even when the intent is already encoded in the schema default.
Missing this causes compile failures discovered during implementation, not planning.

## Pattern
```typescript
// schemas.ts
const execShape = z.object({
  op: z.literal('exec'),
  prompt: z.string(),
  bypass: z.boolean().default(false),  // default(false) ≠ optional in TypeScript
});

// Derived types now have `bypass: boolean` (required)
export type ClaudeSessionCreateInput = Omit<Extract<ClaudeOpInput, { op: 'exec' }>, 'op' | 'session'>;
// ClaudeSessionCreateInput = { prompt: string; bypass: boolean; ... }

// WRONG — TypeScript error: property 'bypass' is missing
const createInput: ClaudeSessionCreateInput = { prompt: augmentedPrompt, model: input.model };

// RIGHT — explicitly set bypass on every typed object literal
const createInput: ClaudeSessionCreateInput = {
  prompt: augmentedPrompt,
  model: input.model,
  bypass: true,  // coral paths always force bypass; explicit is required by the type
};
```

Context: conditional-bypass plan review Round 2, March 2026. Files:
`src/claude/schemas.ts` type aliases, `src/server/server-handlers.ts` coral create/resume literals.
