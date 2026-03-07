# MCP Tool Schema Stability

## Rule
`getToolDescriptors()` in `execution/server.ts` defines the MCP tool schemas visible to LLMs via ToolSearch. Internal routing fields (`model`, `effort`, `bypass_permissions`, `system_prompt`) must NEVER appear in these descriptors — they are accepted server-side in `routeToolCall()` but not advertised. The tool schema surface must remain stable: `op`, `prompt`, `session`, `work_dir` only.

## Why
LLMs and users see these schemas as the tool's API contract. Adding internal fields pollutes the interface and creates confusion. Framework-internal fields (used by coral dispatch, workflows, etc.) should flow through routing silently without being exposed.

## Pattern
Right — accept extra fields in routeToolCall() via Zod parsing, keep getToolDescriptors() unchanged:
```typescript
// getToolDescriptors() — stable, minimal
properties: { op, prompt, session, work_dir }

// routeToolCall() — accepts more via schema parsing
const parsed = sharedExecSchema.parse(request.args); // includes model, effort, etc.
```

Wrong — adding internal fields to tool descriptors:
```typescript
// DON'T do this
properties: { op, prompt, session, work_dir, model, effort, bypass_permissions, system_prompt }
```
