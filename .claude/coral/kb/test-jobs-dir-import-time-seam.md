# Import-Time Tempdir Seams
## Rule
When a module derives a filesystem constant like `JOBS_DIR` from `tmpdir()` at import time, tests must mock `tmpdir()` to a stable absolute root before the module is imported. Per-test mutation of the mocked return value does not relocate the already-computed constant; clean the fixed root between tests instead.
## Why
If the mock returns a different directory later in `beforeEach()`, the module keeps using the original import-time path while the test setup assumes isolation somewhere else. That leaks persisted state across tests and produces false failures in liveness, health, and orphan-recovery assertions.
## Pattern
Right:
```ts
const mockState = vi.hoisted(() => ({
  tmpRoot: `${process.env.TMPDIR || '/tmp'}/my-test-root`,
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    tmpdir: () => mockState.tmpRoot,
  };
});

beforeEach(() => {
  rmSync(mockState.tmpRoot, { recursive: true, force: true });
  mkdirSync(mockState.tmpRoot, { recursive: true });
});
```

Wrong:
```ts
let tmpHome = '';

vi.mock('node:os', () => ({
  tmpdir: () => join(tmpHome, 'tmp'),
}));

beforeEach(() => {
  tmpHome = mkdtempSync(join('/tmp', 'case-'));
});
```
