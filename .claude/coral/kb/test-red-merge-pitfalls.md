# Red Test Merge Pitfalls

## Rule
When merging red-attacker tests into existing test files, three patterns cause failures that only surface at build time (not `npm test`): (1) existing tests using `toEqual` on exact error messages that now include recovery hints must be updated to `toMatchObject` + `toContain`; (2) `vi.spyOn().mockImplementation((typed: string) => ...)` fails tsc because `mockImplementation` expects `(...args: unknown[]) => void` — use `(...args: unknown[]) => { const x = args[0] as string; ... }`; (3) `ClaudeExecResult.costUsd` is typed `number` (not nullable) so test helpers simulating null must cast with `as any`.

## Why
Vitest uses esbuild (no type-checking), so red tests pass `npm test` even with type errors. `tsc` in the build catches them. Recovery hint strings appended to rejection messages break existing exact-equality assertions silently — `toEqual` compares the full string.

## Pattern
```typescript
// WRONG — breaks when message has recovery hint suffix
expect(decision).toEqual({ message: 'Session not found: X' });

// RIGHT — partial match survives message expansion
expect(decision).toMatchObject({ code: 'session_not_found' });
if (decision.status === 'rejected') {
  expect(decision.message).toContain('Session not found: X');
}

// WRONG — tsc error: 'string' not assignable to 'unknown'
vi.spyOn(store, 'readStatus').mockImplementation((jobId: string) => ...);

// RIGHT — use unknown[] destructuring
vi.spyOn(store, 'readStatus').mockImplementation((...args: unknown[]) => {
  const jobId = args[0] as string;
  ...
});

// WRONG — ClaudeExecResult.costUsd is number, not number|null
mockExecuteClaudeOneShot.mockResolvedValueOnce({ costUsd: null });

// RIGHT — cast to bypass non-nullable type
mockExecuteClaudeOneShot.mockResolvedValueOnce({ ...baseResult(), costUsd: null } as any);
```
