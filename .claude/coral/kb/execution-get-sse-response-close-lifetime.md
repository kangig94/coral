# GET SSE Must Track Response Lifetime
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
For long-lived GET SSE handlers on Node's `http` server, do not use `IncomingMessage.close` as the stream-lifetime signal. A bodyless GET can emit that event as soon as the request finishes arriving, which prematurely tears down subscriptions while the SSE response is still supposed to stay open. Keep cleanup and blocking wait logic anchored to `ServerResponse.close` instead.
## Why
Reusing a POST-stream cleanup pattern on a passive GET SSE endpoint looks natural, but it silently breaks the stream: the server unsubscribes from its event source immediately after the request is parsed, so clients receive at most the initial payload and then stop seeing live updates even though the TCP connection remains open.
## Pattern
Right:
```typescript
async function handleEventStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let closed = false;
  const onClose = () => {
    if (closed) return;
    closed = true;
    bus.off('job:updated', onJobUpdated);
  };
  res.once('close', onClose);

  bus.on('job:updated', onJobUpdated);
  writeSseEvent(res, 'ready', { startedAt: new Date().toISOString() });

  await new Promise<void>((resolve) => {
    if (closed) resolve();
    else res.once('close', resolve);
  });
}
```

Wrong:
```typescript
req.once('close', onClose);
res.once('close', onClose);
```
