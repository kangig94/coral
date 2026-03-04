# Server Provider Tools Must Be Registry-Derived At Request Time
## Rule
When provider registration is runtime and bootstrap-driven, tool discovery must be computed from the provider registry at request time (`getTools()`), not exported as a static module-level array. The MCP ListTools handler should call `getTools()` on each request so provider metadata and routable providers stay synchronized.
## Why
A static `tools` snapshot drifts after registry resets, test bootstrap with synthetic adapters, or delayed registration. This creates false negatives where a provider is routable but missing from tool metadata (or vice versa), causing integration tests and runtime behavior to diverge.
## Pattern
Right:
```typescript
export function getTools() {
  registerBuiltInProviders();
  return [...getAllTools(), waitTool, workflowTool()];
}
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getTools() }));
```
Wrong:
```typescript
registerBuiltInProviders();
export const tools = [...getAllTools(), waitTool, workflowTool]; // stale after registry changes
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
```
