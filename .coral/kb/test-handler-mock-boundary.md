# Handler Test Mock Boundary: Assert Forwarding, Not CLI Args

## Rule
When a handler test mocks an executor module (e.g., `claude-executor`), the test can only assert
what was passed *to* the executor — not the final CLI arguments emitted downstream. CLI arg
verification belongs in the executor's own test file. Handler tests assert forwarding semantics:
that the correct options (e.g., `bypassPermissions`, `model`, `systemPrompt`) were passed to the
executor call.

## Why
Asserting spawned argv from a handler test requires un-mocking the executor and running the full
stack, which couples handler tests to CLI implementation details and makes them fragile. The right
split is: executor tests own "does `bypassPermissions: true` produce `--dangerously-skip-permissions`
in argv?"; handler tests own "does `bypass_exec` op reach the executor as `bypassPermissions: true`?"
(bypass is determined by op, not by a schema field).

## Pattern
```typescript
// WRONG — handler test trying to assert CLI args (executor is mocked, this can't work)
expect(spawnCli).toHaveBeenCalledWith(
  expect.objectContaining({ args: expect.arrayContaining(['--dangerously-skip-permissions']) })
);

// RIGHT — handler test asserts forwarding to the (mocked) executor
expect(executeClaudeOneShot).toHaveBeenCalledWith(
  prompt,
  expect.objectContaining({ bypassPermissions: true })
);

// RIGHT — executor test asserts final CLI args (real executor, no mock)
// src/claude/__tests__/claude-executor.test.ts
it('passes --dangerously-skip-permissions when bypassPermissions is true', async () => {
  await executeClaudeOneShot(prompt, { bypassPermissions: true });
  expect(spawnCli).toHaveBeenCalledWith(
    expect.objectContaining({ args: expect.arrayContaining(['--dangerously-skip-permissions']) })
  );
});
```

Context: surfaced during conditional-bypass plan synthesis where verification steps initially
asked AX handler tests to assert spawned args directly (`src/server/__tests__/server-handlers.test.ts`
mocks `claude-executor`; CLI arg tests live in `src/claude/__tests__/claude-executor.test.ts`).
