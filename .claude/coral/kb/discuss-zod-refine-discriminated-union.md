# Zod refine() Breaks discriminatedUnion When Applied to Inner Shape

## Rule
Never add `.refine()` directly to a shape that participates in `z.discriminatedUnion()`. Refine wraps ZodObject in ZodEffects, causing `z.discriminatedUnion` to throw at schema construction time because it cannot find a ZodObject to inspect the discriminator key on. Move cross-field validations requiring context from multiple fields (e.g., "at least one required agent") into the handler layer instead.

## Why
`z.discriminatedUnion('op', [shapeA, shapeB.refine(...)])` fails because `discriminatedUnion` requires each member to be a `ZodObject` and calls `.shape` on it to extract the discriminator key. A `ZodEffects` wrapper (produced by `.refine()`) does not expose `.shape`, so the union construction throws. This is a Zod API constraint, not a TypeScript error — it surfaces at runtime during module initialization.

## Pattern
```typescript
// WRONG — .refine() wraps the ZodObject in ZodEffects, breaking discriminatedUnion
const createShape = z.object({
  op: z.literal('_2_create'),
  agents: z.array(agentSchema),
}).refine(
  (input) => input.agents.some((a) => a.participation === 'required'),
  { message: 'At least one required agent' },
);
// z.discriminatedUnion('op', [createShape, ...]) → throws: no .shape on ZodEffects

// RIGHT — keep the Zod shape clean, validate cross-field logic in the handler
const createShape = z.object({
  op: z.literal('_2_create'),
  agents: z.array(agentSchema),
});

async function handle2Create(input: ...) {
  if (!input.agents.some((a) => a.participation === 'required')) {
    return jsonResult({ error: 'no_required_agents', message: '...' });
  }
  // ...
}
```
