# Bridge wait-stream readers must keep replay state ownership local
Promoted: 2026-03-14 | Updated: 2026-03-14
## Rule
Do not merge the bridge and client wait-stream readers into one shared helper if that helper would own replay cursor updates. The bridge path may advance `cursorRef.lastEventId` from SSE `id` frames, while the shared client path should stay responsible only for parsing and yielding events.
## Why
The chunk-processing loops look nearly identical, which makes them a tempting simplification target. But replay state belongs to the bridge boundary, not to the generic reader. If a shared helper mutates the cursor, replay concerns leak into the client. If it hides cursor updates entirely, reconnect semantics in the bridge can silently drift.
## Pattern
Right:
```ts
for await (const block of readSseBlocks(response.body)) {
  if (block.id !== undefined) {
    cursorRef.lastEventId = block.id;
  }

  yield parseWaitEvent(block.data);
}
```

Wrong:
```ts
for await (const event of readWaitStream(response.body, { cursorRef })) {
  yield event;
}
// Shared helper now owns both parsing and replay-state mutation.
```
