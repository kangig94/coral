# Vitest Mock Scope: Must Mock the Exact Import Path

## Rule
`vi.mock('path/to/module')` only intercepts imports that resolve to that exact module identity. If module A imports `runner/progress.ts` directly, mocking `codex/progress.ts` (a different re-export or alias) has no effect on A's calls — you must mock `runner/progress.ts` at A's relative path.

## Why
Vitest uses module identity (resolved file path) to match mocks. Two different import strings that happen to export the same functions are still two separate module identities. A mock for path X doesn't intercept any calls routed through path Y, even if Y re-exports everything from X.

## Pattern
```typescript
// Context: codex/server-handlers.ts imports from codex/progress.ts (a thin re-export)
// runner/job-manager.ts imports directly from runner/progress.ts
// WRONG: Only codex module is mocked; runner/job-manager's imports are not intercepted
vi.mock('../progress.js', () => ({ createSessionDir: vi.fn(...) }));

// RIGHT: Mock both the codex re-export AND the runner module directly
vi.mock('../progress.js', () => ({ createSessionDir: vi.fn(...) }));
vi.mock('../../runner/progress.js', () => ({ createSessionDir: vi.fn(...) }));

// Also update vi.importActual to use the runner module path (not the codex alias)
const { createSessionDir: realCreateSessionDir } =
  await vi.importActual<typeof import('../../runner/progress.js')>('../../runner/progress.js');
```

## Context
`src/codex/__tests__/server-handlers.test.ts` — after extracting `runner/job-manager.ts`, the codex test suite had 9 failures because `job-manager.ts` imports `runner/progress.ts` directly, bypassing the `codex/progress.ts` mock.
