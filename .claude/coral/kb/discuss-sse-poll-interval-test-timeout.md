# Discuss SSE Integration Tests Require Extended Timeouts for Poll Interval

Promoted: 2026-03-10 | Updated: 2026-03-10

## Rule
`discuss:event` SSE frames are emitted by a `setInterval` poll at 2000ms. Integration tests that write `events.jsonl` after bridge bootstrap must use `waitForText(check, 5_000)` and set the vitest test timeout to `10_000`. The `DiscussBridge` registers a cursor at offset 0 for session dirs with no log at `rescan()` time — writes after bootstrap are picked up by the next poll without another `rescan()`.

## Why
The default `waitForText` timeout is 2000ms, which is exactly one poll cycle. Network and scheduling jitter means the frame may not arrive before the 2s deadline expires, causing flaky failures. The initial `rescan()` in `getDiscussBridge()` is not required to see any events — the lazy cursor means writing the log file after bootstrap is the correct and intended pattern.

## Pattern
Right:
```typescript
it('emits discuss:event after bootstrap', async () => {
  // Create session dir BEFORE emitting session:updated so rescan() registers it
  mkdirSync(sessionDir, { recursive: true });

  const stream = await openHttpStream(`${baseUrl}/events/stream`, { ... });
  await stream.waitForText((t) => t.includes('event: ready'));

  // Bootstrap via session:updated — no job:created needed
  eventBus.emit('session:updated', { projectRoot, ... });

  // Write events.jsonl AFTER bootstrap — poll timer picks it up within 2s
  writeFileSync(discussEventLogPath(sessionDir), `${JSON.stringify(event)}\n`, 'utf8');

  // Use 5s timeout (> 2s poll interval) to account for scheduling jitter
  const received = await stream.waitForText(
    (t) => t.includes('event: discuss:event'),
    5_000,
  );
  expect(received).toContain('"kind":"speech_recorded"');
}, 10_000);  // vitest timeout must be > waitForText timeout
```

Wrong:
```typescript
it('emits discuss:event after bootstrap', async () => {
  const received = await stream.waitForText(
    (t) => t.includes('event: discuss:event'),
    2_000,  // Equal to poll interval — will fail under any scheduling jitter
  );
});
// No vitest timeout override — vitest default may be < waitForText + poll interval
```
