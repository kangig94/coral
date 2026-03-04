# Vitest Mock Call Argument Inspection Requires `unknown` Cast

## Rule
When a vitest mock is created with `vi.fn(async () => {})` (no declared parameters), TypeScript
infers its call signature as `[]` (empty tuple). Accessing `mock.calls[0]` returns type `[]`,
and casting it directly to `[T]` fails with "neither type sufficiently overlaps." The fix is to
cast through `unknown` first: `mock.calls[0] as unknown as [T]`.

## Why
`vi.fn(async () => {})` is typed from its implementation — no parameters → `[]` call type.
TypeScript refuses casts between structurally incompatible types without `unknown` as an
escape hatch, even in tests where you know the runtime shape.

## Pattern
```typescript
// WRONG — TS2352: Conversion of type '[]' to '[T]'
const [firstArg] = notify.mock.calls[0] as [{ params?: { message?: string } }];

// RIGHT — cast through unknown
const [firstArg] = notify.mock.calls[0] as unknown as [{ params?: { message?: string } }];

// ALTERNATIVE — use toMatchObject to avoid extraction
expect(notify.mock.calls[0]?.[0]).toMatchObject({
  params: { message: 'expected' },
});
```

Context: `handleWait` notify callback test at `src/codex/__tests__/server-handlers.test.ts`.
