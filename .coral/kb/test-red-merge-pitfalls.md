# Red Test Merge Pitfalls
Promoted: 2026-03-09 | Updated: 2026-03-09

## Rule
When merging red-attacker tests into existing files, the build-only failures that still matter are exact string assertions against expanded recovery messages and overly specific Vitest mock callback parameter types. Do not rely on the older `ClaudeExecResult.costUsd` non-nullability workaround; that contract is now nullable and no longer requires `as any`.

## Why
Vitest uses esbuild and skips full type-checking, so these mistakes can pass `npm test` and fail later under `tsc`. Exact `toEqual` assertions also break silently once rejection messages gain recovery-hint suffixes.

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
```
