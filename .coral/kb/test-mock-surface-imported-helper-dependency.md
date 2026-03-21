# Executor Test Mocks Must Cover Imported Helper Dependencies
Promoted: 2026-03-21 | Updated: 2026-03-21
## Rule
When an executor starts calling a helper from another module during prompt construction or other tested behavior, update the executor test mocks to cover that helper's dependency surface too. If the helper reaches into `node:child_process`, `fs`, or another mocked core module, the test's mock has to expose every function the imported helper now needs.
## Why
Vitest module mocks apply to the entire module identity, not just the direct call site you were thinking about. `codex-executor` originally only needed a mocked `spawn`, but once `prependClaudeMd()` called `projectDataDir()`, the same `node:child_process` mock also had to provide `execFileSync` for `src/client/paths.ts`. Without that, the new `{{CORAL_PROJECTS}}` coverage fails for an artificial test-mock hole instead of a real production bug.
## Pattern
Right:
```typescript
vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
  execFileSync: mockExecFileSync,
}));

mockExecFileSync.mockReturnValue('https://token@github.com/acme/my.repo.git\n');
await executeOneShot('prompt', { workingDirectory: '/tmp/project-root', ...opts });
```

Wrong:
```typescript
vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

// Imported helper now calls execFileSync(), so placeholder-substitution tests fail
// before the executor logic is actually exercised.
```
