# CLI Wait TTY Rendering Needs a Pure Test Seam
Promoted: 2026-03-14 | Updated: 2026-03-14
## Rule
If a CLI feature renders differently for TTY and non-TTY stdout, do not rely on a `spawnSync` integration harness with default pipe-backed stdio to cover both branches. Keep the real branch in the CLI entrypoint, but move the rendering logic into a pure helper that accepts `{ isTTY, columns }` so TTY behavior can be unit-tested directly while CLI integration tests continue to cover the non-TTY path.
## Why
`spawnSync` gives the child process pipes, not a real terminal, so `process.stdout.isTTY` is falsey and the TTY branch never executes. A plan that promises end-to-end TTY assertions in that harness creates an unverifiable acceptance criterion: the implementation can satisfy the contract, but the test suite cannot prove it without PTY infrastructure.
## Pattern
```ts
// Right: branch stays at the CLI boundary, renderer stays pure.
const line = renderWaitEvent(event, {
  isTTY: Boolean(process.stdout.isTTY),
  columns: process.stdout.columns ?? 80,
});
process.stdout.write(line);
```

```ts
// Test the TTY branch directly without needing a PTY child process.
expect(renderWaitEvent(progressEvent, { isTTY: true, columns: 40 })).toContain('\r');
expect(renderWaitEvent(progressEvent, { isTTY: false, columns: 40 })).toContain('\n');
```

```ts
// Wrong: promise TTY coverage from a pipe-backed spawnSync harness.
const result = spawnSync('node', [CLI_BUNDLE, 'wait', '--jobs', jobId]);
expect(result.stdout).toContain('\r');
```
