# MCP Tool Schema Stability
Promoted: 2026-03-12 | Updated: 2026-03-14

## Rule
`getToolDescriptors()` in `execution/server.ts` defines the MCP tool schemas visible to LLMs. The public schema surface is: `op`, `prompt`, `session`, `work_dir`, `model`. Internal-only fields (`bypass_permissions`, `system_prompt`) live in `internalProviderFieldsShape` — they are accepted server-side via `.extend()` but never advertised in tool descriptors. Bypass is determined by op (`bypass_exec` = true, `exec` = false, all others = true), not by a field.

## Why
LLMs and users see these schemas as the tool's API contract. Internal fields pollute the interface. `bypass_permissions` is redundant with `bypass_exec` op. `system_prompt` is injected by `coral:*` dispatch — not a user-controllable parameter.

## Pattern
Right — public schema is minimal, internal fields accepted via `.extend()` in routeToolCall():
```typescript
// sharedProviderFieldsShape — public (in providerOpSchema / MCP inputSchema)
{ work_dir, model }

// internalProviderFieldsShape — backend-only (never in MCP inputSchema)
{ bypass_permissions, system_prompt }

// routeToolCall() — extends at parse time for internal callers
const parsed = sharedExecSchema.extend(internalProviderFieldsShape).safeParse(request.args);
const bypassPermissions = op === 'bypass_exec'; // op determines bypass, not field
```

Wrong — exposing internal fields in tool descriptors:
```typescript
properties: { op, prompt, session, work_dir, model, bypass_permissions, system_prompt }
```
