# CLI stdin mocks must start reading before ending the stream
Promoted: 2026-03-14 | Updated: 2026-03-14
## Rule
When a CLI helper short-circuits stdin reads based on `process.stdin.readableEnded`, unit tests must not replace `process.stdin` with an already-ended mock stream before calling the helper. Install a live stream first, invoke the code under test so it attaches listeners, then end the stream with the payload.
## Why
If the mock stream is already ended, the helper can return `''` immediately instead of reading the intended payload. The failure then shows up as a downstream `JSON.parse` error or empty-input bug, which hides the real issue: the test set up stdin in an impossible order for the implementation.
## Pattern
Right:
```ts
const stdin = new PassThrough();
Object.defineProperty(process, 'stdin', { configurable: true, value: stdin });
const resultPromise = parseInputJson('-');
stdin.end('{"topic":"risk"}');
await expect(resultPromise).resolves.toEqual({ topic: 'risk' });
```

Wrong:
```ts
const stdin = new PassThrough();
stdin.end('{"topic":"risk"}');
Object.defineProperty(process, 'stdin', { configurable: true, value: stdin });
await parseInputJson('-');
```
