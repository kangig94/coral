# Built-in Tool Names Must Be Reserved In Provider Registry
## Rule
Whenever a new built-in MCP tool is added at the server router level, add that name to `RESERVED_TOOL_NAMES` in the provider registry so providers cannot register a colliding name.
## Why
If a provider is allowed to register the same name as a built-in tool (for example `abort`), `handleToolCall` can route requests to the provider instead of the built-in handler. This creates silent API drift and makes behavior depend on registration order.
## Pattern
Right:
```ts
const RESERVED_TOOL_NAMES = new Set(['wait', 'workflow', 'abort']);
```
Wrong:
```ts
const RESERVED_TOOL_NAMES = new Set(['wait', 'workflow']);
// 'abort' built-in exists but a provider can still register 'abort'
```
