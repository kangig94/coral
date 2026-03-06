# Bridge-Local Backend Tools Must Reconcile With ListTools Startup
## Rule
When adding a bridge-local MCP tool that is supposed to observe or manage backend absence, review the `ListTools` path first. If `ListTools` still calls `ensureBackend()` to fetch remote descriptors, normal MCP discovery can auto-start the daemon before the local tool runs. The plan must either accept that behavior explicitly or change discovery so the local tool remains discoverable without forcing startup.
## Why
A local `backend { op: "status" | "shutdown" }` tool can avoid `ensureBackend()` inside `CallTool`, yet still never see the intended "backend not running" state because the host typically lists tools before the first call. Missing this creates accidental correctness in direct tests while real MCP clients always observe a daemon that was started during discovery.
## Pattern
Right:
```ts
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [backendToolDescriptor, ...(await fetchRemoteToolsWithoutForcingBackend())],
}));
```
Or explicitly document that tool discovery starts the daemon and `backend status` only reports post-discovery state.

Wrong:
```ts
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...await fetchTools()], // fetchTools() calls ensureBackend()
}));
// Later assume backend status can still report "not running" in normal MCP use.
```
