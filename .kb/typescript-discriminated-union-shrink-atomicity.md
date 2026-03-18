# Discriminated Union Shrink Must Be Atomic with Switch Case Deletion

## Rule
When removing a member from a Zod `z.discriminatedUnion` (or a TypeScript discriminated union), the `switch` case that handles that member must be deleted in the same edit. If the union member is removed first, TypeScript narrows the variable to `never` inside the surviving case branch — a compile error. Similarly, any type imports (`CodexWaitInput`, `ClaudeWaitInput`) used only in that branch must be removed at the same step, since the union removal makes the variable `never` and the cast `input as T` becomes unreachable. Verification gates (`npx tsc --noEmit`) must only run after the full atomic edit, not between the union change and the case deletion.

## Why
Zod's `z.infer<typeof schema>` reflects the discriminated union. Removing a member from the Zod schema immediately removes it from the inferred TypeScript union. Any `switch` case that previously handled `op: 'wait'` now has no reachable type for `input`, so TypeScript assigns it `never`. Any property access or type cast inside that branch becomes a compile error. Multi-phase plans that remove the Zod union in Phase N and delete the case in Phase N+1 produce a guaranteed red state between those phases.

## Pattern
```typescript
// WRONG plan: union removal in Phase 3, case deletion in Phase 4
// Phase 3: src/codex/schemas.ts
export const codexOpSchema = z.discriminatedUnion('op', [
  execShape, listShape, forkShape, abortShape
  // waitShape removed here
]);

// Phase 3: src/codex/server-handlers.ts — still has wait case
// → TypeScript: input is never in case 'wait'
case 'wait':
  return handleRunnerWait('codex', input as CodexWaitInput, ...); // ← ERROR

// RIGHT plan: union removal and case deletion in same atomic edit
// Phase 3 (atomic): remove waitShape from schema AND delete case 'wait' AND delete CodexWaitInput import
```

Context: unified-wait plan, March 2026. The plan's Phases 2-6 were also required to be atomic because test files (`tsconfig.json` includes `src/**/*.ts`) referenced the old `handleWait(provider, ...)` signature — Phase 2 changed the signature while Phase 6 updated the test callers.
