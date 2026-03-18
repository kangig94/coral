# CLI Reuse Must Follow Existing Client Surface Boundaries
Promoted: 2026-03-13 | Updated: 2026-03-14
## Rule
When adding a parallel CLI or any other secondary client, do not assume `BackendClient` is the only safe reuse seam. Reuse the public client for typed tool-call operations it already models, but keep transport/lifecycle edges on the lower-level helpers that preserve their real contracts, especially opaque wait replay cursors and backend status/shutdown without autostart. If the backend already mixes raw `/tool` response shapes or keeps result formatting inside the bridge, add a CLI-side normalizer and parity tests instead of forcing a bridge-server refactor just to make the CLI feel "thin."
## Why
Forcing every path through the existing high-level client creates false "thin wrapper" claims. In Coral, provider/discuss/workflow/abort tool calls fit `BackendClient`, but `wait` replay depends on raw SSE `id` capture and backend lifecycle status depends on reading daemon state without calling `ensureBackend()`. The backend also returns both `McpResult` envelopes and plain `{ status: "rejected" }` objects over `/tool`, while wait path-first shaping still lives in `src/bridge/server.ts`. Ignoring that split either duplicates bridge logic in the wrong place, silently changes CLI output semantics, or invents an unnecessary bridge edit.
## Pattern
Right:
```ts
const client = new BackendClient({
  ensureBackend: () => ensureBackend(pluginRoot),
  defaultContext,
});

await client.providerExec('codex', prompt, options);
const output = normalizeCliToolResponse(await client.discussWatch(session));
for await (const record of streamWait(jobIds, options)) {
  // preserve opaque cursor semantics
}
const outputRecord = shapeWaitOutputRecord(event, cursor, embed); // parity-tested against path-first wait shaping
const status = await getBackendStatus(); // no autostart
```

Wrong:
```ts
const client = new BackendClient({ defaultContext });

await client.exec(prompt, options);
await client.health();   // may autostart the daemon
await client.wait(jobIds, { cursor: opaqueString }); // contract mismatch
console.log(await client.discussWatch(session)); // raw McpResult envelope leaks to CLI users
```
