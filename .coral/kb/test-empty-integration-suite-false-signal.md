# Test Commands Must Not Point at Empty Suites
Promoted: 2026-03-09 | Updated: 2026-03-09
## Rule
If the repo exposes a dedicated test entrypoint such as `npm run test:integration`, its include globs must match real files or the command must be removed or intentionally stubbed with clear semantics. An empty suite behind a failing command is not harmless bookkeeping; it creates false confidence that an integration layer is covered when no tests actually run.
## Why
Coral ships two runtime bundles (`bridge/coral-ax.cjs`, `bridge/coral-backend.cjs`) and multiple stdio/HTTP boundaries, so the existence of an integration command strongly implies end-to-end coverage. When `vitest.integration.config.ts` points at a nonexistent directory, the command fails with `No test files found`, which means the verification surface for bundles, stdio startup, and cross-process wiring is effectively absent even though the script exists.
## Pattern
```ts
// WRONG: dedicated integration script, but the glob matches nothing
export default defineConfig({
  test: {
    include: ['src/**/__tests__/integration/**/*.test.ts'],
  },
});

// RIGHT: keep the script and the suite synchronized
export default defineConfig({
  test: {
    include: ['src/**/__tests__/integration/**/*.test.ts'],
  },
});
// ...and ensure the repo actually contains tests under that path
```

```bash
# WRONG: verification gate that never exercises integration coverage
npm run test:integration
# -> No test files found

# RIGHT: either real integration tests exist, or the script is removed/renamed
```
