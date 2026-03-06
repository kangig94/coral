# Bridge Import-Time Handler Test Seam
## Rule
When a bridge/server module instantiates its MCP `Server` and calls `connect()` at import time, helper mocks alone are not enough for bridge-layer handler tests. The plan must provide an explicit seam: either export a factory/handler registration path, or mock the MCP SDK `Server` and transport so tests can capture the registered `CallTool`/`ListTools` handlers during module import.
## Why
Without that seam, a plan can claim bridge coverage while the current code shape offers no way to invoke the registered handlers directly. Importing the module only performs side effects, and the handlers remain trapped inside the SDK instance.
## Pattern
Right:
```ts
// Option A: expose a factory
export function createBridgeServer(deps = defaultDeps) {
  const server = new Server(...);
  server.setRequestHandler(CallToolRequestSchema, ...);
  return server;
}
```

```ts
// Option B: mock MCP SDK in tests and capture handlers on import
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    setRequestHandler(schema, handler) { captured.set(schema, handler); }
    connect() { return Promise.resolve(); }
  },
}));
```

Wrong:
```ts
vi.mock('../backend-client.js', () => ({ getBackendStatus: vi.fn() }));
await import('../server.js');
// No handle to the registered MCP handlers.
```
