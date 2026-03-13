# ListTools Static Descriptor Coverage
## Rule
Do not treat a static local tool descriptor export as proof that `ListTools` exposes that tool. A descriptor shape assertion only proves the object exists; it does not verify that the `ListTools` handler in the server module actually returns it on the success path, the failure path, or the backend-down path.
## Why
Bridge-local tools often depend on `ListTools` behavior that lives in `server.ts`, not in the descriptor module itself. If tests stop at `expect(backendToolDescriptor.name).toBe(...)`, the code can still regress by omitting the descriptor from the returned tool list, appending it inside the wrong `try` block, or hiding it behind a backend fetch that fails. In bridge handler tests, a malformed mocked `ensureBackend()` result can create the same false signal: if required fields like `host` are missing, the fetch URL becomes invalid and the handler drops into the fallback tool list instead of proving the success-path contract.
## Pattern
Right:
```ts
export function buildListToolsResponse(remoteTools: ToolDescriptor[]): { tools: ToolDescriptor[] } {
  return { tools: [...remoteTools, backendToolDescriptor] };
}
```

```ts
mockEnsureBackend.mockResolvedValue({ host: '127.0.0.1', port: 4545 });
const response = await listToolsHandler();
expect(response.tools.find(tool => tool.name === 'wait')?.inputSchema).not.toHaveProperty('inline');
```

```ts
it('returns backend tool even when remote discovery fails', async () => {
  expect(buildListToolsFallback()).toEqual({ tools: [backendToolDescriptor] });
});
```

Wrong:
```ts
it('has the backend descriptor shape', () => {
  expect(backendToolDescriptor.name).toBe('backend');
});
```
